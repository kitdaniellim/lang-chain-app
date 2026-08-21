"""Deterministic invoice checks. The LLM never decides whether a row needs review."""

from __future__ import annotations

import re
from datetime import date

from app.schemas import InvoiceStatus, Invoice

# Money tolerance: covers 1-cent rounding on printed documents.
TOLERANCE = 0.011
_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def today() -> date:
    """Indirection over `date.today()` so tests can freeze "now"."""
    return date.today()


def validate_invoice(inv: Invoice, *, require_line_items: bool = True) -> list[str]:
    """Return human-readable problems; an empty list means the invoice looks trustworthy.

    `require_line_items=False` is for summary-level imports, where a file simply has no line detail.
    """
    notes: list[str] = []

    if not inv.invoice_number.strip():
        notes.append("Invoice number is missing.")
    if not inv.vendor_name.strip():
        notes.append("Vendor name is missing.")

    if not inv.line_items:
        if require_line_items:
            notes.append("No line items were extracted.")
    else:
        line_sum = round(sum(item.amount for item in inv.line_items), 2)
        if abs(line_sum - inv.subtotal) > TOLERANCE:
            notes.append(f"Line items sum to {line_sum:.2f} but the subtotal reads {inv.subtotal:.2f}.")

    if abs((inv.subtotal + inv.tax) - inv.total) > TOLERANCE:
        notes.append(
            f"Subtotal + tax = {inv.subtotal + inv.tax:.2f} but the total reads {inv.total:.2f}."
        )

    if inv.due_date is not None and inv.due_date < inv.invoice_date:
        notes.append(f"Due date {inv.due_date.isoformat()} precedes invoice date {inv.invoice_date.isoformat()}.")

    if not _CURRENCY_RE.match(inv.currency or ""):
        notes.append(f"Currency {inv.currency!r} is not a 3-letter ISO 4217 code.")

    for index, item in enumerate(inv.line_items, start=1):
        if item.quantity <= 0:
            notes.append(f"Line {index} ({item.description[:40]}) has quantity {item.quantity}.")
        if item.amount < 0 or item.unit_price < 0:
            notes.append(f"Line {index} ({item.description[:40]}) has a negative amount or unit price.")

    if inv.total <= 0:
        notes.append(f"Total is {inv.total:.2f}, which is not a payable amount.")

    return notes


def derive_status(inv: Invoice) -> Invoice:
    """An unpaid invoice whose due date has passed is overdue, whatever the document says."""
    if inv.status != InvoiceStatus.PAID and inv.due_date is not None and inv.due_date < today():
        return inv.model_copy(update={"status": InvoiceStatus.OVERDUE})
    return inv


def round_money(inv: Invoice) -> Invoice:
    """Snap every money field to 2 dp before it crosses a storage or API boundary."""
    items = [
        item.model_copy(update={"unit_price": round(item.unit_price, 2), "amount": round(item.amount, 2)})
        for item in inv.line_items
    ]
    return inv.model_copy(
        update={
            "line_items": items,
            "subtotal": round(inv.subtotal, 2),
            "tax": round(inv.tax, 2),
            "total": round(inv.total, 2),
        }
    )
