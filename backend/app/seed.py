"""Seed the invoices table: Faker rows plus the three raw samples run through the real extractor.

With no API key the samples are inserted from their known values as `source="seed-fallback"`, so the
app is fully usable offline. Run directly: `python -m app.seed [--force] [--count N]`.
"""

from __future__ import annotations

import argparse
import logging
import random
from dataclasses import dataclass, field
from datetime import date, timedelta

from faker import Faker
from langchain_core.language_models import BaseChatModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.extraction import ExtractionError, LLMNotConfigured, extract_invoice
from app.models import Invoice as InvoiceRow
from app.raw_samples import RAW_SAMPLES
from app.schemas import Invoice, InvoiceStatus, LineItem
from app.validation import derive_status, round_money, today, validate_invoice

logger = logging.getLogger(__name__)

VENDORS: tuple[tuple[str, str, str], ...] = (
    ("Northgate Supply Co.", "billing@northgatesupply.example", "NG"),
    ("Bluepeak Software Ltd", "ar@bluepeak.example", "BP"),
    ("Marlowe Facilities Group", "accounts@marlowefm.example", "MF"),
    ("Verity Legal Partners", "invoices@veritylegal.example", "VL"),
    ("Cobalt Freight Services", "billing@cobaltfreight.example", "CF"),
    ("Sunfield Catering", "hello@sunfieldcatering.example", "SC"),
    ("Harbourline Print Works", "accounts@harbourline.example", "HP"),
    ("Aster Cloud Hosting", "billing@astercloud.example", "AC"),
    ("Kestrel Security Systems", "ar@kestrelsecurity.example", "KS"),
    ("Pinegrove Office Interiors", "invoices@pinegrove.example", "PO"),
    ("Torrent Data Labs", "billing@torrentdata.example", "TD"),
    ("Emberly Marketing", "accounts@emberly.example", "EM"),
)

DESCRIPTIONS: tuple[str, ...] = (
    "Monthly service retainer",
    "Onsite engineer callout",
    "Cloud compute usage",
    "Managed backup storage",
    "Design consultancy hours",
    "Courier delivery - express",
    "Replacement parts kit",
    "Annual licence renewal",
    "Training workshop (per seat)",
    "Site survey and report",
    "Printed marketing collateral",
    "Equipment rental - weekly",
)

CURRENCIES: tuple[str, ...] = ("USD", "EUR", "GBP", "PHP")
TAX_RATES: tuple[float, ...] = (0.0, 0.05, 0.08, 0.12, 0.20)
TERMS_DAYS: tuple[int, ...] = (15, 30, 45)


@dataclass(slots=True)
class SeedReport:
    """What a seed run did; printed by the CLI and logged at startup."""

    inserted: int = 0
    faker_rows: int = 0
    extracted: int = 0
    fallback: int = 0
    needs_review: int = 0
    skipped: bool = False
    existing: int = 0
    errors: list[str] = field(default_factory=list)

    def summary(self) -> str:
        if self.skipped:
            return f"seed skipped: {self.existing} invoices already present"
        line = (
            f"inserted {self.inserted} invoices, {self.faker_rows} generated, "
            f"{self.extracted} extracted by Claude, {self.fallback} from known values, "
            f"{self.needs_review} flagged for review"
        )
        if self.errors:
            joined = " | ".join(self.errors)
            return f"{line}; errors: {joined}"
        return line


# Index of the Faker invoice whose printed total is made inconsistent on purpose.
REVIEW_SAMPLE_INDEX = 6


def _statuses(count: int) -> list[str]:
    """Roughly 5 paid, 4 overdue, the rest pending."""
    return (["paid"] * 5 + ["overdue"] * 4 + ["pending"] * max(0, count - 9))[:count]


def _dates_for(status: str, rng: random.Random, now: date) -> tuple[date, date]:
    """Overdue rows must really be past due; pending rows must not be."""
    terms = rng.choice(TERMS_DAYS)
    if status == "overdue":
        due = now - timedelta(days=rng.randint(3, 60))
        return due - timedelta(days=terms), due
    if status == "pending":
        # Issued within the payment terms, so the invoice date is never in the future and the due date is still ahead.
        issued = now - timedelta(days=rng.randint(0, terms - 1))
        return issued, issued + timedelta(days=terms)
    issued = now - timedelta(days=rng.randint(10, 120))
    return issued, issued + timedelta(days=terms)


def _fake_invoice(index: int, status: str, rng: random.Random, now: date) -> Invoice:
    """One internally consistent invoice: line amounts sum to subtotal, subtotal + tax = total."""
    vendor_name, vendor_email, prefix = VENDORS[index % len(VENDORS)]
    invoice_date, due_date = _dates_for(status, rng, now)

    items: list[LineItem] = []
    for description in rng.sample(DESCRIPTIONS, rng.randint(1, 8)):
        quantity = float(rng.randint(1, 20))
        unit_price = round(rng.uniform(25.0, 950.0), 2)
        items.append(
            LineItem(
                description=description,
                quantity=quantity,
                unit_price=unit_price,
                amount=round(quantity * unit_price, 2),
            )
        )

    subtotal = round(sum(item.amount for item in items), 2)
    tax = round(subtotal * rng.choice(TAX_RATES), 2)
    return Invoice(
        invoice_number=f"{prefix}-{invoice_date.year}-{1000 + index}",
        vendor_name=vendor_name,
        vendor_email=vendor_email,
        invoice_date=invoice_date,
        due_date=due_date,
        currency=rng.choice(CURRENCIES),
        line_items=items,
        subtotal=subtotal,
        tax=tax,
        total=round(subtotal + tax, 2),
        po_number=f"PO-{rng.randint(10000, 99999)}" if rng.random() < 0.5 else None,
        status=InvoiceStatus(status),
    )


def to_row(inv: Invoice, notes: list[str], source: str, raw_text: str | None = None) -> InvoiceRow:
    """Pydantic invoice -> ORM row, with the validation result attached."""
    inv = derive_status(inv)
    inv = round_money(inv)
    return InvoiceRow(
        invoice_number=inv.invoice_number,
        vendor_name=inv.vendor_name,
        vendor_email=inv.vendor_email,
        invoice_date=inv.invoice_date,
        due_date=inv.due_date,
        status=inv.status.value,
        line_items=[item.model_dump() for item in inv.line_items],
        subtotal=inv.subtotal,
        tax=inv.tax,
        total=inv.total,
        currency=inv.currency,
        po_number=inv.po_number,
        needs_review=bool(notes),
        review_notes=notes,
        source=source,
        raw_text=raw_text,
    )


def count_invoices(session: Session) -> int:
    return int(session.scalar(select(func.count()).select_from(InvoiceRow)) or 0)


def seed(
    session: Session,
    settings: Settings,
    *,
    count: int = 17,
    seed: int = 42,
    model: BaseChatModel | None = None,
    force: bool = False,
) -> SeedReport:
    """Insert `count` generated invoices plus the three raw samples. Idempotent unless `force`."""
    report = SeedReport()
    existing = count_invoices(session)
    if existing and not force:
        report.skipped = True
        report.existing = existing
        return report
    if existing:
        session.execute(delete(InvoiceRow))
        session.commit()

    rng = random.Random(seed)
    Faker.seed(seed)
    now = today()
    rows: list[InvoiceRow] = []

    for index, status in enumerate(_statuses(count)):
        invoice = _fake_invoice(index, status, rng, now)
        if index == REVIEW_SAMPLE_INDEX:
            # One deliberately inconsistent invoice so the "needs review" path is visible in the demo.
            invoice = invoice.model_copy(update={"total": round(invoice.total + 12.5, 2)})
        rows.append(to_row(invoice, validate_invoice(invoice), "seed"))
    report.faker_rows = len(rows)

    for sample in RAW_SAMPLES:
        invoice, source = sample.expected, "seed-fallback"
        if settings.llm_configured:
            try:
                result = extract_invoice(sample.text, settings, model=model)
                invoice, source = result.invoice, "extracted"
            except (ExtractionError, LLMNotConfigured) as exc:
                # Never let a provider hiccup break startup: fall back to the known values.
                message = f"{sample.name}: {exc}"
                report.errors.append(message)
                logger.warning("Seed extraction failed, using known values - %s", message)
        rows.append(to_row(invoice, validate_invoice(invoice), source, raw_text=sample.text))
        report.extracted += source == "extracted"
        report.fallback += source == "seed-fallback"

    session.add_all(rows)
    session.commit()
    report.inserted = len(rows)
    report.needs_review = sum(1 for row in rows if row.needs_review)
    return report


def main() -> None:
    """CLI entry point: python -m app.seed [--force] [--count N]."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Seed the invoices table.")
    parser.add_argument("--force", action="store_true", help="Delete existing rows and reseed.")
    parser.add_argument("--count", type=int, default=17, help="How many generated invoices.")
    args = parser.parse_args()

    from app.db import SessionLocal, init_db

    settings = get_settings()
    init_db()
    with SessionLocal() as session:
        report = seed(session, settings, count=args.count, force=args.force)
        print(report.summary())
        print(f"database: {settings.effective_database_url}")
        print(f"rows now: {count_invoices(session)}")


if __name__ == "__main__":
    main()
