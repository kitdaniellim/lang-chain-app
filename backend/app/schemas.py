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
    source: Literal["seed", "extracted", "seed-fallback", "uploaded", "imported"]
    created_at: datetime


class InvoicePage(BaseModel):
    items: list[InvoiceOut]
    total: int
    page: int
    page_size: int


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


# --------------------------------------------------------------------------- structured-file import
# A CSV / JSON / XLSX export from another system rarely uses our column names. Claude fills
# `ColumnMapping` (which source column feeds which Invoice field); deterministic code applies it.


class RowGranularity(str, Enum):
    INVOICE = "invoice"  # one row per invoice
    LINE_ITEM = "line_item"  # one row per line item, grouped by the invoice-number column


class ColumnMapping(BaseModel):
    """Source-column name for each Invoice field (null when the file has no such column)."""

    granularity: RowGranularity = Field(description="invoice: one row per invoice; line_item: one row per billed line")
    invoice_number: str | None = Field(default=None, description="Source column holding the invoice number/reference")
    vendor_name: str | None = Field(default=None, description="Source column holding the vendor/supplier name")
    vendor_email: str | None = Field(default=None, description="Source column holding the vendor email")
    invoice_date: str | None = Field(default=None, description="Source column holding the issue date")
    due_date: str | None = Field(default=None, description="Source column holding the due date")
    currency: str | None = Field(default=None, description="Source column holding an ISO currency code")
    currency_default: str | None = Field(
        default=None, description="ISO 4217 code to assume when there is no currency column (infer from symbols, locale or vendor)"
    )
    status: str | None = Field(default=None, description="Source column holding paid/pending/overdue-like values")
    subtotal: str | None = Field(default=None, description="Source column holding the pre-tax subtotal")
    tax: str | None = Field(default=None, description="Source column holding the tax/VAT/GST amount")
    total: str | None = Field(default=None, description="Source column holding the grand total / amount due")
    po_number: str | None = Field(default=None, description="Source column holding a purchase-order reference")
    line_item_description: str | None = Field(default=None, description="Column with the line description (line_item files)")
    line_item_quantity: str | None = Field(default=None, description="Column with the line quantity")
    line_item_unit_price: str | None = Field(default=None, description="Column with the line unit price")
    line_item_amount: str | None = Field(default=None, description="Column with the line amount")
    line_items_json: str | None = Field(default=None, description="Column whose cells contain a JSON/text list of line items")
    date_format: Literal["ISO", "DMY", "MDY", "YMD", "unknown"] = Field(
        default="unknown", description="How day/month/year are ordered in the date columns"
    )
    status_values: dict[str, InvoiceStatus] = Field(
        default_factory=dict,
        description=(
            "Translation of every distinct value seen in the status column (any language or vocabulary, "
            "e.g. 'bezahlt', 'Settled', 'past due') to paid / pending / overdue; empty when there is no status column"
        ),
    )
    notes: list[str] = Field(default_factory=list, description="Assumptions made while mapping (one short sentence each)")


class ImportedDraft(BaseModel):
    invoice: Invoice
    needs_review: bool
    review_notes: list[str]
    # Derivations and assumptions made while converting the rows (informational, not validation failures).
    import_notes: list[str]
    source_rows: list[int]


class ImportPreview(BaseModel):
    filename: str
    row_count: int
    headers: list[str]
    mapping: ColumnMapping
    mapping_source: Literal["claude", "heuristic"]
    model: str | None
    invoices: list[ImportedDraft]
    unmapped_columns: list[str]
    warnings: list[str]


class BulkCreateRequest(BaseModel):
    invoices: list[InvoiceDraft] = Field(min_length=1, max_length=500)
    # "uploaded" = extracted from an unstructured document; "imported" = mapped from a structured export.
    source: Literal["uploaded", "imported"] = "imported"


class SkippedInvoice(BaseModel):
    invoice_number: str
    reason: str


class BulkCreateResponse(BaseModel):
    created: list[InvoiceOut]
    skipped: list[SkippedInvoice]


class IngestPreview(BaseModel):
    """One response for any uploaded file: unstructured documents are extracted, exports are mapped."""

    filename: str
    kind: Literal["extracted", "imported"]
    model: str | None
    mapping: ColumnMapping | None
    mapping_source: Literal["claude", "heuristic"] | None
    invoices: list[ImportedDraft]
    unmapped_columns: list[str]
    warnings: list[str]
    # The document text for `kind == "extracted"`, so the client can store it with the invoice.
    raw_text: str | None
