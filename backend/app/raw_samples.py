"""Three realistic raw invoices used to show the extraction pipeline in the seed.

Each carries its known-correct values, so the seed can fall back to them when no API key is set
(and so tests have fixtures that do not need the network).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from app.schemas import Invoice, InvoiceStatus, LineItem

EMAIL_INVOICE = """From: billing@northwind-analytics.com
To: accounts-payable@ourcompany.com
Subject: Northwind Analytics - invoice NW-2291 for July 2026

Hi team,

Please find July's charges below. Payment terms are net 30, so this is due 30 August 2026.
Your PO reference PO-88214 has been quoted as requested.

  Invoice number: NW-2291
  Invoice date:   31 July 2026

  Data pipeline retainer - July 2026 .................. 1 x $4,800.00 = $4,800.00
  Ad-hoc dashboard build ............................. 12 x   $145.00 = $1,740.00

  Subtotal                                                        $6,540.00
  Sales tax (8.25%)                                                 $539.55
  Total due                                                       $7,079.55

Bank details are unchanged. Let me know if you need anything else.

Sara Whitfield
Northwind Analytics
"""

PLAIN_TEXT_INVOICE = """BRAUER LOGISTIK GMBH
Speicherstadt 14, 20457 Hamburg
rechnung@brauer-logistik.de

RECHNUNG / INVOICE

Invoice no.  BL-2026-0417
Invoice date 2026-06-12
Due date     2026-07-12
Terms        30 days net

Description                                  Qty   Unit price      Amount
-----------------------------------------------------------------------
Palletised freight, Hamburg - Rotterdam        3      EUR 410.00   EUR 1,230.00
Customs clearance handling                     1      EUR 175.50   EUR   175.50
Fuel surcharge                                 1      EUR  96.20   EUR    96.20
-----------------------------------------------------------------------
                                          Subtotal                 EUR 1,501.70
                                          VAT 19%                  EUR   285.32
                                          TOTAL                    EUR 1,787.02

Please transfer the total to the account below quoting the invoice number.
"""

OCR_TABLE_INVOICE = """HALEWOOD PRINT & SIGNAGE LTD          INVOICE
Unit 7 Speke Approach, Liverpool L24 9PB
accounts@halewoodprint.co.uk

INVOICE NO   HPS/45120          ORDER NO   4400291
DATE         28/05/2026         DUE        27/06/2026

ITEM                             QTY    UNIT      LINE TOTAL
A1 foamex boards (matte)          40    12.75        510.00
Vinyl banner 3m x 1m               6    48.00        288.00
Delivery - next day                1    35.00         35.00

                              SUB TOTAL              833.00
                              VAT @ 20%              166.60
                              TOTAL GBP              999.60

*** PAID IN FULL - received 03/06/2026, thank you ***
"""


@dataclass(frozen=True, slots=True)
class RawSample:
    """A raw document plus the values a correct extraction should produce."""

    name: str
    text: str
    expected: Invoice


RAW_SAMPLES: tuple[RawSample, ...] = (
    RawSample(
        name="email-body",
        text=EMAIL_INVOICE,
        expected=Invoice(
            invoice_number="NW-2291",
            vendor_name="Northwind Analytics",
            vendor_email="billing@northwind-analytics.com",
            invoice_date=date(2026, 7, 31),
            due_date=date(2026, 8, 30),
            currency="USD",
            line_items=[
                LineItem(
                    description="Data pipeline retainer - July 2026",
                    quantity=1,
                    unit_price=4800.00,
                    amount=4800.00,
                ),
                LineItem(
                    description="Ad-hoc dashboard build", quantity=12, unit_price=145.00, amount=1740.00
                ),
            ],
            subtotal=6540.00,
            tax=539.55,
            total=7079.55,
            po_number="PO-88214",
            status=InvoiceStatus.PENDING,
        ),
    ),
    RawSample(
        name="plain-text",
        text=PLAIN_TEXT_INVOICE,
        expected=Invoice(
            invoice_number="BL-2026-0417",
            vendor_name="Brauer Logistik GmbH",
            vendor_email="rechnung@brauer-logistik.de",
            invoice_date=date(2026, 6, 12),
            due_date=date(2026, 7, 12),
            currency="EUR",
            line_items=[
                LineItem(
                    description="Palletised freight, Hamburg - Rotterdam",
                    quantity=3,
                    unit_price=410.00,
                    amount=1230.00,
                ),
                LineItem(
                    description="Customs clearance handling", quantity=1, unit_price=175.50, amount=175.50
                ),
                LineItem(description="Fuel surcharge", quantity=1, unit_price=96.20, amount=96.20),
            ],
            subtotal=1501.70,
            tax=285.32,
            total=1787.02,
            po_number=None,
            status=InvoiceStatus.PENDING,
        ),
    ),
    RawSample(
        name="ocr-table",
        text=OCR_TABLE_INVOICE,
        expected=Invoice(
            invoice_number="HPS/45120",
            vendor_name="Halewood Print & Signage Ltd",
            vendor_email="accounts@halewoodprint.co.uk",
            invoice_date=date(2026, 5, 28),
            due_date=date(2026, 6, 27),
            currency="GBP",
            line_items=[
                LineItem(
                    description="A1 foamex boards (matte)", quantity=40, unit_price=12.75, amount=510.00
                ),
                LineItem(description="Vinyl banner 3m x 1m", quantity=6, unit_price=48.00, amount=288.00),
                LineItem(description="Delivery - next day", quantity=1, unit_price=35.00, amount=35.00),
            ],
            subtotal=833.00,
            tax=166.60,
            total=999.60,
            po_number="4400291",
            status=InvoiceStatus.PAID,
        ),
    ),
)
