"""Apply a `ColumnMapping` to parsed rows and build the import preview.

Claude decides *which column means what* (`app.column_mapping`); everything below is deterministic:
the same file and the same mapping always produce the same invoices. Values that had to be derived
are recorded in `import_notes`, values that look wrong go through `validate_invoice` as usual.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any

from dateutil.parser import parse as parse_datetime
from langchain_core.language_models import BaseChatModel

from app.column_mapping import (
    COLUMN_FIELDS,
    LINE_ITEM_FIELDS,
    SYMBOL_TO_CODE,
    choose_mapping,
    normalise,
)
from app.config import Settings
from app.file_parsing import ParsedTable, parse_tabular
from app.schemas import (
    ColumnMapping,
    ImportedDraft,
    ImportPreview,
    Invoice,
    InvoiceStatus,
    LineItem,
    RowGranularity,
)
from app.validation import derive_status, round_money, today, validate_invoice

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{1,2}-\d{1,2}")
_CURRENCY_CODE_RE = re.compile(r"^[A-Za-z]{3}$")
_PARENS_RE = re.compile(r"^\((.*)\)$")
_TRAILING_COMMA_DECIMALS_RE = re.compile(r",\d{2}$")
# "Design work x 3 @ 250.00" - the shape spreadsheet exports use when they pack lines into one cell.
_TEXT_LINE_RE = re.compile(
    r"^(?P<description>.+?)\s*[x*×]\s*(?P<quantity>[\d.,]+)\s*@\s*(?P<price>.+)$", re.IGNORECASE
)

PAID_WORDS = ("paid", "settled", "closed", "complete")
OVERDUE_WORDS = ("overdue", "late", "past due")
UNPAID_WORDS = ("unpaid", "not paid", "non-paid")

# Flexible key names inside a packed line-items cell.
LINE_KEYS: dict[str, tuple[str, ...]] = {
    "description": ("description", "desc", "name", "item", "title", "details", "product", "service"),
    "quantity": ("quantity", "qty", "units", "count"),
    "unit_price": ("unitprice", "price", "rate", "unitcost", "cost"),
    "amount": ("amount", "linetotal", "lineamount", "total", "extended", "value", "subtotal"),
}

SYNTHESIZED_DESCRIPTION = "Imported invoice"


# --------------------------------------------------------------------------- cell parsers


def parse_money(text: str) -> float | None:
    """`$1,234.50`, `(200.00)` and `1.234,50` all become floats; anything unreadable is None."""
    raw = (text or "").replace("\xa0", " ").strip()
    if not raw:
        return None

    negative = False
    parens = _PARENS_RE.match(raw)
    if parens:
        negative, raw = True, parens.group(1)

    # Drop currency codes and symbols, keep only digits and separators.
    raw = re.sub(r"(?i)\b[a-z]{3}\b", "", raw)
    cleaned = re.sub(r"[^0-9,.\-]", "", raw)
    if cleaned.startswith("-"):
        negative = True
    cleaned = cleaned.replace("-", "")
    if not cleaned:
        return None

    # A comma with exactly two digits after it is a European decimal comma, not a thousands mark.
    if _TRAILING_COMMA_DECIMALS_RE.search(cleaned) and cleaned.rfind(",") > cleaned.rfind("."):
        cleaned = cleaned.replace(".", "").replace(",", ".")
    else:
        cleaned = cleaned.replace(",", "")

    try:
        value = float(cleaned)
    except ValueError:
        return None
    return -value if negative else value


def parse_date(text: str, date_format: str = "unknown") -> date | None:
    """ISO first, then `dateutil` with the day/year order hinted by the mapping. None when unreadable."""
    raw = (text or "").strip()
    if not raw:
        return None

    if _ISO_DATE_RE.match(raw):
        try:
            return date.fromisoformat(raw[:10])
        except ValueError:
            pass

    digits = re.sub(r"\D", "", raw)
    if digits == raw:  # a bare number: only YYYYMMDD is a date, never a time
        if len(digits) == 8:
            try:
                return datetime.strptime(digits, "%Y%m%d").date()
            except ValueError:
                return None
        return None
    if len(raw) < 6:
        return None

    try:
        return parse_datetime(
            raw, dayfirst=date_format == "DMY", yearfirst=date_format in ("YMD", "ISO")
        ).date()
    except (ValueError, OverflowError, TypeError):
        return None


def parse_status(text: str, status_values: dict[str, InvoiceStatus] | None = None) -> InvoiceStatus:
    """Vocabulary from other systems (`Settled`, `Past due`, `bezahlt`) onto our three statuses.

    `status_values` is the mapper's per-file translation and wins over the built-in English synonyms.
    """
    value = (text or "").strip().lower()
    for raw, status in (status_values or {}).items():
        if raw.strip().lower() == value:
            return InvoiceStatus(status)
    if any(word in value for word in UNPAID_WORDS):
        return InvoiceStatus.PENDING
    if any(word in value for word in PAID_WORDS):
        return InvoiceStatus.PAID
    if any(word in value for word in OVERDUE_WORDS):
        return InvoiceStatus.OVERDUE
    return InvoiceStatus.PENDING


def _currency_code(text: str) -> str | None:
    """A 3-letter code or a recognised symbol; None when the cell says neither."""
    raw = (text or "").strip()
    if _CURRENCY_CODE_RE.match(raw):
        return raw.upper()
    for symbol, code in SYMBOL_TO_CODE.items():
        if symbol in raw:
            return code
    return None


def _pick(entry: dict[str, Any], keys: tuple[str, ...]) -> Any:
    """Look a flexible key up in a line-item dict, comparing normalised names."""
    lowered = {normalise(str(key)): value for key, value in entry.items()}
    for key in keys:
        if key in lowered:
            return lowered[key]
    return None


def _line_from_dict(entry: dict[str, Any]) -> LineItem:
    """One packed line-item object -> `LineItem`, filling whichever of the four fields are absent."""
    description = str(_pick(entry, LINE_KEYS["description"]) or SYNTHESIZED_DESCRIPTION).strip()
    quantity = parse_money(str(_pick(entry, LINE_KEYS["quantity"]) or ""))
    unit_price = parse_money(str(_pick(entry, LINE_KEYS["unit_price"]) or ""))
    amount = parse_money(str(_pick(entry, LINE_KEYS["amount"]) or ""))
    return _build_line(description, quantity, unit_price, amount)


def _build_line(
    description: str, quantity: float | None, unit_price: float | None, amount: float | None
) -> LineItem:
    """Fill the gaps between quantity, unit price and amount without ever inventing all three."""
    qty = quantity if quantity is not None else 1.0
    if amount is None:
        amount = round(qty * unit_price, 2) if unit_price is not None else 0.0
    if unit_price is None:
        unit_price = round(amount / qty, 2) if qty else 0.0
    return LineItem(
        description=description or SYNTHESIZED_DESCRIPTION,
        quantity=qty,
        unit_price=unit_price,
        amount=amount,
    )


def parse_line_items_cell(text: str) -> list[LineItem]:
    """A packed cell: a JSON array of objects, or `description x qty @ price` lines."""
    raw = (text or "").strip()
    if not raw:
        return []

    if raw.startswith("["):
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, list):
            return [_line_from_dict(entry) for entry in payload if isinstance(entry, dict)]

    items: list[LineItem] = []
    for chunk in re.split(r"[\n;|]+", raw):
        match = _TEXT_LINE_RE.match(chunk.strip())
        if match:
            items.append(
                _build_line(
                    match.group("description").strip(),
                    parse_money(match.group("quantity")),
                    parse_money(match.group("price")),
                    None,
                )
            )
    return items


# --------------------------------------------------------------------------- row -> invoice


def _cell(row: dict[str, str], column: str | None) -> str:
    return (row.get(column, "") if column else "").strip()


def _first(rows: list[dict[str, str]], column: str | None) -> str:
    """First non-empty value in the group; line-item files repeat invoice-level columns."""
    for row in rows:
        value = _cell(row, column)
        if value:
            return value
    return ""


def _stem(filename: str) -> str:
    """Filename without the extension, safe for an invoice number."""
    base = re.sub(r"\.[^.]*$", "", filename or "import")
    return re.sub(r"[^A-Za-z0-9]+", "-", base).strip("-")[:40] or "file"


def _group_rows(
    table: ParsedTable, mapping: ColumnMapping
) -> tuple[list[tuple[str, list[int], list[dict[str, str]]]], int]:
    """Line-item files group by invoice number (first-seen order); otherwise one group per row."""
    numbered = list(enumerate(table.rows, start=2))  # header is row 1
    if mapping.granularity is not RowGranularity.LINE_ITEM or not mapping.invoice_number:
        return [(_cell(row, mapping.invoice_number), [number], [row]) for number, row in numbered], 0

    order: list[str] = []
    groups: dict[str, tuple[list[int], list[dict[str, str]]]] = {}
    skipped = 0
    for number, row in numbered:
        raw = _cell(row, mapping.invoice_number)
        key = normalise(raw)
        if not key:
            skipped += 1
            continue
        if key not in groups:
            order.append(key)
            groups[key] = ([], [])
        groups[key][0].append(number)
        groups[key][1].append(row)
    return [(_first(groups[key][1], mapping.invoice_number), *groups[key]) for key in order], skipped


def _line_items(
    rows: list[dict[str, str]], mapping: ColumnMapping, subtotal: float | None
) -> tuple[list[LineItem], str | None]:
    """Line columns, else a packed cell, else one synthesized line - only if a description exists."""
    mapped = [field for field in LINE_ITEM_FIELDS if getattr(mapping, field)]
    if len(mapped) >= 2:
        items = [
            _build_line(
                _cell(row, mapping.line_item_description),
                parse_money(_cell(row, mapping.line_item_quantity)),
                parse_money(_cell(row, mapping.line_item_unit_price)),
                parse_money(_cell(row, mapping.line_item_amount)),
            )
            for row in rows
            if any(_cell(row, getattr(mapping, field)) for field in mapped)
        ]
        if items:
            return items, None

    if mapping.line_items_json:
        items = parse_line_items_cell(_first(rows, mapping.line_items_json))
        if items:
            return items, f"Line items were unpacked from the {mapping.line_items_json!r} column."

    if mapping.line_item_description:
        description = _first(rows, mapping.line_item_description) or SYNTHESIZED_DESCRIPTION
        amount = round(subtotal, 2) if subtotal is not None else 0.0
        return [_build_line(description, 1.0, amount, amount)], (
            "The file has a description but no line detail; one line was synthesized from the subtotal."
        )
    return [], None


def _convert(
    number_text: str,
    source_rows: list[int],
    rows: list[dict[str, str]],
    mapping: ColumnMapping,
    stem: str,
) -> ImportedDraft:
    """One group of source rows -> one validated `ImportedDraft`."""
    import_notes: list[str] = []
    review_extra: list[str] = []

    subtotal = parse_money(_first(rows, mapping.subtotal))
    tax = parse_money(_first(rows, mapping.tax))
    total = parse_money(_first(rows, mapping.total))

    items, line_note = _line_items(rows, mapping, subtotal)
    if line_note:
        import_notes.append(line_note)
    line_sum = round(sum(item.amount for item in items), 2)

    if tax is None:
        tax = 0.0
        if mapping.tax:
            import_notes.append("The tax column was empty; tax recorded as 0.")
        else:
            import_notes.append("No tax column in the file; tax recorded as 0.")
    if subtotal is None:
        if items:
            subtotal = line_sum
            import_notes.append(f"Subtotal was not in the file; summed {len(items)} line amount(s) to {line_sum:.2f}.")
        elif total is not None:
            subtotal = round(total - tax, 2)
            import_notes.append("Subtotal was not in the file; derived it as total minus tax.")
        else:
            subtotal = 0.0
            import_notes.append("Neither a subtotal nor a total was found; subtotal recorded as 0.")
    if total is None:
        total = round(subtotal + tax, 2)
        import_notes.append(f"Total was not in the file; used subtotal + tax = {total:.2f}.")

    invoice_number = number_text.strip()
    if not invoice_number:
        invoice_number = f"IMPORT-{stem}-{source_rows[0]}"
        import_notes.append(f"No invoice number in the file; generated {invoice_number}.")

    invoice_date = parse_date(_first(rows, mapping.invoice_date), mapping.date_format)
    if invoice_date is None:
        invoice_date = today()
        review_extra.append("No readable invoice date in the source row; today's date was used.")
    due_date = parse_date(_first(rows, mapping.due_date), mapping.date_format)
    if mapping.due_date and due_date is None and _first(rows, mapping.due_date):
        review_extra.append(f"Due date {_first(rows, mapping.due_date)!r} could not be read.")

    currency = _currency_code(_first(rows, mapping.currency)) or (mapping.currency_default or "").strip().upper()
    if not _CURRENCY_CODE_RE.match(currency or ""):
        currency = "USD"
        import_notes.append("No usable currency for this row; assumed USD.")

    invoice = Invoice(
        invoice_number=invoice_number,
        vendor_name=_first(rows, mapping.vendor_name),
        vendor_email=_first(rows, mapping.vendor_email) or None,
        invoice_date=invoice_date,
        due_date=due_date,
        currency=currency.upper(),
        line_items=items,
        subtotal=subtotal,
        tax=tax,
        total=total,
        po_number=_first(rows, mapping.po_number) or None,
        status=parse_status(_first(rows, mapping.status), mapping.status_values),
    )
    invoice = derive_status(round_money(invoice))
    has_line_sources = _has_line_sources(mapping)
    if not has_line_sources and not invoice.line_items:
        import_notes.append("No line items in the source file (summary-level export).")
    notes = validate_invoice(invoice, require_line_items=has_line_sources) + review_extra
    return ImportedDraft(
        invoice=invoice,
        needs_review=bool(notes),
        review_notes=notes,
        import_notes=import_notes,
        source_rows=source_rows,
    )


def _has_line_sources(mapping: ColumnMapping) -> bool:
    """True when the file carries any line-item detail at all."""
    return any(
        (
            mapping.line_item_description,
            mapping.line_item_quantity,
            mapping.line_item_unit_price,
            mapping.line_item_amount,
            mapping.line_items_json,
        )
    )


def apply_mapping(table: ParsedTable, mapping: ColumnMapping) -> list[ImportedDraft]:
    """The whole deterministic conversion: group, parse, derive, validate."""
    groups, _ = _group_rows(table, mapping)
    stem = _stem(table.filename)
    return [_convert(number, rows_numbers, rows, mapping, stem) for number, rows_numbers, rows in groups]


def collect_warnings(
    table: ParsedTable, mapping: ColumnMapping, drafts: list[ImportedDraft]
) -> list[str]:
    """Whole-file problems worth showing above the preview table."""
    warnings: list[str] = []
    _, skipped = _group_rows(table, mapping)
    if skipped:
        warnings.append(f"{skipped} row(s) were skipped: the invoice-number column was empty.")

    unreadable = 0
    for row in table.rows:
        for column in (mapping.invoice_date, mapping.due_date):
            value = _cell(row, column)
            if value and parse_date(value, mapping.date_format) is None:
                unreadable += 1
    if unreadable:
        warnings.append(f"{unreadable} date value(s) could not be read and were left blank or defaulted.")

    if not mapping.total and not mapping.subtotal:
        warnings.append("No total or subtotal column was found; amounts were derived from the line items.")
    if not mapping.vendor_name:
        warnings.append("No vendor column was found; vendor names are blank and need review.")

    flagged = sum(1 for draft in drafts if draft.needs_review)
    if flagged:
        warnings.append(f"{flagged} of {len(drafts)} invoice(s) need review before saving.")
    return warnings


def build_preview(
    filename: str, data: bytes, settings: Settings, model: BaseChatModel | None = None
) -> ImportPreview:
    """Parse -> map (Claude or heuristics) -> convert -> preview. Writes nothing to the database."""
    table = parse_tabular(filename, data)
    mapping, mapping_source = choose_mapping(table.headers, table.rows, settings, model)
    drafts = apply_mapping(table, mapping)

    referenced = {getattr(mapping, field) for field in COLUMN_FIELDS if getattr(mapping, field)}
    return ImportPreview(
        filename=filename,
        row_count=len(table.rows),
        headers=table.headers,
        mapping=mapping,
        mapping_source=mapping_source,
        model=settings.anthropic_model if mapping_source == "claude" else None,
        invoices=drafts,
        unmapped_columns=[header for header in table.headers if header not in referenced],
        warnings=collect_warnings(table, mapping, drafts),
    )
