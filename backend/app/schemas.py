"""Pydantic schemas: the extraction schema Claude fills in, plus the API contract."""

from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class InvoiceStatus(str, Enum):
    PAID = "paid"
    PENDING = "pending"
    OVERDUE = "overdue"


class LineItem(BaseModel):
    """One billed line, copied from the document — never recomputed by the model."""

    description: str = Field(description="Line description exactly as written on the invoice")
    quantity: float = Field(description="Quantity billed; 1 if the document shows none")
    unit_price: float = Field(description="Price per unit as printed")
    amount: float = Field(description="Line amount as printed (quantity x unit price)")


class Invoice(BaseModel):
    """The structured-extraction target: `model.with_structured_output(Invoice)`.

    Field descriptions are sent to the model, so they double as extraction instructions.
    """

    invoice_number: str = Field(description="Invoice number or reference exactly as printed")
    vendor_name: str = Field(description="Name of the company that issued the invoice")
    vendor_email: str | None = Field(default=None, description="Vendor contact email if present")
    invoice_date: date = Field(description="Issue date, ISO format YYYY-MM-DD")
    due_date: date | None = Field(default=None, description="Payment due date, ISO format; null if absent")
    currency: str = Field(description="ISO 4217 code such as USD, EUR, GBP; infer from symbols when needed")
    line_items: list[LineItem] = Field(description="All billed lines in document order")
    subtotal: float = Field(description="Subtotal before tax as printed — copy, do not recompute")
    tax: float = Field(description="Total tax amount as printed; 0 if none is shown")
    total: float = Field(description="Grand total / amount due as printed — copy, do not recompute")
    po_number: str | None = Field(default=None, description="Purchase order reference if present")
    status: InvoiceStatus = Field(
        default=InvoiceStatus.PENDING,
        description="paid if the document says it was paid, otherwise pending",
    )


# --------------------------------------------------------------------------- API contract


class InvoiceDraft(Invoice):
    """What the client sends to POST /invoices (the extracted invoice, possibly edited)."""

    raw_text: str | None = None


class InvoiceOut(Invoice):
    model_config = ConfigDict(from_attributes=True)

    id: int
    needs_review: bool
    review_notes: list[str]
    source: Literal["seed", "extracted", "seed-fallback", "uploaded"]
    created_at: datetime


class ExtractRequest(BaseModel):
    text: str = Field(min_length=20, max_length=20_000)


class ExtractResponse(BaseModel):
    invoice: Invoice
    needs_review: bool
    review_notes: list[str]
    model: str


class ChatRequest(BaseModel):
    question: str = Field(min_length=3, max_length=2_000)


class ChatResponse(BaseModel):
    answer: str
    sql_query_used: str


class HealthResponse(BaseModel):
    ok: bool
    database: Literal["postgres", "sqlite"]
    llm_configured: bool
    model: str


class ErrorResponse(BaseModel):
    error: str
