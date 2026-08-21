"""LangChain structured extraction: raw invoice text -> validated `Invoice`.

The one LangChain call that matters here is `ChatAnthropic(...).with_structured_output(Invoice)`:
Claude is handed the Pydantic schema as a tool definition and must answer with fields that parse.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import Runnable

from app.config import Settings
from app.schemas import Invoice
from app.validation import round_money, validate_invoice


class LLMNotConfigured(RuntimeError):
    """No ANTHROPIC_API_KEY: the caller should answer 503."""


class ExtractionError(RuntimeError):
    """The provider or the structured-output parse failed: the caller should answer 502."""


@dataclass(slots=True)
class ExtractionResult:
    invoice: Invoice
    notes: list[str] = field(default_factory=list)
    needs_review: bool = False
    model: str = ""


SYSTEM_PROMPT = (
    "You extract invoice data. Copy the values exactly as printed on the document.\n"
    "Rules:\n"
    "- Never recompute or correct subtotal, tax or total; if the arithmetic on the page is wrong, "
    "report the printed numbers anyway. A separate validator flags mismatches.\n"
    "- Dates are ISO YYYY-MM-DD. If a date is ambiguous, prefer the order used elsewhere in the document.\n"
    "- Infer the ISO 4217 currency code from symbols or wording ($ -> USD unless another country is stated, "
    "EUR for euro amounts, GBP for pounds sterling, PHP for peso amounts).\n"
    "- Set status to paid only if the document states it was paid; otherwise pending.\n"
    "- Use null for a field the document does not contain. Never invent a purchase order or email address.\n"
    "- Keep line descriptions verbatim and in document order."
)


def build_chat_model(settings: Settings) -> BaseChatModel:
    """The shared Claude client. Raises `LLMNotConfigured` rather than failing at request time."""
    if not settings.llm_configured:
        raise LLMNotConfigured("ANTHROPIC_API_KEY is not set")
    return ChatAnthropic(
        model=settings.anthropic_model,
        api_key=settings.anthropic_api_key,
        temperature=0,
        max_tokens=4096,
        max_retries=2,
    )


def build_extractor(settings: Settings, model: BaseChatModel | None = None) -> Runnable:
    """Prompt -> Claude -> parsed `Invoice`. Pass `model` to bypass the network in tests."""
    chat = model if model is not None else build_chat_model(settings)
    prompt = ChatPromptTemplate.from_messages([("system", SYSTEM_PROMPT), ("human", "{text}")])
    return prompt | chat.with_structured_output(Invoice)


def extract_invoice(
    text: str, settings: Settings, model: BaseChatModel | None = None
) -> ExtractionResult:
    """Extract and validate. Never writes to the database."""
    extractor = build_extractor(settings, model)
    try:
        raw = extractor.invoke({"text": text})
    except Exception as exc:  # provider, network or parse failure -> 502 upstream
        raise ExtractionError(f"Claude extraction failed: {exc}") from exc

    if not isinstance(raw, Invoice):
        raise ExtractionError(f"Structured output returned {type(raw).__name__}, expected Invoice")

    invoice = round_money(raw)
    notes = validate_invoice(invoice)
    return ExtractionResult(
        invoice=invoice, notes=notes, needs_review=bool(notes), model=settings.anthropic_model
    )
