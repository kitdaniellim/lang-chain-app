"""Decide which source column feeds which `Invoice` field.

Two implementations of the same contract: `heuristic_mapping` matches header names offline, and
`llm_mapping` is the LangChain call - `build_chat_model(...).with_structured_output(ColumnMapping)`
behind a `ChatPromptTemplate`. `choose_mapping` prefers Claude and falls back without ever failing
the upload. Nothing here touches the cell values beyond sniffing; applying the mapping is
deterministic and lives in `app.importing`.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter
from typing import Any, Literal

from langchain_core.language_models import BaseChatModel
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import Runnable

from app.config import Settings
from app.extraction import LLMNotConfigured, build_chat_model
from app.schemas import ColumnMapping, RowGranularity

logger = logging.getLogger(__name__)


class MappingError(RuntimeError):
    """The provider or the structured-output parse failed while mapping columns."""


# Every `ColumnMapping` field that names a source column (i.e. not a hint or a note).
COLUMN_FIELDS: tuple[str, ...] = (
    "invoice_number",
    "vendor_name",
    "vendor_email",
    "invoice_date",
    "due_date",
    "currency",
    "status",
    "subtotal",
    "tax",
    "total",
    "po_number",
    "line_item_description",
    "line_item_quantity",
    "line_item_unit_price",
    "line_item_amount",
    "line_items_json",
)

LINE_ITEM_FIELDS: tuple[str, ...] = (
    "line_item_description",
    "line_item_quantity",
    "line_item_unit_price",
    "line_item_amount",
)

MONEY_FIELDS: tuple[str, ...] = (
    "total",
    "subtotal",
    "tax",
    "line_item_amount",
    "line_item_unit_price",
)

# Header wording seen in the wild, per target. Order is the tie-break order.
SYNONYMS: dict[str, tuple[str, ...]] = {
    "invoice_number": (
        "invoice number", "invoice no", "inv no", "invoice #", "invoice id",
        "number", "reference", "ref", "document no",
    ),
    "vendor_name": (
        "vendor", "supplier", "seller", "company", "from", "payee", "merchant", "biller", "vendor name",
    ),
    "vendor_email": ("email", "vendor email", "supplier email", "contact email"),
    "invoice_date": ("invoice date", "date", "issued", "issue date", "bill date", "billing date"),
    "due_date": ("due", "due date", "payment due", "pay by", "due on"),
    "currency": ("currency", "ccy", "cur", "curr"),
    "status": ("status", "state", "payment status", "paid"),
    "subtotal": ("subtotal", "sub total", "net", "net amount", "amount before tax"),
    "tax": ("tax", "vat", "gst", "sales tax", "tax amount"),
    "total": ("total", "grand total", "amount due", "amount", "balance due", "total due", "invoice total"),
    "po_number": ("po", "po number", "purchase order", "po #"),
    "line_item_description": ("description", "item", "product", "service"),
    "line_item_quantity": ("qty", "quantity", "units"),
    "line_item_unit_price": ("unit price", "price", "rate", "unit cost"),
    "line_item_amount": ("line total", "line amount", "amount", "extended"),
    "line_items_json": ("line items", "lines", "items", "line item json", "details"),
}

# `Amount` alone is either the invoice total or the line amount; resolved after the greedy pass.
AMBIGUOUS_AMOUNT = "amount"

SYMBOL_TO_CODE: dict[str, str] = {"$": "USD", "€": "EUR", "£": "GBP", "₱": "PHP", "¥": "JPY"}

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{1,2}-\d{1,2}(?:[T ]|$)")
_NUMERIC_DATE_RE = re.compile(r"^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})$")
_CURRENCY_CODE_RE = re.compile(r"^[A-Za-z]{3}$")
# How many rows the sniffers look at; enough to decide, small enough to stay fast.
SNIFF_ROWS = 200


def normalise(text: str) -> str:
    """Header key: lower-case with every non-alphanumeric character removed."""
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def tokenise(text: str) -> list[str]:
    """Header words, so `Total Incl. Tax` matches the synonym `total` at a word boundary."""
    return re.findall(r"[a-z0-9]+", (text or "").lower())


def _match_score(header_tokens: list[str], header_norm: str, syn_tokens: list[str], syn_norm: str) -> int:
    """0 = no match; higher = a better one. Longer synonyms beat shorter ones at the same shape."""
    if header_norm == syn_norm:
        return 100 + len(syn_norm)
    width = len(syn_tokens)
    if width and len(header_tokens) > width:
        if header_tokens[:width] == syn_tokens:
            return 70 + len(syn_norm)
        if header_tokens[-width:] == syn_tokens:
            return 60 + len(syn_norm)
        for start in range(1, len(header_tokens) - width):
            if header_tokens[start : start + width] == syn_tokens:
                return 50 + len(syn_norm)
    return 0


def _looks_like_json_list(values: list[str]) -> bool:
    """A cell holding `[{...}]` is a packed line-item list, whatever the column is called."""
    for value in values:
        text = value.strip()
        if text.startswith("["):
            try:
                if isinstance(json.loads(text), list):
                    return True
            except json.JSONDecodeError:
                continue
    return False


def _column_values(rows: list[dict[str, str]], header: str) -> list[str]:
    return [row.get(header, "") for row in rows[:SNIFF_ROWS] if row.get(header, "").strip()]


def _score_candidates(headers: list[str], rows: list[dict[str, str]]) -> list[tuple[int, int, int, str, str]]:
    """(score, target order, header order, target, header) for every plausible pairing."""
    candidates: list[tuple[int, int, int, str, str]] = []
    for target_index, (target, synonyms) in enumerate(SYNONYMS.items()):
        for header_index, header in enumerate(headers):
            header_tokens, header_norm = tokenise(header), normalise(header)
            best = 0
            for synonym in synonyms:
                if normalise(synonym) == AMBIGUOUS_AMOUNT and target in ("total", "line_item_amount"):
                    continue  # decided later, once we know whether both targets want it
                best = max(best, _match_score(header_tokens, header_norm, tokenise(synonym), normalise(synonym)))
            if target == "line_items_json" and _looks_like_json_list(_column_values(rows, header)):
                best = max(best, 95)
            if best:
                candidates.append((best, target_index, header_index, target, header))
    # Best score first; ties fall to the earlier target, then the earlier column.
    candidates.sort(key=lambda item: (-item[0], item[1], item[2]))
    return candidates


def _assign(headers: list[str], rows: list[dict[str, str]]) -> tuple[dict[str, str], list[str]]:
    """Greedy one-to-one assignment: each target and each column is used at most once."""
    assigned: dict[str, str] = {}
    used: set[str] = set()
    for _, _, _, target, header in _score_candidates(headers, rows):
        if target in assigned or header in used:
            continue
        assigned[target] = header
        used.add(header)

    notes: list[str] = []
    bare_amount = next((h for h in headers if normalise(h) == AMBIGUOUS_AMOUNT and h not in used), None)
    if bare_amount is not None:
        if "total" not in assigned:
            assigned["total"] = bare_amount
            notes.append(f"No invoice-level total column, so {bare_amount!r} is read as the invoice total.")
        elif "line_item_amount" not in assigned:
            assigned["line_item_amount"] = bare_amount
            notes.append(
                f"{assigned['total']!r} is the invoice total, so {bare_amount!r} is read as the line amount."
            )
    return assigned, notes


def _sniff_currency(
    rows: list[dict[str, str]], assigned: dict[str, str], headers: list[str]
) -> tuple[str, str | None]:
    """Currency column -> most common code; else a symbol in the money cells; else USD."""
    column = assigned.get("currency")
    if column:
        codes = [
            value.strip().upper()
            for value in _column_values(rows, column)
            if _CURRENCY_CODE_RE.match(value.strip())
        ]
        if codes:
            code = Counter(codes).most_common(1)[0][0]
            return code, f"Currency defaults to {code}, the most common value in {column!r}."

    money_headers = [assigned[field] for field in MONEY_FIELDS if field in assigned] or headers
    for header in money_headers:
        for value in _column_values(rows, header):
            for symbol, code in SYMBOL_TO_CODE.items():
                if symbol in value:
                    return code, f"Currency inferred as {code} from the {symbol} symbol in {header!r}."
    return "USD", "No currency column or symbol found; assuming USD."


def _sniff_date_format(rows: list[dict[str, str]], assigned: dict[str, str]) -> tuple[str, str | None]:
    """ISO when the cells are `YYYY-MM-DD`; otherwise a day part over 12 decides DMY vs MDY."""
    columns = [assigned[field] for field in ("invoice_date", "due_date") if field in assigned]
    values = [value for column in columns for value in _column_values(rows, column)]
    if not values:
        return "unknown", None

    if all(_ISO_DATE_RE.match(value.strip()) for value in values):
        return "ISO", None

    triples = [m.groups() for m in (_NUMERIC_DATE_RE.match(v.strip()) for v in values) if m]
    if not triples:
        return "unknown", "Date order could not be determined from the sample; dates are parsed leniently."
    if all(len(first) == 4 for first, _, _ in triples):
        return "YMD", "Dates read as year-month-day."
    for first, _second, _ in triples:
        if int(first) > 12:
            return "DMY", f"Dates read as day-month-year (a day part of {first} rules out month-first)."
    for _first, second, _ in triples:
        if int(second) > 12:
            return "MDY", f"Dates read as month-day-year (a part of {second} rules out day-first)."
    return "unknown", "Dates like 03/08/2026 are ambiguous; day-month-year was not confirmed."


def _granularity(rows: list[dict[str, str]], assigned: dict[str, str]) -> tuple[RowGranularity, str | None]:
    """One row per line only when line columns exist *and* an invoice number repeats."""
    line_columns = [field for field in LINE_ITEM_FIELDS if field in assigned]
    number_column = assigned.get("invoice_number")
    if len(line_columns) < 2 or not number_column:
        return RowGranularity.INVOICE, None

    values = [normalise(value) for value in _column_values(rows, number_column)]
    if len(values) != len(set(values)):
        return (
            RowGranularity.LINE_ITEM,
            f"{number_column!r} repeats across rows, so rows are grouped into one invoice per number.",
        )
    return RowGranularity.INVOICE, None


def heuristic_mapping(headers: list[str], rows: list[dict[str, str]]) -> ColumnMapping:
    """Name-based mapping with value sniffing. Deterministic, offline, always returns something."""
    assigned, notes = _assign(headers, rows)
    granularity, granularity_note = _granularity(rows, assigned)
    currency_default, currency_note = _sniff_currency(rows, assigned, headers)
    date_format, date_note = _sniff_date_format(rows, assigned)

    for note in (granularity_note, currency_note, date_note):
        if note:
            notes.append(note)
    for required in ("invoice_number", "vendor_name", "invoice_date", "total"):
        if required not in assigned:
            notes.append(f"No column matched {required.replace('_', ' ')}; it will be derived or left blank.")

    return ColumnMapping(
        granularity=granularity,
        currency_default=currency_default,
        date_format=date_format,
        notes=notes,
        **{field: assigned.get(field) for field in COLUMN_FIELDS},
    )


# --------------------------------------------------------------------------- the LangChain call

MAPPING_SYSTEM_PROMPT = (
    "You map spreadsheet columns onto an invoice schema. Use the exact header strings. "
    "Return null for fields the file does not have. Decide granularity from whether rows repeat "
    "an invoice number with different line descriptions. Infer currency_default from symbols, "
    "locale or vendor country when there is no currency column. date_format from the sample dates."
)

SAMPLE_ROWS = 5


def build_mapper(settings: Settings, model: BaseChatModel | None = None) -> Runnable:
    """Prompt -> Claude -> parsed `ColumnMapping`. Pass `model` to bypass the network in tests."""
    chat = model if model is not None else build_chat_model(settings)
    prompt = ChatPromptTemplate.from_messages([("system", MAPPING_SYSTEM_PROMPT), ("human", "{payload}")])
    return prompt | chat.with_structured_output(ColumnMapping)


def _payload(headers: list[str], rows: list[dict[str, str]]) -> str:
    """Headers plus a few sample rows; passed as one variable so JSON braces stay literal."""
    sample = rows[:SAMPLE_ROWS]
    return (
        "Columns (use these exact strings):\n"
        f"{json.dumps(headers, ensure_ascii=False)}\n\n"
        f"First {len(sample)} of {len(rows)} data rows:\n"
        f"{json.dumps(sample, ensure_ascii=False, indent=2)}"
    )


def _sanitise(mapping: ColumnMapping, headers: list[str]) -> ColumnMapping:
    """Keep the model honest: every column it names must really exist in the file."""
    lookup: dict[str, str] = {}
    for header in headers:
        lookup.setdefault(normalise(header), header)

    updates: dict[str, Any] = {}
    notes = list(mapping.notes)
    for field in COLUMN_FIELDS:
        value = getattr(mapping, field)
        if value is None or value in headers:
            continue
        match = lookup.get(normalise(value))
        if match is not None:
            updates[field] = match
            notes.append(f"Matched {field} to the column {match!r} (the model wrote {value!r}).")
        else:
            updates[field] = None
            notes.append(f"Dropped {field}: {value!r} is not a column in this file.")

    code = (mapping.currency_default or "").strip().upper()
    if code and not _CURRENCY_CODE_RE.match(code):
        notes.append(f"Ignored currency_default {mapping.currency_default!r}: not a 3-letter ISO code.")
        code = ""
    updates["currency_default"] = code or None
    return mapping.model_copy(update={**updates, "notes": notes})


def llm_mapping(
    headers: list[str],
    rows: list[dict[str, str]],
    settings: Settings,
    model: BaseChatModel | None = None,
) -> ColumnMapping:
    """Ask Claude for the mapping. Raises `LLMNotConfigured` (no key) or `MappingError`."""
    mapper = build_mapper(settings, model)
    try:
        raw = mapper.invoke({"payload": _payload(headers, rows)})
    except Exception as exc:
        raise MappingError(f"Claude column mapping failed: {exc}") from exc

    if not isinstance(raw, ColumnMapping):
        raise MappingError(f"Structured output returned {type(raw).__name__}, expected ColumnMapping")
    return _sanitise(raw, headers)


def choose_mapping(
    headers: list[str],
    rows: list[dict[str, str]],
    settings: Settings,
    model: BaseChatModel | None = None,
) -> tuple[ColumnMapping, Literal["claude", "heuristic"]]:
    """Claude when it is available, heuristics otherwise. A mapper failure never fails the upload."""
    if model is None and not settings.llm_configured:
        return heuristic_mapping(headers, rows), "heuristic"
    try:
        return llm_mapping(headers, rows, settings, model), "claude"
    except (MappingError, LLMNotConfigured) as exc:
        logger.warning("Column mapping fell back to heuristics - %s", exc)
        fallback = heuristic_mapping(headers, rows)
        return fallback.model_copy(update={"notes": [str(exc), *fallback.notes]}), "heuristic"
