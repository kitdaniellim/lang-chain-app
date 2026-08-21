import { describe, expect, it } from "vitest";
import { parseInvoiceText } from "../../src/llm/text-parser.js";
import { renderTable } from "../../src/data/renderers.js";
import {
  EMAIL_TEXT,
  FIXTURE_EXTRACTED,
  FIXTURE_INVOICE,
  PLAIN_TEXT,
  TABLE_TEXT,
  TABLE_VENDOR_NAME,
} from "../fixtures/sample-documents.js";
import type { ExtractedInvoice } from "../../src/domain/schemas.js";

/** Everything except the parser-owned confidence/warnings fields. */
function core(parsed: ExtractedInvoice): Omit<ExtractedInvoice, "confidence" | "warnings"> {
  const { confidence: _c, warnings: _w, ...rest } = parsed;
  return rest;
}

/** Drops the optional "Due"/"PO" rows from any of the three layouts. */
function dropOptional(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^(Due|PO)\b/.test(line.replace(/^\|\s*/, "")))
    .join("\n");
}

describe("parseInvoiceText", () => {
  it("parses the plain layout back into the fixture extraction", () => {
    const parsed = parseInvoiceText(PLAIN_TEXT);
    expect(core(parsed)).toEqual(FIXTURE_EXTRACTED);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.8);
    expect(parsed.warnings).toEqual([]);
  });

  it("parses the email layout back into the fixture extraction", () => {
    const parsed = parseInvoiceText(EMAIL_TEXT);
    expect(core(parsed)).toEqual(FIXTURE_EXTRACTED);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("parses the table layout, keeping the vendor name as printed", () => {
    const parsed = parseInvoiceText(TABLE_TEXT);
    expect(core(parsed)).toEqual({ ...FIXTURE_EXTRACTED, vendorName: TABLE_VENDOR_NAME });
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it.each([
    ["plain", PLAIN_TEXT],
    ["email", EMAIL_TEXT],
    ["table", TABLE_TEXT],
  ])("returns nulls for an omitted due date and PO number (%s)", (_name, text) => {
    const parsed = parseInvoiceText(dropOptional(text));
    expect(parsed.dueDate).toBeNull();
    expect(parsed.poNumber).toBeNull();
    expect(parsed.total).toBe(216);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.confidence).toBeLessThan(0.9);
    expect(parsed.confidence).toBeGreaterThan(0.6);
  });

  it.each([51, 52, 53])(
    "strips the INVOICE label from a %i-char table vendor name (no space left at 52-53)",
    (length) => {
      const name = `${"A".repeat(length - 4)} LTD`;
      expect(name).toHaveLength(length);
      const text = renderTable({ ...FIXTURE_INVOICE, vendor: { ...FIXTURE_INVOICE.vendor, name } });

      const parsed = parseInvoiceText(text);
      expect(parsed.vendorName).toBe(name.toUpperCase());
      expect(parsed.vendorName).not.toMatch(/INVOICE$/);
      expect(parsed.total).toBe(216);
    },
  );

  it("normalises all three date styles to YYYY-MM-DD", () => {
    expect(parseInvoiceText(PLAIN_TEXT).issueDate).toBe("2026-07-03");
    expect(parseInvoiceText(EMAIL_TEXT).issueDate).toBe("2026-07-03");
    expect(parseInvoiceText(TABLE_TEXT).issueDate).toBe("2026-07-03");
  });

  it("degrades to nulls and a single warning on an unrecognised layout", () => {
    const parsed = parseInvoiceText("just some prose that is definitely not an invoice at all");
    expect(parsed.invoiceNumber).toBeNull();
    expect(parsed.vendorName).toBeNull();
    expect(parsed.total).toBeNull();
    expect(parsed.lineItems).toEqual([]);
    expect(parsed.confidence).toBeLessThan(0.3);
    expect(parsed.warnings).toHaveLength(1);
  });

  it("never throws on hostile input", () => {
    for (const text of ["", "   ", "{}{{}}", "INVOICE", " "]) {
      expect(() => parseInvoiceText(text)).not.toThrow();
    }
  });
});
