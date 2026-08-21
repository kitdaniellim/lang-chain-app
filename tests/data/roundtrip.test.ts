import { describe, expect, it } from "vitest";
import { generateBatch } from "../../src/data/generator.js";
import { DEFAULT_POLICY } from "../../src/domain/policy.js";
import { parseInvoiceText } from "../../src/llm/text-parser.js";
import { checkDates, checkPolicy, checkTotals, checkVendor } from "../../src/tools/checks.js";

/**
 * Seam test: the renderers, the parser and the deterministic checks must agree.
 * Every generated document has to parse back to its ground truth, and every invoice
 * generated *without* a defect has to come out of the checks with nothing to report.
 */

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

describe("renderer -> parser -> checks round trip", () => {
  it("recovers every ground-truth field from the rendered document", () => {
    for (const seed of SEEDS) {
      const manifest = generateBatch({ count: 12, seed, defectRate: 0.5 });

      manifest.documents.forEach((document, index) => {
        const truth = manifest.groundTruth[index]!;
        const parsed = parseInvoiceText(document.text);
        const where = `seed ${seed} ${document.id} (${document.format})`;

        expect(parsed.invoiceNumber, `${where} invoiceNumber`).toBe(truth.invoiceNumber);
        expect(parsed.vendorName?.toLowerCase(), `${where} vendorName`).toBe(truth.vendor.name.toLowerCase());
        expect(parsed.issueDate, `${where} issueDate`).toBe(truth.issueDate);
        expect(parsed.dueDate, `${where} dueDate`).toBe(truth.dueDate);
        expect(parsed.currency, `${where} currency`).toBe(truth.currency);
        expect(parsed.subtotal, `${where} subtotal`).toBe(truth.subtotal);
        expect(parsed.taxAmount, `${where} taxAmount`).toBe(truth.taxAmount);
        expect(parsed.total, `${where} total`).toBe(truth.total);
        expect(parsed.poNumber, `${where} poNumber`).toBe(truth.poNumber);
        expect(parsed.lineItems.length, `${where} lineItems`).toBe(truth.lineItems.length);
      });
    }
  });

  it("raises no issue at all for an invoice generated without defects", () => {
    for (const seed of SEEDS) {
      const manifest = generateBatch({ count: 12, seed, defectRate: 0.5 });

      manifest.documents.forEach((document, index) => {
        const truth = manifest.groundTruth[index]!;
        if (truth.defects.length > 0) return;

        const parsed = parseInvoiceText(document.text);
        const issues = [
          ...checkTotals(parsed),
          ...checkDates(parsed),
          ...checkVendor(parsed).issues,
          ...checkPolicy(parsed, null, DEFAULT_POLICY),
        ];
        expect(issues, `seed ${seed} ${document.id} (${document.format})`).toEqual([]);
      });
    }
  });
});
