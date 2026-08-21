import { describe, expect, it } from "vitest";
import { computeStats } from "../../src/pipeline/stats.js";
import { makeBatchResult, makeProcessed } from "../fixtures/processed.js";

describe("computeStats", () => {
  const processed = makeBatchResult().processed;

  it("counts every decision bucket", () => {
    const stats = computeStats(processed);
    expect(stats.total).toBe(3);
    expect(stats.autoApproved).toBe(1);
    expect(stats.approvedByHuman).toBe(0);
    expect(stats.rejectedByHuman).toBe(1);
    expect(stats.autoRejected).toBe(1);
    expect(stats.needsReview).toBe(0);
  });

  it("sums totals overall and for approved invoices only", () => {
    const stats = computeStats(processed);
    expect(stats.totalAmount).toBeCloseTo(1765.5, 2);
    expect(stats.approvedAmount).toBeCloseTo(216, 2);
  });

  it("counts approved_by_human towards approvedAmount", () => {
    const stats = computeStats([
      makeProcessed({ decision: "approved_by_human", decidedBy: "human" }),
      makeProcessed({ documentId: "doc-x", decision: "needs_review" }),
    ]);
    expect(stats.approvedAmount).toBeCloseTo(216, 2);
    expect(stats.totalAmount).toBeCloseTo(432, 2);
    expect(stats.needsReview).toBe(1);
  });

  it("groups by category and skips uncategorised invoices", () => {
    const stats = computeStats([
      ...processed,
      makeProcessed({ documentId: "doc-004" }),
      makeProcessed({ documentId: "doc-005", categorization: null }),
    ]);
    expect(stats.byCategory).toEqual({ CLOUD_HOSTING: 2, PROFESSIONAL_SERVICES: 1, SOFTWARE: 1 });
  });

  it("counts every issue occurrence by code", () => {
    const stats = computeStats(processed);
    expect(stats.issuesByCode).toEqual({ TOTAL_MISMATCH: 1, UNKNOWN_VENDOR: 1, DUPLICATE_IN_BATCH: 1 });
  });

  it("ignores null totals and handles an empty batch", () => {
    const empty = computeStats([]);
    expect(empty).toMatchObject({ total: 0, totalAmount: 0, approvedAmount: 0, byCategory: {}, issuesByCode: {} });

    const noTotal = computeStats([makeProcessed({ extracted: null, decision: "auto_rejected" })]);
    expect(noTotal.totalAmount).toBe(0);
  });

  it("matches the stats baked into the shared fixture", () => {
    const result = makeBatchResult();
    expect(computeStats(result.processed)).toEqual(result.stats);
  });
});
