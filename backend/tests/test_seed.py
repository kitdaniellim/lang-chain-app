"""Seeding without an API key: 17 generated rows plus 3 fallback samples."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import app.seed as seed_module
from app.config import Settings
from app.models import Invoice as InvoiceRow
from app.schemas import InvoiceOut
from app.seed import count_invoices, seed
from app.validation import today, validate_invoice


@pytest.fixture
def frozen_today(monkeypatch: pytest.MonkeyPatch) -> date:
    """Freeze "now" so the overdue rows are deterministic."""
    fixed = date(2026, 8, 21)
    monkeypatch.setattr(seed_module, "today", lambda: fixed)
    return fixed


def test_seed_without_a_key_inserts_twenty_rows(session: Session, settings: Settings) -> None:
    report = seed(session, settings, force=True)

    assert (report.inserted, report.faker_rows, report.fallback, report.extracted) == (20, 17, 3, 0)
    assert report.errors == []
    assert count_invoices(session) == 20


def test_every_seeded_row_is_valid_except_the_review_sample(seeded_session: Session) -> None:
    rows = seeded_session.scalars(select(InvoiceRow)).all()

    flagged = [row for row in rows if row.needs_review]
    assert len(flagged) == 1, "exactly one seed invoice is made inconsistent on purpose"
    assert any("total" in note.lower() for note in flagged[0].review_notes)
    for row in rows:
        notes = validate_invoice(InvoiceOut.model_validate(row))
        assert bool(notes) == row.needs_review


def test_seeded_dates_are_never_in_the_future(seeded_session: Session) -> None:
    rows = seeded_session.scalars(select(InvoiceRow)).all()

    for row in rows:
        assert row.invoice_date <= today(), row.invoice_number
        if row.status == "pending":
            assert row.due_date is not None and row.due_date > today(), row.invoice_number
        if row.status == "overdue":
            assert row.due_date is not None and row.due_date < today(), row.invoice_number


def test_all_three_statuses_are_present(seeded_session: Session) -> None:
    counts = dict(
        seeded_session.execute(
            select(InvoiceRow.status, func.count()).group_by(InvoiceRow.status)
        ).all()
    )
    assert set(counts) == {"paid", "pending", "overdue"}
    assert counts["overdue"] >= 4  # 4 Faker rows plus any past-due sample


def test_overdue_rows_are_actually_past_due(
    session: Session, settings: Settings, frozen_today: date
) -> None:
    seed(session, settings, force=True)
    overdue = session.scalars(select(InvoiceRow).where(InvoiceRow.status == "overdue")).all()

    assert overdue
    for row in overdue:
        assert row.due_date < frozen_today
        assert row.invoice_date <= row.due_date


def test_samples_are_stored_as_fallback_rows_with_their_raw_text(seeded_session: Session) -> None:
    rows = seeded_session.scalars(
        select(InvoiceRow).where(InvoiceRow.source == "seed-fallback")
    ).all()

    assert {row.invoice_number for row in rows} == {"NW-2291", "BL-2026-0417", "HPS/45120"}
    assert all(row.raw_text for row in rows)
    assert {row.currency for row in rows} == {"USD", "EUR", "GBP"}


def test_seeding_is_idempotent(seeded_session: Session, settings: Settings) -> None:
    report = seed(seeded_session, settings)

    assert report.skipped is True
    assert report.existing == 20
    assert "skipped" in report.summary()
    assert count_invoices(seeded_session) == 20


def test_force_replaces_instead_of_duplicating(seeded_session: Session, settings: Settings) -> None:
    seed(seeded_session, settings, force=True)
    assert count_invoices(seeded_session) == 20


def test_seeding_is_deterministic(session: Session, settings: Settings, frozen_today: date) -> None:
    seed(session, settings, force=True)
    first = [row.invoice_number for row in session.scalars(select(InvoiceRow)).all()]
    seed(session, settings, force=True)
    second = [row.invoice_number for row in session.scalars(select(InvoiceRow)).all()]

    assert first == second


def test_money_is_stored_as_rounded_floats(seeded_session: Session) -> None:
    row = seeded_session.scalars(
        select(InvoiceRow).where(InvoiceRow.invoice_number == "HPS/45120")
    ).one()

    assert isinstance(row.total, float)
    assert (row.subtotal, row.tax, row.total) == (833.0, 166.6, 999.6)
    assert row.status == "paid"
