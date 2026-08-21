"""Applying a mapping: cell parsers, derivations, grouping and the preview envelope."""

from __future__ import annotations

from datetime import date

import pytest
from fixture_files import build_weird_xlsx, read_fixture

from app.column_mapping import heuristic_mapping
from app.config import Settings
from app.file_parsing import ParsedTable, parse_tabular
from app.importing import (
    apply_mapping,
    build_preview,
    parse_date,
    parse_line_items_cell,
    parse_money,
    parse_status,
)
from app.schemas import ColumnMapping, ImportedDraft, InvoiceStatus, RowGranularity
from app.validation import today


def drafts_for(name: str) -> list[ImportedDraft]:
    data = build_weird_xlsx() if name.endswith(".xlsx") else read_fixture(name)
    table = parse_tabular(name, data)
    return apply_mapping(table, heuristic_mapping(table.headers, table.rows))


# --------------------------------------------------------------------------- cell parsers


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("$1,234.50", 1234.50),
        ("(200.00)", -200.00),
        ("1.234,50", 1234.50),
        ("1,234", 1234.0),
        ("EUR 99,90", 99.90),
        ("£ 1 234.00", 1234.00),
        ("-15.5", -15.5),
        ("0.00", 0.0),
        ("", None),
        ("   ", None),
        ("n/a", None),
    ],
)
def test_parse_money(text: str, expected: float | None) -> None:
    assert parse_money(text) == expected


@pytest.mark.parametrize(
    ("text", "date_format", "expected"),
    [
        ("28/08/2026", "DMY", date(2026, 8, 28)),
        ("08/28/2026", "MDY", date(2026, 8, 28)),
        # The same ambiguous cell means different days under the two hints.
        ("03/08/2026", "DMY", date(2026, 8, 3)),
        ("03/08/2026", "MDY", date(2026, 3, 8)),
        ("2026-08-28", "ISO", date(2026, 8, 28)),
        ("2026-08-28 00:00:00", "ISO", date(2026, 8, 28)),
        ("20260828", "unknown", date(2026, 8, 28)),
        ("3 August 2026", "unknown", date(2026, 8, 3)),
        ("", "ISO", None),
        ("   ", "ISO", None),
        ("not a date", "ISO", None),
        ("1234", "ISO", None),
    ],
)
def test_parse_date(text: str, date_format: str, expected: date | None) -> None:
    assert parse_date(text, date_format) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Settled", InvoiceStatus.PAID),
        ("PAID", InvoiceStatus.PAID),
        ("Closed", InvoiceStatus.PAID),
        ("Complete", InvoiceStatus.PAID),
        ("Overdue", InvoiceStatus.OVERDUE),
        ("past due", InvoiceStatus.OVERDUE),
        ("Late", InvoiceStatus.OVERDUE),
        ("open", InvoiceStatus.PENDING),
        ("unpaid", InvoiceStatus.PENDING),
        ("", InvoiceStatus.PENDING),
    ],
)
def test_parse_status(text: str, expected: InvoiceStatus) -> None:
    assert parse_status(text) == expected


def test_parse_line_items_cell_reads_json_with_flexible_keys() -> None:
    items = parse_line_items_cell('[{"desc": "Setup", "qty": 2, "rate": 50, "line_total": 100}]')

    assert len(items) == 1
    assert (items[0].description, items[0].quantity, items[0].unit_price, items[0].amount) == (
        "Setup", 2.0, 50.0, 100.0,
    )


def test_parse_line_items_cell_reads_the_text_shorthand() -> None:
    items = parse_line_items_cell("Design work x 3 @ 250.00\nHosting x 1 @ 45.00")

    assert [item.description for item in items] == ["Design work", "Hosting"]
    assert [item.amount for item in items] == [750.0, 45.0]


# --------------------------------------------------------------------------- applying a mapping


def test_vendor_export_parses_money_dates_and_status() -> None:
    drafts = drafts_for("vendor_export.csv")
    first, settled, overdue = drafts[0].invoice, drafts[1].invoice, drafts[2].invoice

    assert [draft.invoice.invoice_number for draft in drafts] == [
        "NG-8801", "BP-8802", "MF-8803", "CF-8804",
    ]
    # "$1,234.50" and the DMY date order both come out of the file, not out of a guess.
    assert first.total == 1234.50
    assert (first.invoice_date, first.due_date) == (date(2026, 8, 3), date(2026, 9, 2))
    assert first.currency == "USD"
    assert first.po_number == "PO-44120"
    assert settled.status is InvoiceStatus.PAID  # "Settled"
    assert settled.due_date is None  # the empty "Pay By" cell
    assert overdue.status is InvoiceStatus.OVERDUE
    assert overdue.currency == "EUR"


def test_vendor_export_has_no_line_items_but_is_not_flagged_for_that() -> None:
    drafts = drafts_for("vendor_export.csv")

    assert all(draft.invoice.line_items == [] for draft in drafts)
    # A summary-level export is only flagged when its own numbers disagree, not for lacking line detail.
    assert not all(draft.needs_review for draft in drafts)
    assert all("No line items in the source file" in " ".join(draft.import_notes) for draft in drafts)
    assert not any("No line items" in note for draft in drafts for note in draft.review_notes)


def test_line_item_rows_are_grouped_into_two_invoices() -> None:
    drafts = drafts_for("line_items_export.csv")

    assert len(drafts) == 2
    assert [draft.invoice.invoice_number for draft in drafts] == ["LI-3001", "LI-3002"]
    assert [len(draft.invoice.line_items) for draft in drafts] == [3, 2]
    assert [draft.invoice.subtotal for draft in drafts] == [1000.0, 675.0]
    # Header is row 1, so the first data row is row 2.
    assert [draft.source_rows for draft in drafts] == [[2, 3, 4], [5, 6]]
    assert drafts[0].invoice.line_items[0].description == "Cloud compute usage"


def test_missing_totals_are_derived_and_explained() -> None:
    draft = drafts_for("line_items_export.csv")[0]
    invoice = draft.invoice

    assert (invoice.subtotal, invoice.tax, invoice.total) == (1000.0, 0.0, 1000.0)
    assert any("summed 3 line amount(s)" in note for note in draft.import_notes)
    assert any("tax recorded as 0" in note for note in draft.import_notes)
    assert any("subtotal + tax" in note for note in draft.import_notes)
    # Derived numbers must still satisfy the deterministic validator.
    assert draft.review_notes == []
    assert draft.needs_review is False


def test_xlsx_subtotal_is_derived_from_the_total() -> None:
    drafts = drafts_for("weird.xlsx")
    invoice = drafts[0].invoice

    assert (invoice.invoice_number, invoice.vendor_name) == ("EM-5501", "Emberly Marketing")
    assert (invoice.subtotal, invoice.tax, invoice.total) == (1815.0, 0.0, 1815.0)
    assert any("total minus tax" in note for note in drafts[0].import_notes)


def test_packed_json_lines_are_unpacked_and_add_up() -> None:
    drafts = drafts_for("erp_export.json")
    first, second = drafts[0], drafts[1]

    assert [len(draft.invoice.line_items) for draft in drafts] == [2, 1]
    assert first.invoice.vendor_email == "billing@torrentdata.example"
    assert (first.invoice.subtotal, first.invoice.tax, first.invoice.total) == (3300.0, 660.0, 3960.0)
    assert first.invoice.currency == "EUR"
    assert second.invoice.currency == "GBP"
    assert second.invoice.status is InvoiceStatus.PAID  # "settled"
    assert any("unpacked from the 'lines' column" in note for note in first.import_notes)
    # Line amounts sum to the stated subtotal, so nothing is flagged.
    assert [draft.needs_review for draft in drafts] == [False, False]


def test_a_missing_invoice_number_is_generated_from_the_filename_and_row() -> None:
    table = ParsedTable(
        headers=["Ref", "Vendor", "Date", "Total"],
        rows=[{"Ref": "", "Vendor": "Acme", "Date": "2026-02-01", "Total": "50.00"}],
        filename="ops export.csv",
    )
    draft = apply_mapping(table, heuristic_mapping(table.headers, table.rows))[0]

    assert draft.invoice.invoice_number == "IMPORT-ops-export-2"
    assert any("generated IMPORT-ops-export-2" in note for note in draft.import_notes)


def test_a_description_only_file_synthesizes_one_line() -> None:
    table = ParsedTable(
        headers=["Invoice", "Vendor", "Date", "Description", "Subtotal", "Total"],
        rows=[
            {
                "Invoice": "D-1",
                "Vendor": "Acme",
                "Date": "2026-02-01",
                "Description": "Annual licence renewal",
                "Subtotal": "500.00",
                "Total": "500.00",
            }
        ],
        filename="desc.csv",
    )
    draft = apply_mapping(table, heuristic_mapping(table.headers, table.rows))[0]

    assert len(draft.invoice.line_items) == 1
    assert draft.invoice.line_items[0].amount == 500.0
    assert any("one line was synthesized" in note for note in draft.import_notes)
    assert draft.needs_review is False


def test_an_unreadable_date_falls_back_to_today_and_is_flagged() -> None:
    table = ParsedTable(
        headers=["Invoice", "Vendor", "Date", "Total"],
        rows=[{"Invoice": "X-1", "Vendor": "Acme", "Date": "sometime", "Total": "10.00"}],
        filename="bad-dates.csv",
    )
    draft = apply_mapping(table, heuristic_mapping(table.headers, table.rows))[0]

    assert draft.invoice.invoice_date == today()
    assert any("today's date was used" in note for note in draft.review_notes)
    assert draft.needs_review is True


def test_line_item_rows_without_a_number_are_skipped_with_a_warning(settings: Settings) -> None:
    data = (
        b"Invoice,Vendor,Item,Qty,Unit Price,Line Total\n"
        b"G-1,Acme,Setup,1,100.00,100.00\n"
        b"G-1,Acme,Support,2,50.00,100.00\n"
        b",Acme,Orphan line,1,10.00,10.00\n"
    )
    preview = build_preview("orphans.csv", data, settings)

    assert preview.mapping.granularity is RowGranularity.LINE_ITEM
    assert len(preview.invoices) == 1
    assert preview.invoices[0].invoice.subtotal == 200.0
    assert any("1 row(s) were skipped" in warning for warning in preview.warnings)


def test_build_preview_reports_the_mapping_and_the_leftovers(settings: Settings) -> None:
    preview = build_preview("vendor_export.csv", read_fixture("vendor_export.csv"), settings)

    assert preview.filename == "vendor_export.csv"
    assert preview.row_count == 4
    assert preview.mapping_source == "heuristic"
    assert preview.model is None
    assert preview.unmapped_columns == []
    assert len(preview.invoices) == 4


def test_build_preview_lists_columns_nothing_mapped(settings: Settings) -> None:
    data = b"Invoice,Vendor,Date,Total,Internal Notes,Cost Centre\nA-1,Acme,2026-02-01,10.00,ignore me,CC-9\n"
    preview = build_preview("extra.csv", data, settings)

    assert preview.unmapped_columns == ["Internal Notes", "Cost Centre"]


def test_an_injected_model_makes_the_preview_claude_sourced(settings: Settings) -> None:
    from fakes import StructuredValueFake

    mapping = ColumnMapping(
        granularity=RowGranularity.INVOICE,
        invoice_number="Inv No",
        vendor_name="Supplier",
        invoice_date="Bill Date",
        total="Amount Due",
        currency_default="USD",
        date_format="DMY",
    )
    preview = build_preview(
        "vendor_export.csv",
        read_fixture("vendor_export.csv"),
        settings,
        model=StructuredValueFake(value=mapping),
    )

    assert preview.mapping_source == "claude"
    assert preview.model == settings.anthropic_model
    assert preview.unmapped_columns == ["Pay By", "Net", "VAT", "Ccy", "State", "PO Ref"]


def test_status_values_from_the_mapping_translate_foreign_vocabulary() -> None:
    from app.schemas import InvoiceStatus

    translation = {"bezahlt": InvoiceStatus.PAID, "offen": InvoiceStatus.PENDING, "überfällig": InvoiceStatus.OVERDUE}
    assert parse_status("bezahlt", translation) is InvoiceStatus.PAID
    assert parse_status("Überfällig ", translation) is InvoiceStatus.OVERDUE
    # Unknown words still fall back to the English synonyms / pending.
    assert parse_status("Settled", translation) is InvoiceStatus.PAID
    assert parse_status("whatever", translation) is InvoiceStatus.PENDING
