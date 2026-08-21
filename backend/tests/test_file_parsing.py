"""CSV / JSON / XLSX parsing: delimiters, BOMs, nesting, caps and the error taxonomy."""

from __future__ import annotations

import json

import pytest
from fixture_files import build_weird_xlsx, read_fixture

from app.file_parsing import (
    MAX_FILE_BYTES,
    EmptyFile,
    FileParseError,
    FileTooLarge,
    UnsupportedFile,
    parse_tabular,
)


def test_csv_headers_and_rows() -> None:
    table = parse_tabular("vendor_export.csv", read_fixture("vendor_export.csv"))

    assert table.headers == [
        "Supplier", "Inv No", "Bill Date", "Pay By", "Net", "VAT", "Amount Due", "Ccy", "State", "PO Ref",
    ]
    assert len(table.rows) == 4
    assert table.rows[0]["Amount Due"] == "$1,234.50"
    assert table.rows[1]["Pay By"] == ""


def test_csv_strips_the_bom_and_skips_blank_lines() -> None:
    data = "﻿a,b\r\n1,2\r\n\r\n,\r\n3,4\r\n".encode("utf-8")
    table = parse_tabular("bom.csv", data)

    assert table.headers == ["a", "b"]
    assert table.rows == [{"a": "1", "b": "2"}, {"a": "3", "b": "4"}]


def test_csv_sniffs_a_semicolon_delimiter() -> None:
    table = parse_tabular("euro.csv", b"vendor;total\nAcme;1.234,50\nBeta;99,90\n")

    assert table.headers == ["vendor", "total"]
    assert table.rows[0] == {"vendor": "Acme", "total": "1.234,50"}


def test_csv_names_blank_and_duplicate_headers() -> None:
    table = parse_tabular("dupes.csv", b"total,,total\n1,2,3\n")

    assert table.headers == ["total", "column_2", "total (2)"]
    assert table.rows[0]["total (2)"] == "3"


def test_json_array_is_flattened_to_dotted_keys() -> None:
    table = parse_tabular("erp_export.json", read_fixture("erp_export.json"))

    assert "vendor.name" in table.headers
    assert "vendor.email" in table.headers
    assert table.flattened == ["vendor.name", "vendor.email"]
    assert len(table.rows) == 2
    assert table.rows[0]["vendor.name"] == "Torrent Data Labs"
    # Lists survive as JSON text so the line-item unpacker can read them back.
    assert json.loads(table.rows[0]["lines"])[0]["description"] == "Data pipeline retainer"


def test_json_object_with_one_array_key_is_the_table() -> None:
    payload = json.dumps({"generated": "2026-08-20", "invoices": [{"no": "A1"}, {"no": "A2"}]})
    table = parse_tabular("wrapped.json", payload.encode())

    assert table.headers == ["no"]
    assert [row["no"] for row in table.rows] == ["A1", "A2"]


def test_json_single_object_is_one_row() -> None:
    table = parse_tabular("one.json", b'{"no": "A1", "total": 10}')

    assert table.rows == [{"no": "A1", "total": "10"}]


def test_json_must_contain_objects() -> None:
    with pytest.raises(FileParseError, match="JSON objects"):
        parse_tabular("bad.json", b"[1, 2, 3]")


def test_invalid_json_is_reported_not_swallowed() -> None:
    with pytest.raises(FileParseError, match="not valid JSON"):
        parse_tabular("bad.json", b"{oops}")


def test_xlsx_first_sheet_first_non_empty_row_is_the_header() -> None:
    table = parse_tabular("weird.xlsx", build_weird_xlsx())

    assert table.headers == ["Payee", "Document No", "Issued", "Total Incl. Tax"]
    assert len(table.rows) == 2
    # openpyxl hands back a datetime; it is stored as an ISO date string.
    assert table.rows[0]["Issued"] == "2026-07-21"
    assert table.rows[0]["Total Incl. Tax"] == "1815"
    assert table.rows[1]["Total Incl. Tax"] == "940.5"


def test_unknown_extension_is_unsupported() -> None:
    with pytest.raises(UnsupportedFile, match="Unsupported file type"):
        parse_tabular("payload.exe", b"MZ\x00\x00")


def test_a_file_with_no_data_rows_is_empty() -> None:
    with pytest.raises(EmptyFile):
        parse_tabular("headers.csv", b"a,b,c\n")


def test_an_entirely_empty_file_is_empty() -> None:
    with pytest.raises(EmptyFile):
        parse_tabular("nothing.csv", b"")


def test_the_byte_cap_is_enforced() -> None:
    with pytest.raises(FileTooLarge, match="the limit is"):
        parse_tabular("huge.csv", b"x" * (MAX_FILE_BYTES + 1))


def test_the_row_cap_is_enforced() -> None:
    rows = "\n".join(f"{i},b" for i in range(2_100))
    with pytest.raises(FileTooLarge, match="more than 2000 rows"):
        parse_tabular("many.csv", f"a,b\n{rows}\n".encode())


def test_non_utf8_text_is_reported() -> None:
    with pytest.raises(FileParseError, match="not valid UTF-8"):
        parse_tabular("latin.csv", b"a,b\n\xff\xfe,2\n")
