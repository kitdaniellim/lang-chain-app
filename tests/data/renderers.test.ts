import { describe, expect, it } from "vitest";
import {
  EMAIL_TEXT,
  FIXTURE_INVOICE,
  PLAIN_TEXT,
  TABLE_TEXT,
} from "../fixtures/sample-documents.js";
import { renderDocument, renderEmail, renderPlain, renderTable } from "../../src/data/renderers.js";
import type { Invoice } from "../../src/domain/schemas.js";

const tableRows = (text: string): string[] => text.split("\n").filter((line) => line.length > 0);

describe("renderers — byte-exact fixture reproduction", () => {
  it("renders the plain format exactly", () => {
    expect(renderPlain(FIXTURE_INVOICE)).toBe(PLAIN_TEXT);
    expect(renderDocument(FIXTURE_INVOICE, "plain")).toBe(PLAIN_TEXT);
  });

  it("renders the email format exactly", () => {
    expect(renderEmail(FIXTURE_INVOICE)).toBe(EMAIL_TEXT);
    expect(renderDocument(FIXTURE_INVOICE, "email")).toBe(EMAIL_TEXT);
  });

  it("renders the table format exactly", () => {
    expect(renderTable(FIXTURE_INVOICE)).toBe(TABLE_TEXT);
    expect(renderDocument(FIXTURE_INVOICE, "table")).toBe(TABLE_TEXT);
  });
});

describe("renderers — omitted optional fields", () => {
  const bare: Invoice = { ...FIXTURE_INVOICE, dueDate: null, poNumber: null, notes: null };

  it("plain omits Due Date, PO Number and Notes lines", () => {
    const text = renderPlain(bare);
    expect(text).not.toContain("Due Date:");
    expect(text).not.toContain("PO Number:");
    expect(text).not.toContain("Notes:");
    expect(text).toContain("Invoice Date: 2026-07-03");
    expect(text.endsWith("Total Due: 216.00\n")).toBe(true);
    expect(text).not.toContain("\n\n\n");
  });

  it("email omits Due and PO lines and the notes paragraph", () => {
    const text = renderEmail(bare);
    expect(text).not.toContain("\nDue: ");
    expect(text).not.toContain("\nPO: ");
    expect(text).not.toContain("Thank you for your business.");
    expect(text.endsWith("Regards,\nAcme Cloud Inc Billing\n")).toBe(true);
    expect(text).not.toContain("\n\n\n");
  });

  it("table omits the Due and PO rows and keeps every row 64 chars", () => {
    const text = renderTable(bare);
    expect(text).not.toContain("| Due ");
    expect(text).not.toContain("| PO ");
    expect(text).toContain("| Issued       07/03/2026");
    for (const row of tableRows(text)) expect(row).toHaveLength(64);
  });
});

describe("renderers — table column discipline", () => {
  it("keeps every row 64 chars for the fixture", () => {
    for (const row of tableRows(renderTable(FIXTURE_INVOICE))) expect(row).toHaveLength(64);
  });

  it("truncates a long vendor name to 53 chars and long descriptions to 32", () => {
    const long: Invoice = {
      ...FIXTURE_INVOICE,
      vendor: { ...FIXTURE_INVOICE.vendor, name: "Extraordinarily Long Vendor Name For Column Truncation Testing Ltd" },
      lineItems: [
        {
          description: "An extremely long line item description that will not fit",
          quantity: 3,
          unitPrice: 12.5,
          amount: 37.5,
        },
      ],
    };
    const text = renderTable(long);
    for (const row of tableRows(text)) expect(row).toHaveLength(64);
    expect(text).toContain("| EXTRAORDINARILY LONG VENDOR NAME FOR COLUMN TRUNCATIOINVOICE |");
    expect(text).not.toContain("TESTING LTD");
    expect(text).toContain("An extremely long line item desc  ");
    expect(text).not.toContain("An extremely long line item description");
  });
});

describe("renderers — tax percentage and money formatting", () => {
  it("prints the tax rate as a rounded whole percentage", () => {
    const zeroTax: Invoice = { ...FIXTURE_INVOICE, taxRate: 0, taxAmount: 0, total: 200 };
    expect(renderPlain(zeroTax)).toContain("Tax (0%): 0.00");
    expect(renderEmail(zeroTax)).toContain("Tax 0%: USD 0.00");
    expect(renderTable(zeroTax)).toContain("TAX 0%");

    const twelve: Invoice = { ...FIXTURE_INVOICE, taxRate: 0.12, taxAmount: 24, total: 224 };
    expect(renderPlain(twelve)).toContain("Tax (12%): 24.00");
  });

  it("prints every money value with two decimals", () => {
    const text = renderPlain({ ...FIXTURE_INVOICE, subtotal: 200.5, taxAmount: 16.04, total: 216.54 });
    expect(text).toContain("Subtotal: 200.50");
    expect(text).toContain("Tax (8%): 16.04");
    expect(text).toContain("Total Due: 216.54");
  });
});
