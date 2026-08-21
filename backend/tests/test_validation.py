"""The deterministic checks that decide `needs_review`."""

from __future__ import annotations

from datetime import date

import pytest

from app.raw_samples import RAW_SAMPLES
from app.schemas import Invoice, InvoiceStatus, LineItem
from app.validation import round_money, validate_invoice


def make_invoice(**overrides: object) -> Invoice:
    base = dict(
        invoice_number="INV-1",
        vendor_name="Acme Ltd",
        invoice_date=date(2026, 1, 10),
        due_date=date(2026, 2, 9),
        currency="USD",
        line_items=[LineItem(description="Widget", quantity=2, unit_price=50.0, amount=100.0)],
        subtotal=100.0,
        tax=10.0,
        total=110.0,
        status=InvoiceStatus.PENDING,
    )
    base.update(overrides)
    return Invoice(**base)


def test_clean_invoice_has_no_notes() -> None:
    assert validate_invoice(make_invoice()) == []


@pytest.mark.parametrize("sample", RAW_SAMPLES, ids=lambda s: s.name)
def test_every_raw_sample_expectation_is_valid(sample) -> None:
    assert validate_invoice(sample.expected) == []


def test_line_items_must_sum_to_subtotal() -> None:
    notes = validate_invoice(make_invoice(subtotal=90.0, total=100.0))
    assert any("subtotal" in note.lower() for note in notes)


def test_penny_rounding_is_tolerated() -> None:
    assert validate_invoice(make_invoice(subtotal=100.01, total=110.01)) == []


def test_subtotal_plus_tax_must_equal_total() -> None:
    notes = validate_invoice(make_invoice(total=999.0))
    assert any("total reads 999.00" in note for note in notes)


def test_due_date_before_invoice_date_is_flagged() -> None:
    notes = validate_invoice(make_invoice(due_date=date(2026, 1, 1)))
    assert any("precedes invoice date" in note for note in notes)


def test_empty_line_items_is_flagged() -> None:
    notes = validate_invoice(make_invoice(line_items=[], subtotal=0.0, tax=0.0, total=0.0))
    assert any("No line items" in note for note in notes)
    assert any("not a payable amount" in note for note in notes)


def test_currency_must_be_iso_3() -> None:
    notes = validate_invoice(make_invoice(currency="dollars"))
    assert any("ISO 4217" in note for note in notes)


def test_non_positive_quantity_is_flagged() -> None:
    item = LineItem(description="Widget", quantity=0, unit_price=50.0, amount=100.0)
    notes = validate_invoice(make_invoice(line_items=[item]))
    assert any("quantity 0" in note for note in notes)


def test_negative_amount_is_flagged() -> None:
    item = LineItem(description="Credit", quantity=1, unit_price=-100.0, amount=-100.0)
    notes = validate_invoice(make_invoice(line_items=[item], subtotal=-100.0, tax=0.0, total=-100.0))
    assert any("negative amount" in note for note in notes)


def test_missing_required_text_fields_are_flagged() -> None:
    notes = validate_invoice(make_invoice(invoice_number="  ", vendor_name=""))
    assert "Invoice number is missing." in notes
    assert "Vendor name is missing." in notes


def test_round_money_snaps_every_amount_to_two_places() -> None:
    item = LineItem(description="Hours", quantity=3, unit_price=33.333, amount=99.999)
    rounded = round_money(make_invoice(line_items=[item], subtotal=99.999, tax=9.9999, total=110.0))
    assert rounded.line_items[0].unit_price == 33.33
    assert rounded.line_items[0].amount == 100.0
    assert (rounded.subtotal, rounded.tax) == (100.0, 10.0)
