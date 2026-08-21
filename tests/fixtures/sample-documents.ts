/**
 * CONTRACT FIXTURE — one invoice rendered in each document format.
 *
 * `src/data/renderers.ts` must reproduce these strings byte-for-byte from FIXTURE_INVOICE,
 * and `src/llm/text-parser.ts` (the fake model's extractor) must parse each of them back
 * into FIXTURE_EXTRACTED. Both test suites import this file, so the two halves cannot drift.
 */
import type { ExtractedInvoice, Invoice } from "../../src/domain/schemas.js";

export const FIXTURE_INVOICE: Invoice = {
  id: "doc-001",
  invoiceNumber: "INV-2026-0417",
  vendor: {
    name: "Acme Cloud Inc",
    email: "billing@acmecloud.example",
    address: "123 Main St, Springfield, IL 62701",
  },
  issueDate: "2026-07-03",
  dueDate: "2026-08-02",
  currency: "USD",
  lineItems: [
    { description: "Compute hours (c5.large)", quantity: 120, unitPrice: 0.45, amount: 54 },
    { description: "Object storage 2 TB", quantity: 2, unitPrice: 23, amount: 46 },
    { description: "Support plan - Business", quantity: 1, unitPrice: 100, amount: 100 },
  ],
  subtotal: 200,
  taxRate: 0.08,
  taxAmount: 16,
  total: 216,
  poNumber: "PO-48213",
  notes: "Thank you for your business.",
  defects: [],
};

/** What a perfect extraction of any of the three renderings looks like (vendor name case may differ — see note). */
export const FIXTURE_EXTRACTED: Omit<ExtractedInvoice, "confidence" | "warnings"> = {
  invoiceNumber: "INV-2026-0417",
  vendorName: "Acme Cloud Inc",
  vendorEmail: "billing@acmecloud.example",
  issueDate: "2026-07-03",
  dueDate: "2026-08-02",
  currency: "USD",
  lineItems: [
    { description: "Compute hours (c5.large)", quantity: 120, unitPrice: 0.45, amount: 54 },
    { description: "Object storage 2 TB", quantity: 2, unitPrice: 23, amount: 46 },
    { description: "Support plan - Business", quantity: 1, unitPrice: 100, amount: 100 },
  ],
  subtotal: 200,
  taxRate: 0.08,
  taxAmount: 16,
  total: 216,
  poNumber: "PO-48213",
};

/**
 * Format "plain": label/value lines, ISO dates, numbered line items `N. desc - qty x unit = amount`.
 * Optional lines (Due Date, PO Number, Notes) are simply omitted when the value is null.
 */
export const PLAIN_TEXT = `INVOICE

Invoice Number: INV-2026-0417
Invoice Date: 2026-07-03
Due Date: 2026-08-02
PO Number: PO-48213
Currency: USD

From:
Acme Cloud Inc
123 Main St, Springfield, IL 62701
billing@acmecloud.example

Bill To:
Demo Corp - Accounts Payable
ap@democorp.example

Line Items:
1. Compute hours (c5.large) - 120 x 0.45 = 54.00
2. Object storage 2 TB - 2 x 23.00 = 46.00
3. Support plan - Business - 1 x 100.00 = 100.00

Subtotal: 200.00
Tax (8%): 16.00
Total Due: 216.00

Notes: Thank you for your business.
`;

/**
 * Format "email": RFC-822-ish headers, "DD Mon YYYY" dates, bullet line items with pipes,
 * currency-prefixed totals, vendor name in Subject and signature.
 * Optional lines (Due, PO) are omitted when null; the notes paragraph is omitted when null.
 */
export const EMAIL_TEXT = `From: billing@acmecloud.example
To: ap@democorp.example
Subject: Invoice INV-2026-0417 from Acme Cloud Inc

Hi team,

Please find the details of your invoice below.

Invoice #: INV-2026-0417
Date: 03 Jul 2026
Due: 02 Aug 2026
PO: PO-48213
Currency: USD

- Compute hours (c5.large) | qty 120 | @ 0.45 | 54.00
- Object storage 2 TB | qty 2 | @ 23.00 | 46.00
- Support plan - Business | qty 1 | @ 100.00 | 100.00

Subtotal: USD 200.00
Tax 8%: USD 16.00
Amount due: USD 216.00

Thank you for your business.

Regards,
Acme Cloud Inc Billing
`;

/**
 * Format "table": fixed-width box (64 chars wide, 60-char content rows), MM/DD/YYYY dates,
 * vendor name UPPER-CASED in the header. Column layout of content rows:
 *   meta:   label.padEnd(13) + value
 *   items:  qty.padEnd(6) + description.slice(0,32).padEnd(34) + unit.padEnd(10) + amount.padStart(10)
 *   totals: "".padEnd(40) + label.padEnd(10) + amount.padStart(10)
 * Optional rows (Due, PO) are omitted when null. Vendor name extracted as printed (upper case).
 */
export const TABLE_TEXT = `+--------------------------------------------------------------+
| ACME CLOUD INC                                       INVOICE |
| 123 Main St, Springfield, IL 62701                           |
| billing@acmecloud.example                                    |
+--------------------------------------------------------------+
| Invoice No   INV-2026-0417                                   |
| Issued       07/03/2026                                      |
| Due          08/02/2026                                      |
| PO           PO-48213                                        |
| Currency     USD                                             |
+--------------------------------------------------------------+
| QTY   DESCRIPTION                       UNIT          AMOUNT |
| 120   Compute hours (c5.large)          0.45           54.00 |
| 2     Object storage 2 TB               23.00          46.00 |
| 1     Support plan - Business           100.00        100.00 |
+--------------------------------------------------------------+
|                                         SUBTOTAL      200.00 |
|                                         TAX 8%         16.00 |
|                                         TOTAL         216.00 |
+--------------------------------------------------------------+
`;

/** Vendor name as the table format prints it. */
export const TABLE_VENDOR_NAME = "ACME CLOUD INC";
