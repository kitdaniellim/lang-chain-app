"""SQLAlchemy ORM model for the `invoices` table (SPEC section 3)."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, DateTime, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB

# JSON on SQLite, jsonb on Postgres — matches migrations/001_invoices.sql.
JsonColumn = JSON().with_variant(JSONB(), "postgresql")
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    return datetime.now(UTC)


class Invoice(Base):
    """One stored invoice. Money is `Numeric(12, 2)` read back as `float` on both dialects."""

    __tablename__ = "invoices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_number: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    vendor_name: Mapped[str] = mapped_column(String(200), nullable=False)
    vendor_email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    invoice_date: Mapped[date] = mapped_column(Date, nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending", index=True)
    line_items: Mapped[list[dict[str, Any]]] = mapped_column(JsonColumn, nullable=False, default=list)
    subtotal: Mapped[float] = mapped_column(Numeric(12, 2, asdecimal=False), nullable=False)
    tax: Mapped[float] = mapped_column(Numeric(12, 2, asdecimal=False), nullable=False, default=0.0)
    total: Mapped[float] = mapped_column(Numeric(12, 2, asdecimal=False), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    po_number: Mapped[str | None] = mapped_column(String(64), nullable=True)
    needs_review: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    review_notes: Mapped[list[str]] = mapped_column(JsonColumn, nullable=False, default=list)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="seed")
    raw_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now()
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Invoice {self.invoice_number} {self.vendor_name} {self.total} {self.currency}>"
