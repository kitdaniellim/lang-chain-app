import { describe, expect, it } from "vitest";
import { generateBatch } from "../../src/data/generator.js";
import { applyDefect } from "../../src/data/defects.js";
import { createRng } from "../../src/data/rng.js";
import { renderDocument } from "../../src/data/renderers.js";
import { BatchManifestSchema, InvoiceSchema } from "../../src/domain/schemas.js";
import type { DefectCode, Invoice } from "../../src/domain/schemas.js";
import { DEFAULT_POLICY } from "../../src/domain/policy.js";
import { MONEY_TOLERANCE } from "../../src/domain/constants.js";
import { findVendor } from "../../src/domain/vendors.js";
import { FIXTURE_INVOICE } from "../fixtures/sample-documents.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const sumAmounts = (invoice: Invoice): number => round2(invoice.lineItems.reduce((s, i) => s + i.amount, 0));
const has = (invoice: Invoice, code: DefectCode): boolean => invoice.defects.includes(code);

describe("generateBatch — determinism and shape", () => {
  it("produces deep-equal manifests for the same seed", () => {
    const a = generateBatch({ count: 8, seed: 42, defectRate: 0.5 });
    const b = generateBatch({ count: 8, seed: 42, defectRate: 0.5 });
    expect(a).toEqual(b);
  });

  it("produces different output for a different seed", () => {
    const a = generateBatch({ count: 8, seed: 42, defectRate: 0.5 });
    const b = generateBatch({ count: 8, seed: 43, defectRate: 0.5 });
    expect(a.groundTruth).not.toEqual(b.groundTruth);
  });

  it("emits exactly `count` documents and matching ground truth", () => {
    const manifest = generateBatch({ count: 7, seed: 1, defectRate: 0.3 });
    expect(manifest.documents).toHaveLength(7);
    expect(manifest.groundTruth).toHaveLength(7);
    manifest.groundTruth.forEach((invoice, i) => {
      expect(invoice.id).toBe(manifest.documents[i]!.id);
      expect(invoice.id).toBe(`doc-${String(i + 1).padStart(3, "0")}`);
    });
  });

  it("validates against BatchManifestSchema and InvoiceSchema", () => {
    const manifest = generateBatch({ count: 12, seed: 7, defectRate: 0.6 });
    expect(() => BatchManifestSchema.parse(manifest)).not.toThrow();
    for (const invoice of manifest.groundTruth) expect(() => InvoiceSchema.parse(invoice)).not.toThrow();
  });

  it("names documents <docId>.<format>.txt and renders each from its ground truth", () => {
    const manifest = generateBatch({ count: 9, seed: 11, defectRate: 0.4 });
    const formats = new Set(manifest.documents.map((d) => d.format));
    expect(formats.size).toBe(3);
    manifest.documents.forEach((doc, i) => {
      expect(doc.filename).toBe(`${doc.id}.${doc.format}.txt`);
      expect(doc.text).toBe(renderDocument(manifest.groundTruth[i]!, doc.format));
      expect(doc.text).toContain(manifest.groundTruth[i]!.invoiceNumber);
    });
  });

  it("honours an explicit batchId and now", () => {
    const manifest = generateBatch({
      count: 3,
      seed: 5,
      defectRate: 0,
      batchId: "batch-test",
      now: new Date("2026-01-15T00:00:00Z"),
    });
    expect(manifest.batchId).toBe("batch-test");
    expect(manifest.createdAt).toBe("2026-01-15T00:00:00.000Z");
    expect(manifest.seed).toBe(5);
    expect(manifest.defectRate).toBe(0);
    for (const invoice of manifest.groundTruth) expect(invoice.issueDate < "2026-01-15").toBe(true);
  });
});

describe("generateBatch — clean batches", () => {
  it("injects no defects at defectRate 0 and keeps totals below the review threshold", () => {
    const manifest = generateBatch({ count: 15, seed: 3, defectRate: 0 });
    for (const invoice of manifest.groundTruth) {
      expect(invoice.defects).toEqual([]);
      expect(invoice.total).toBeLessThan(DEFAULT_POLICY.reviewThreshold);
      expect(invoice.currency).toBe("USD");
      expect(invoice.poNumber).not.toBeNull();
      expect(invoice.dueDate).not.toBeNull();
      expect(invoice.dueDate! > invoice.issueDate).toBe(true);
      expect(sumAmounts(invoice)).toBe(invoice.subtotal);
      expect(round2(invoice.subtotal + invoice.taxAmount)).toBe(invoice.total);
      expect(findVendor(invoice.vendor.name)).not.toBeNull();
      expect(invoice.lineItems.length).toBeGreaterThanOrEqual(1);
      expect(invoice.lineItems.length).toBeLessThanOrEqual(5);
    }
    const numbers = new Set(manifest.groundTruth.map((i) => i.invoiceNumber));
    expect(numbers.size).toBe(15);
  });
});

describe("generateBatch — defect injection", () => {
  const manifest = generateBatch({ count: 12, seed: 2026, defectRate: 1 });
  const codes = new Set(manifest.groundTruth.flatMap((i) => i.defects));

  it("covers at least six distinct defect codes", () => {
    expect(codes.size).toBeGreaterThanOrEqual(6);
  });

  it("keeps at least one clean invoice", () => {
    expect(manifest.groundTruth.filter((i) => i.defects.length === 0).length).toBeGreaterThanOrEqual(1);
  });

  it("makes a DUPLICATE_NUMBER invoice reuse an earlier invoice number", () => {
    const dupIndex = manifest.groundTruth.findIndex((i) => has(i, "DUPLICATE_NUMBER"));
    expect(dupIndex).toBeGreaterThan(0);
    const dup = manifest.groundTruth[dupIndex]!;
    const earlier = manifest.groundTruth.slice(0, dupIndex);
    expect(earlier.some((e) => e.invoiceNumber === dup.invoiceNumber)).toBe(true);
  });

  it("gives every defect code a visible effect on the invoice", () => {
    for (const invoice of manifest.groundTruth) {
      if (has(invoice, "MATH_MISMATCH")) {
        expect(invoice.total).not.toBe(round2(invoice.subtotal + invoice.taxAmount));
      }
      if (has(invoice, "LINE_SUM_MISMATCH")) {
        expect(invoice.subtotal).not.toBe(sumAmounts(invoice));
      }
      if (has(invoice, "DUE_BEFORE_ISSUE")) {
        expect(invoice.dueDate).not.toBeNull();
        expect(invoice.dueDate! < invoice.issueDate).toBe(true);
      }
      if (has(invoice, "MISSING_DUE_DATE")) expect(invoice.dueDate).toBeNull();
      if (has(invoice, "UNKNOWN_VENDOR")) expect(findVendor(invoice.vendor.name)).toBeNull();
      if (has(invoice, "FOREIGN_CURRENCY")) expect(invoice.currency).not.toBe("USD");
      if (has(invoice, "OVER_THRESHOLD")) {
        expect(invoice.total).toBeGreaterThanOrEqual(DEFAULT_POLICY.reviewThreshold * 1.2);
        expect(invoice.total).toBeLessThanOrEqual(DEFAULT_POLICY.cfoThreshold * 1.5);
      }
      if (has(invoice, "MISSING_PO")) {
        expect(invoice.poNumber).toBeNull();
        expect(invoice.total).toBeGreaterThanOrEqual(DEFAULT_POLICY.poRequiredAbove);
        expect(invoice.total).toBeLessThan(DEFAULT_POLICY.reviewThreshold);
      }
      if (invoice.defects.length === 0) {
        expect(invoice.total).toBeLessThan(DEFAULT_POLICY.reviewThreshold);
      }
      // Two drawn codes, plus UNKNOWN_VENDOR when DUPLICATE_NUMBER inherits an unregistered vendor.
      expect(invoice.defects.length).toBeLessThanOrEqual(3);
      expect(new Set(invoice.defects).size).toBe(invoice.defects.length);
    }
  });
});

describe("generateBatch — ground truth matches the document", () => {
  const seeds = [1, 3, 7, 12, 19, 26, 33, 41, 58, 76];

  it("lists UNKNOWN_VENDOR on every invoice whose vendor is not in the registry", () => {
    for (const seed of seeds) {
      for (const invoice of generateBatch({ count: 12, seed, defectRate: 1 }).groundTruth) {
        if (findVendor(invoice.vendor.name) === null) {
          expect(invoice.defects, `seed ${seed} ${invoice.id} vendor ${invoice.vendor.name}`).toContain(
            "UNKNOWN_VENDOR",
          );
        }
      }
    }
  });

  it("keeps arithmetic exact unless a mismatch defect says otherwise", () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const invoice of generateBatch({ count: 12, seed, defectRate: 1 }).groundTruth) {
        const where = `seed ${seed} ${invoice.id}`;
        const lineSumExact = Math.abs(sumAmounts(invoice) - invoice.subtotal) <= MONEY_TOLERANCE;
        const totalExact = Math.abs(invoice.subtotal + invoice.taxAmount - invoice.total) <= MONEY_TOLERANCE;

        if (!has(invoice, "LINE_SUM_MISMATCH")) expect(lineSumExact, `${where} line sum`).toBe(true);
        else expect(lineSumExact, `${where} line sum should be wrong`).toBe(false);

        if (!has(invoice, "MATH_MISMATCH")) expect(totalExact, `${where} total`).toBe(true);
        else expect(totalExact, `${where} total should be wrong`).toBe(false);
      }
    }
  });
});

describe("applyDefect", () => {
  const ctx = { earlier: [] as Invoice[], policy: DEFAULT_POLICY };

  it("never mutates the input invoice", () => {
    const before = structuredClone(FIXTURE_INVOICE);
    const out = applyDefect(FIXTURE_INVOICE, "MATH_MISMATCH", createRng(1), ctx);
    expect(FIXTURE_INVOICE).toEqual(before);
    expect(out).not.toBe(FIXTURE_INVOICE);
    expect(out.defects).toEqual(["MATH_MISMATCH"]);
  });

  it("returns the invoice untouched when DUPLICATE_NUMBER has no earlier invoice", () => {
    const out = applyDefect(FIXTURE_INVOICE, "DUPLICATE_NUMBER", createRng(1), ctx);
    expect(out).toEqual(FIXTURE_INVOICE);
  });

  it("copies the number and vendor of an earlier invoice for DUPLICATE_NUMBER", () => {
    const earlier: Invoice = { ...FIXTURE_INVOICE, id: "doc-000", invoiceNumber: "INV-2026-0001" };
    const out = applyDefect(
      { ...FIXTURE_INVOICE, invoiceNumber: "INV-2026-0999" },
      "DUPLICATE_NUMBER",
      createRng(9),
      { earlier: [earlier], policy: DEFAULT_POLICY },
    );
    expect(out.invoiceNumber).toBe("INV-2026-0001");
    expect(out.vendor).toEqual(earlier.vendor);
    expect(out.total).toBe(FIXTURE_INVOICE.total);
    expect(out.defects).toEqual(["DUPLICATE_NUMBER"]);
  });

  it("appends to existing defects rather than replacing them", () => {
    const seeded: Invoice = { ...FIXTURE_INVOICE, defects: ["FOREIGN_CURRENCY"] };
    const out = applyDefect(seeded, "MISSING_DUE_DATE", createRng(4), ctx);
    expect(out.defects).toEqual(["FOREIGN_CURRENCY", "MISSING_DUE_DATE"]);
    expect(out.dueDate).toBeNull();
  });
});
