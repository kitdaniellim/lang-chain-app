import { describe, expect, it } from "vitest";
import type { BatchManifest, DefectCode, Invoice } from "../../src/domain/schemas.js";
import { evaluateBatch, renderEvaluation } from "../../src/evaluate/evaluate.js";
import { makeBatchResult } from "../fixtures/processed.js";

const result = makeBatchResult();

const LINE_ITEMS = [
  { description: "Compute hours, c5.large", quantity: 120, unitPrice: 0.45, amount: 54 },
  { description: "Object storage 2 TB", quantity: 2, unitPrice: 23, amount: 46 },
  { description: "Support plan - Business", quantity: 1, unitPrice: 100, amount: 100 },
];

function truth(overrides: Partial<Invoice>): Invoice {
  return {
    id: "doc-001",
    invoiceNumber: "INV-2026-0417",
    vendor: { name: "Acme Cloud Inc", email: "billing@acmecloud.example", address: "123 Main St" },
    issueDate: "2026-07-03",
    dueDate: "2026-08-02",
    currency: "USD",
    lineItems: LINE_ITEMS,
    subtotal: 200,
    taxRate: 0.08,
    taxAmount: 16,
    total: 216,
    poNumber: "PO-48213",
    notes: null,
    defects: [],
    ...overrides,
  };
}

/** Ground truth that matches the shared fixture field-for-field. */
function makeManifest(groundTruth: Invoice[] = defaultTruth()): BatchManifest {
  return {
    batchId: result.batchId,
    createdAt: "2026-08-20T08:59:00.000Z",
    seed: 42,
    defectRate: 0.3,
    documents: groundTruth.map((g) => ({ id: g.id, filename: `${g.id}.txt`, format: "plain" as const, text: "..." })),
    groundTruth,
  };
}

function defaultTruth(): Invoice[] {
  return [
    truth({}),
    truth({
      id: "doc-002",
      invoiceNumber: "INV-2026-0418",
      vendor: { name: "Globex Consulting, LLC", email: "ar@globex.example", address: "9 Rue de Rivoli" },
      currency: "EUR",
      subtotal: 1300,
      taxAmount: 104,
      total: 1450.5,
      poNumber: null,
      defects: ["MATH_MISMATCH", "MISSING_PO"] as DefectCode[],
    }),
    truth({
      id: "doc-003",
      vendor: { name: "Initech Software", email: "billing@initech.example", address: "5 Office Park" },
      subtotal: 92,
      taxAmount: 7,
      total: 99,
      poNumber: "PO-48999",
      defects: ["DUPLICATE_NUMBER"] as DefectCode[],
    }),
  ];
}

describe("evaluateBatch — field accuracy", () => {
  it("scores a perfect extraction at 1", () => {
    const report = evaluateBatch(makeManifest(), result);
    expect(report.overallFieldAccuracy).toBe(1);
    for (const [field, score] of Object.entries(report.fields)) {
      expect(score, field).toEqual({ correct: 3, total: 3, accuracy: 1 });
    }
    expect(Object.keys(report.fields)).toEqual([
      "invoiceNumber",
      "vendorName",
      "vendorEmail",
      "issueDate",
      "dueDate",
      "currency",
      "subtotal",
      "taxAmount",
      "total",
      "poNumber",
      "lineItems",
    ]);
  });

  it("normalises case and whitespace before comparing strings", () => {
    const gt = defaultTruth();
    gt[0]!.vendor = { ...gt[0]!.vendor, name: "  ACME CLOUD INC " };
    expect(evaluateBatch(makeManifest(gt), result).fields.vendorName).toEqual({ correct: 3, total: 3, accuracy: 1 });
  });

  it("counts a genuinely different value as wrong", () => {
    const gt = defaultTruth();
    gt[0]!.vendor = { ...gt[0]!.vendor, name: "Contoso Cloud" };
    const report = evaluateBatch(makeManifest(gt), result);
    expect(report.fields.vendorName).toEqual({ correct: 2, total: 3, accuracy: 2 / 3 });
    expect(report.overallFieldAccuracy).toBeLessThan(1);
  });

  it("tolerates a cent of numeric drift but not more", () => {
    const near = defaultTruth();
    near[0]!.total = 216.009;
    expect(evaluateBatch(makeManifest(near), result).fields.total!.correct).toBe(3);

    const far = defaultTruth();
    far[0]!.total = 216.5;
    expect(evaluateBatch(makeManifest(far), result).fields.total!.correct).toBe(2);
  });

  it("treats null === null as correct and null vs value as wrong", () => {
    const gt = defaultTruth();
    // doc-002's extracted poNumber is null and so is the ground truth.
    expect(evaluateBatch(makeManifest(gt), result).fields.poNumber).toEqual({ correct: 3, total: 3, accuracy: 1 });

    gt[1]!.poNumber = "PO-77777";
    expect(evaluateBatch(makeManifest(gt), result).fields.poNumber!.correct).toBe(2);
  });

  it("compares line items by length", () => {
    const gt = defaultTruth();
    gt[2]!.lineItems = LINE_ITEMS.slice(0, 2);
    expect(evaluateBatch(makeManifest(gt), result).fields.lineItems).toEqual({ correct: 2, total: 3, accuracy: 2 / 3 });
  });

  it("scores every field wrong when extraction failed or the document is missing", () => {
    const report = evaluateBatch(makeManifest(), { ...result, processed: result.processed.slice(0, 2) });
    expect(report.fields.total).toEqual({ correct: 2, total: 3, accuracy: 2 / 3 });
    expect(report.perDocument.find((d) => d.documentId === "doc-003")?.decision).toBe("missing");
  });
});

describe("evaluateBatch — defect recall", () => {
  const report = evaluateBatch(makeManifest(), result);

  it("marks a defect caught when a mapped issue code was raised", () => {
    const byCode = Object.fromEntries(report.defects.map((d) => [d.code, d]));
    expect(byCode.MATH_MISMATCH).toEqual({ code: "MATH_MISMATCH", injected: 1, caught: 1, recall: 1 });
    expect(byCode.DUPLICATE_NUMBER).toEqual({ code: "DUPLICATE_NUMBER", injected: 1, caught: 1, recall: 1 });
  });

  it("marks a defect missed when no mapped issue was raised", () => {
    const byCode = Object.fromEntries(report.defects.map((d) => [d.code, d]));
    expect(byCode.MISSING_PO).toEqual({ code: "MISSING_PO", injected: 1, caught: 0, recall: 0 });
  });

  it("reports the overall recall over injected defects only", () => {
    expect(report.overallDefectRecall).toBeCloseTo(2 / 3, 6);
    expect(report.defects.map((d) => d.code).sort()).toEqual(["DUPLICATE_NUMBER", "MATH_MISMATCH", "MISSING_PO"]);
  });

  it("lists the injected defects, raised issues and decision per document", () => {
    const doc2 = report.perDocument.find((d) => d.documentId === "doc-002")!;
    expect(doc2.defects).toEqual(["MATH_MISMATCH", "MISSING_PO"]);
    expect(doc2.caughtIssues).toEqual(["TOTAL_MISMATCH", "UNKNOWN_VENDOR"]);
    expect(doc2.decision).toBe("rejected_by_human");
  });

  it("is vacuously perfect when nothing was injected", () => {
    const clean = defaultTruth().map((g) => ({ ...g, defects: [] }));
    const noDefects = evaluateBatch(makeManifest(clean), result);
    expect(noDefects.defects).toEqual([]);
    expect(noDefects.overallDefectRecall).toBe(1);
  });
});

describe("renderEvaluation", () => {
  it("prints a field table, a defect table and the overall lines", () => {
    const text = renderEvaluation(evaluateBatch(makeManifest(), result));
    expect(text).toContain("invoiceNumber");
    expect(text).toContain("lineItems");
    expect(text).toContain("MATH_MISMATCH");
    expect(text).toContain("Field accuracy");
    expect(text).toContain("Defect recall");
    expect(text).toContain("66.7%");
  });
});
