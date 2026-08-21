"""Fixture loaders. The XLSX is built with openpyxl at test time so no binary is committed."""

from __future__ import annotations

import io
from datetime import date
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"

WEIRD_HEADERS = ("Payee", "Document No", "Issued", "Total Incl. Tax")
WEIRD_ROWS = (
    ("Emberly Marketing", "EM-5501", date(2026, 7, 21), 1815.0),
    ("Pinegrove Office Interiors", "PO-5502", date(2026, 8, 3), 940.5),
)


def read_fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def build_weird_xlsx() -> bytes:
    """A workbook whose headers match nothing we use: `Payee`, `Document No`, `Total Incl. Tax`."""
    from openpyxl import Workbook

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Export"
    sheet.append(list(WEIRD_HEADERS))
    for row in WEIRD_ROWS:
        sheet.append(list(row))

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()
