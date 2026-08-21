"""Heuristic mapping per fixture, plus the Claude mapper driven by a fake structured-output model."""

from __future__ import annotations

import pytest
from fakes import StructuredValueFake
from fixture_files import build_weird_xlsx, read_fixture

from app.column_mapping import (
    MappingError,
    choose_mapping,
    heuristic_mapping,
    llm_mapping,
)
from app.config import Settings
from app.extraction import LLMNotConfigured
from app.file_parsing import ParsedTable, parse_tabular
from app.schemas import ColumnMapping, RowGranularity


def table_for(name: str) -> ParsedTable:
    data = build_weird_xlsx() if name.endswith(".xlsx") else read_fixture(name)
    return parse_tabular(name, data)


def test_vendor_export_maps_every_summary_column() -> None:
    table = table_for("vendor_export.csv")
    mapping = heuristic_mapping(table.headers, table.rows)

    assert mapping.granularity is RowGranularity.INVOICE
    assert mapping.invoice_number == "Inv No"
    assert mapping.vendor_name == "Supplier"
    assert mapping.invoice_date == "Bill Date"
    assert mapping.due_date == "Pay By"
    assert (mapping.subtotal, mapping.tax, mapping.total) == ("Net", "VAT", "Amount Due")
    assert (mapping.currency, mapping.status, mapping.po_number) == ("Ccy", "State", "PO Ref")
    assert mapping.date_format == "DMY"
    assert mapping.currency_default == "USD"


def test_line_item_export_is_detected_as_line_granularity() -> None:
    table = table_for("line_items_export.csv")
    mapping = heuristic_mapping(table.headers, table.rows)

    assert mapping.granularity is RowGranularity.LINE_ITEM
    assert mapping.invoice_number == "Invoice"
    assert mapping.line_item_description == "Item"
    assert mapping.line_item_quantity == "Qty"
    assert mapping.line_item_unit_price == "Unit Price"
    # "Line Total" is the line amount, not the invoice total.
    assert mapping.line_item_amount == "Line Total"
    assert mapping.total is None
    assert mapping.date_format == "ISO"
    assert any("repeats across rows" in note for note in mapping.notes)


def test_erp_json_maps_dotted_keys_and_the_packed_line_column() -> None:
    table = table_for("erp_export.json")
    mapping = heuristic_mapping(table.headers, table.rows)

    assert mapping.granularity is RowGranularity.INVOICE
    assert mapping.invoice_number == "document_no"
    assert mapping.vendor_name == "vendor.name"
    assert mapping.vendor_email == "vendor.email"
    assert (mapping.invoice_date, mapping.due_date) == ("issued_on", "due_on")
    assert (mapping.subtotal, mapping.tax, mapping.total) == ("net_amount", "tax_amount", "grand_total")
    assert mapping.line_items_json == "lines"
    assert mapping.currency_default == "EUR"


def test_weird_xlsx_matches_on_word_boundaries() -> None:
    table = table_for("weird.xlsx")
    mapping = heuristic_mapping(table.headers, table.rows)

    assert mapping.vendor_name == "Payee"
    assert mapping.invoice_number == "Document No"
    assert mapping.invoice_date == "Issued"
    # "Total Incl. Tax" is a total, not a tax column.
    assert (mapping.total, mapping.tax) == ("Total Incl. Tax", None)
    assert mapping.currency_default == "USD"
    assert any("assuming USD" in note for note in mapping.notes)


def test_bare_amount_is_the_total_when_nothing_else_is() -> None:
    headers = ["Invoice", "Vendor", "Date", "Amount"]
    rows = [{"Invoice": "A-1", "Vendor": "Acme", "Date": "2026-01-05", "Amount": "10.00"}]
    mapping = heuristic_mapping(headers, rows)

    assert mapping.total == "Amount"
    assert mapping.line_item_amount is None
    assert any("read as the invoice total" in note for note in mapping.notes)


def test_bare_amount_is_the_line_amount_when_a_total_exists() -> None:
    headers = ["Invoice", "Description", "Amount", "Grand Total"]
    rows = [
        {"Invoice": "A-1", "Description": "Setup", "Amount": "10.00", "Grand Total": "30.00"},
        {"Invoice": "A-1", "Description": "Support", "Amount": "20.00", "Grand Total": "30.00"},
    ]
    mapping = heuristic_mapping(headers, rows)

    assert mapping.total == "Grand Total"
    assert mapping.line_item_amount == "Amount"
    assert mapping.granularity is RowGranularity.LINE_ITEM


def test_currency_is_inferred_from_a_symbol_when_there_is_no_currency_column() -> None:
    headers = ["Invoice", "Vendor", "Date", "Amount Due"]
    rows = [{"Invoice": "A-1", "Vendor": "Acme", "Date": "2026-01-05", "Amount Due": "£40.00"}]
    mapping = heuristic_mapping(headers, rows)

    assert mapping.currency_default == "GBP"
    assert any("£ symbol" in note for note in mapping.notes)


def test_ambiguous_numeric_dates_stay_unknown() -> None:
    headers = ["Invoice", "Date"]
    rows = [{"Invoice": "A-1", "Date": "03/08/2026"}, {"Invoice": "A-2", "Date": "04/09/2026"}]

    assert heuristic_mapping(headers, rows).date_format == "unknown"


def test_a_month_over_twelve_forces_month_first() -> None:
    headers = ["Invoice", "Date"]
    rows = [{"Invoice": "A-1", "Date": "08/28/2026"}]

    assert heuristic_mapping(headers, rows).date_format == "MDY"


# --------------------------------------------------------------------------- the Claude mapper


def claude_mapping() -> ColumnMapping:
    """What the model might return: mostly right, with one column that does not exist."""
    return ColumnMapping(
        granularity=RowGranularity.INVOICE,
        invoice_number="Inv No",
        vendor_name="Supplier",
        invoice_date="Bill Date",
        due_date="Pay By",
        currency="Ccy",
        currency_default="usd",
        status="State",
        subtotal="Net",
        tax="VAT",
        total="Grand Total",  # not a column in vendor_export.csv
        po_number="po ref",  # right column, wrong case
        date_format="DMY",
        notes=["Amounts are formatted with a dollar sign."],
    )


def test_llm_mapping_uses_structured_output_and_sees_the_sample_rows(settings: Settings) -> None:
    table = table_for("vendor_export.csv")
    fake = StructuredValueFake(value=claude_mapping())

    mapping = llm_mapping(table.headers, table.rows, settings, model=fake)

    assert fake.schemas == [ColumnMapping]
    messages = fake.calls[0].to_messages()
    assert "You map spreadsheet columns onto an invoice schema" in messages[0].content
    assert "Inv No" in messages[1].content
    assert "$1,234.50" in messages[1].content
    assert mapping.invoice_number == "Inv No"


def test_llm_mapping_drops_a_column_that_is_not_in_the_file(settings: Settings) -> None:
    table = table_for("vendor_export.csv")
    fake = StructuredValueFake(value=claude_mapping())

    mapping = llm_mapping(table.headers, table.rows, settings, model=fake)

    assert mapping.total is None
    assert any("Dropped total" in note and "Grand Total" in note for note in mapping.notes)
    # A case-only mismatch is repaired rather than dropped.
    assert mapping.po_number == "PO Ref"
    assert any("Matched po_number" in note for note in mapping.notes)
    assert mapping.currency_default == "USD"
    assert "Amounts are formatted with a dollar sign." in mapping.notes


def test_llm_mapping_rejects_a_bad_currency_default(settings: Settings) -> None:
    table = table_for("vendor_export.csv")
    bad = claude_mapping().model_copy(update={"currency_default": "dollars"})

    mapping = llm_mapping(table.headers, table.rows, settings, model=StructuredValueFake(value=bad))

    assert mapping.currency_default is None
    assert any("not a 3-letter ISO code" in note for note in mapping.notes)


def test_llm_mapping_wraps_provider_failures(settings: Settings) -> None:
    table = table_for("vendor_export.csv")
    fake = StructuredValueFake(error=RuntimeError("overloaded_error"))

    with pytest.raises(MappingError, match="overloaded_error"):
        llm_mapping(table.headers, table.rows, settings, model=fake)


def test_llm_mapping_needs_a_key_when_no_model_is_injected(settings: Settings) -> None:
    with pytest.raises(LLMNotConfigured):
        llm_mapping(["a"], [{"a": "1"}], settings)


def test_choose_mapping_uses_claude_when_a_model_is_available(settings: Settings) -> None:
    table = table_for("vendor_export.csv")
    fake = StructuredValueFake(value=claude_mapping())

    mapping, source = choose_mapping(table.headers, table.rows, settings, model=fake)

    assert source == "claude"
    assert mapping.invoice_number == "Inv No"


def test_choose_mapping_falls_back_to_heuristics_when_the_mapper_raises(settings: Settings) -> None:
    table = table_for("vendor_export.csv")
    fake = StructuredValueFake(error=RuntimeError("529 overloaded"))

    mapping, source = choose_mapping(table.headers, table.rows, settings, model=fake)

    assert source == "heuristic"
    # The reason is kept in front of the heuristic notes rather than hidden.
    assert "529 overloaded" in mapping.notes[0]
    assert mapping.total == "Amount Due"


def test_choose_mapping_is_heuristic_without_a_key(settings: Settings) -> None:
    table = table_for("vendor_export.csv")

    mapping, source = choose_mapping(table.headers, table.rows, settings)

    assert source == "heuristic"
    assert mapping.invoice_number == "Inv No"
