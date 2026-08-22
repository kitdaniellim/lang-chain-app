"""Invoice endpoints: list, extract (paste or upload), and save."""

from __future__ import annotations

import io
import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pypdf import PdfReader
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_session
from app.extraction import ExtractionError, ExtractionResult, LLMNotConfigured, extract_invoice
from app.file_parsing import FileParseError, FileTooLarge, UnsupportedFile
from app.importing import build_preview
from app.models import Invoice as InvoiceRow
from app.schemas import (
    BulkCreateRequest,
    BulkCreateResponse,
    ExtractRequest,
    ExtractResponse,
    ImportPreview,
    ImportedDraft,
    IngestPreview,
    InvoiceDraft,
    InvoiceOut,
    SkippedInvoice,
)
from app.seed import to_row
from app.validation import round_money, validate_invoice

logger = logging.getLogger(__name__)
router = APIRouter(tags=["invoices"])

MAX_UPLOAD_BYTES = 2 * 1024 * 1024
TEXT_SUFFIXES = (".txt", ".md")
MIN_TEXT_CHARS = 20


def _run_extraction(text: str, settings: Settings) -> ExtractResponse:
    """Shared by /invoices/extract and /invoices/upload; maps LLM failures to HTTP codes."""
    try:
        result: ExtractionResult = extract_invoice(text, settings)
    except LLMNotConfigured as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except ExtractionError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    return ExtractResponse(
        invoice=result.invoice,
        needs_review=result.needs_review,
        review_notes=result.notes,
        model=result.model,
    )


def _text_from_upload(file: UploadFile, payload: bytes) -> str:
    """Decode .txt/.md as UTF-8 or pull text out of a PDF; anything else is 415."""
    name = (file.filename or "").lower()
    if name.endswith(TEXT_SUFFIXES):
        try:
            return payload.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"{file.filename} is not valid UTF-8 text: {exc}"
            ) from exc
    if name.endswith(".pdf"):
        try:
            reader = PdfReader(io.BytesIO(payload))
            return "\n".join(page.extract_text() or "" for page in reader.pages)
        except Exception as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"Could not read {file.filename} as a PDF: {exc}"
            ) from exc
    raise HTTPException(
        status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        f"Unsupported file type {file.filename!r}. Upload a .txt, .md or .pdf file.",
    )


@router.get("/invoices", response_model=list[InvoiceOut])
def list_invoices(session: Session = Depends(get_session)) -> list[InvoiceOut]:
    """Every stored invoice, newest first."""
    rows = session.scalars(
        select(InvoiceRow).order_by(InvoiceRow.created_at.desc(), InvoiceRow.id.desc())
    ).all()
    return [InvoiceOut.model_validate(row) for row in rows]


@router.post("/invoices/extract", response_model=ExtractResponse)
def extract(body: ExtractRequest, settings: Settings = Depends(get_settings)) -> ExtractResponse:
    """Run pasted text through Claude structured output. Nothing is written to the database."""
    return _run_extraction(body.text, settings)


@router.post("/invoices/upload", response_model=ExtractResponse)
def upload(
    file: UploadFile = File(...), settings: Settings = Depends(get_settings)
) -> ExtractResponse:
    """Same as /invoices/extract but the text comes from a .txt, .md or .pdf upload."""
    payload = file.file.read()
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"{file.filename} is {len(payload)} bytes; the limit is {MAX_UPLOAD_BYTES} bytes.",
        )
    text = _text_from_upload(file, payload).strip()
    if len(text) < MIN_TEXT_CHARS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Only {len(text)} characters of text were found in {file.filename}.",
        )
    return _run_extraction(text, settings)


@router.post("/invoices/import", response_model=ImportPreview)
def import_preview(
    file: UploadFile = File(...), settings: Settings = Depends(get_settings)
) -> ImportPreview:
    """Map a CSV/JSON/XLSX export onto our schema and preview the invoices. No write happens."""
    payload = file.file.read()
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"{file.filename} is {len(payload)} bytes; the limit is {MAX_UPLOAD_BYTES} bytes.",
        )
    try:
        return build_preview(file.filename or "upload.csv", payload, settings)
    except UnsupportedFile as exc:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(exc)) from exc
    except FileTooLarge as exc:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, str(exc)) from exc
    except FileParseError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


IMPORT_SUFFIXES = (".csv", ".json", ".xlsx")
DOCUMENT_SUFFIXES = TEXT_SUFFIXES + (".pdf",)


@router.post("/invoices/ingest", response_model=IngestPreview)
def ingest(file: UploadFile = File(...), settings: Settings = Depends(get_settings)) -> IngestPreview:
    """Any file in, invoice drafts out: documents go through extraction, exports through column mapping."""
    payload = file.file.read()
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"{file.filename} is {len(payload)} bytes; the limit is {MAX_UPLOAD_BYTES} bytes.",
        )
    name = (file.filename or "").lower()

    if name.endswith(IMPORT_SUFFIXES):
        try:
            preview = build_preview(file.filename or "upload.csv", payload, settings)
        except UnsupportedFile as exc:
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(exc)) from exc
        except FileTooLarge as exc:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, str(exc)) from exc
        except FileParseError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
        return IngestPreview(
            filename=preview.filename,
            kind="imported",
            model=preview.model,
            mapping=preview.mapping,
            mapping_source=preview.mapping_source,
            invoices=preview.invoices,
            unmapped_columns=preview.unmapped_columns,
            warnings=preview.warnings,
            raw_text=None,
        )

    if name.endswith(DOCUMENT_SUFFIXES):
        text = _text_from_upload(file, payload)
        if len(text.strip()) < 20:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"{file.filename} contains no readable invoice text."
            )
        extracted = _run_extraction(text, settings)
        draft = ImportedDraft(
            invoice=extracted.invoice,
            needs_review=extracted.needs_review,
            review_notes=extracted.review_notes,
            import_notes=[],
            source_rows=[],
        )
        return IngestPreview(
            filename=file.filename or "upload.txt",
            kind="extracted",
            model=extracted.model,
            mapping=None,
            mapping_source=None,
            invoices=[draft],
            unmapped_columns=[],
            warnings=[],
            raw_text=text,
        )

    raise HTTPException(
        status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        f"Unsupported file type {file.filename!r}. Upload a .pdf, .txt, .md, .csv, .json or .xlsx file.",
    )


@router.post("/invoices/bulk", response_model=BulkCreateResponse, status_code=status.HTTP_201_CREATED)
def bulk_create(body: BulkCreateRequest, session: Session = Depends(get_session)) -> BulkCreateResponse:
    """Insert confirmed import drafts in one transaction; duplicates are skipped, not fatal."""
    numbers = [draft.invoice_number.strip() for draft in body.invoices]
    existing = set(
        session.scalars(
            select(InvoiceRow.invoice_number).where(InvoiceRow.invoice_number.in_(numbers))
        ).all()
    )

    rows: list[InvoiceRow] = []
    skipped: list[SkippedInvoice] = []
    seen: set[str] = set()
    for draft in body.invoices:
        number = draft.invoice_number.strip()
        if not number:
            skipped.append(SkippedInvoice(invoice_number="", reason="The invoice number is empty."))
            continue
        if number in existing:
            skipped.append(
                SkippedInvoice(invoice_number=number, reason="An invoice with this number already exists.")
            )
            continue
        if number in seen:
            skipped.append(
                SkippedInvoice(invoice_number=number, reason="This number appears twice in the batch.")
            )
            continue
        seen.add(number)
        invoice = round_money(draft)
        # Structured exports may be summary-level; an extracted document should really have line items.
        notes = validate_invoice(invoice, require_line_items=body.source == "uploaded")
        rows.append(to_row(invoice, notes, body.source, raw_text=draft.raw_text))

    session.add_all(rows)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, f"Bulk insert failed: {exc.orig}") from exc

    for row in rows:
        session.refresh(row)
    return BulkCreateResponse(created=[InvoiceOut.model_validate(row) for row in rows], skipped=skipped)


@router.post("/invoices", response_model=InvoiceOut, status_code=status.HTTP_201_CREATED)
def create_invoice(draft: InvoiceDraft, session: Session = Depends(get_session)) -> InvoiceOut:
    """Save an extracted (and possibly edited) invoice. Validation is redone server-side."""
    invoice = round_money(draft)
    notes = validate_invoice(invoice)
    row = to_row(invoice, notes, "uploaded", raw_text=draft.raw_text)
    session.add(row)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Invoice number {draft.invoice_number!r} already exists.",
        ) from exc
    session.refresh(row)
    return InvoiceOut.model_validate(row)
