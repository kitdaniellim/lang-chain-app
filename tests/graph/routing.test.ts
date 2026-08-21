import { describe, expect, it } from "vitest";
import { routeAfterRisk, scoreRisk } from "../../src/graph/invoice.graph.js";
import type { InvoiceStateType } from "../../src/graph/state.js";
import type { ExtractedInvoice, ValidationIssue } from "../../src/domain/schemas.js";
import { FIXTURE_EXTRACTED } from "../fixtures/sample-documents.js";

/**
 * Pins the router against the sentences in `renderPolicyDocument` (`src/domain/policy.ts`):
 * duplicates and missing POs "must be held for review", a foreign currency is "not an error".
 */

const EXTRACTED: ExtractedInvoice = { ...FIXTURE_EXTRACTED, confidence: 0.95, warnings: [] };

const issue = (
  code: ValidationIssue["code"],
  severity: ValidationIssue["severity"],
  message = `${code} raised`,
): ValidationIssue => ({ code, severity, message });

/** Minimal invoice state carrying the issues plus the risk `scoreRisk` derives from them. */
function stateOf(issues: ValidationIssue[], extracted: ExtractedInvoice | null = EXTRACTED): InvoiceStateType {
  return {
    document: { id: "doc-001", filename: "doc-001.plain.txt", format: "plain", text: "" },
    extracted,
    provider: "fake",
    issues,
    categorization: null,
    risk: extracted === null ? null : scoreRisk(issues),
    policyExcerpts: [],
    investigation: null,
    decision: "needs_review",
    timings: {},
  };
}

describe("routeAfterRisk — handbook rules", () => {
  it("auto-approves a clean invoice", () => {
    const state = stateOf([]);
    expect(state.risk?.level).toBe("low");
    expect(routeAfterRisk(state)).toBe("auto_approve");
  });

  it("sends a near-duplicate warning to a human (Duplicates: must be reviewed)", () => {
    const state = stateOf([issue("DUPLICATE_IN_LEDGER", "warning", "Possible duplicate: 1 ledger row(s)")]);
    expect(routeAfterRisk(state)).toBe("investigate");
    expect(state.risk?.level).not.toBe("low");
  });

  it("sends a missing PO to a human (Purchase orders: must be held for review)", () => {
    const state = stateOf([issue("MISSING_PO", "warning")]);
    expect(routeAfterRisk(state)).toBe("investigate");
    expect(state.risk?.level).toBe("medium");
  });

  it("still sends a near-duplicate plus a missing PO to a human", () => {
    const state = stateOf([issue("DUPLICATE_IN_LEDGER", "warning"), issue("MISSING_PO", "warning")]);
    expect(routeAfterRisk(state)).toBe("investigate");
  });

  it("auto-rejects an exact ledger duplicate (error severity)", () => {
    const state = stateOf([issue("DUPLICATE_IN_LEDGER", "error", "already appears in the ledger")]);
    expect(routeAfterRisk(state)).toBe("auto_reject");
  });

  it("auto-rejects when nothing could be extracted", () => {
    expect(routeAfterRisk(stateOf([issue("EXTRACTION_FAILED", "error")], null))).toBe("auto_reject");
  });

  it("auto-approves a foreign-currency invoice (Data quality: flagged, but not an error)", () => {
    const state = stateOf([issue("FOREIGN_CURRENCY", "warning", "Invoice is billed in EUR")]);
    expect(state.risk?.level).toBe("low");
    expect(routeAfterRisk(state)).toBe("auto_approve");
  });

  it("routes an over-threshold invoice to review", () => {
    expect(routeAfterRisk(stateOf([issue("OVER_REVIEW_THRESHOLD", "warning")]))).toBe("investigate");
    expect(routeAfterRisk(stateOf([issue("OVER_CFO_THRESHOLD", "warning")]))).toBe("investigate");
  });

  it("routes an unknown vendor to review (Vendors: always require human review)", () => {
    expect(routeAfterRisk(stateOf([issue("UNKNOWN_VENDOR", "error")]))).toBe("investigate");
  });
});

describe("scoreRisk", () => {
  it("scores a clean invoice zero and low", () => {
    expect(scoreRisk([])).toEqual({ score: 0, level: "low", reasons: [] });
  });

  it("floors a review-gated warning at medium and names the policy rule", () => {
    const risk = scoreRisk([issue("MISSING_PO", "warning")]);
    expect(risk.level).toBe("medium");
    expect(risk.score).toBeGreaterThanOrEqual(25);
    expect(risk.reasons.some((r) => r.startsWith("Policy (Purchase orders)"))).toBe(true);
  });

  it("lifts two unrelated warnings to medium", () => {
    const risk = scoreRisk([issue("FOREIGN_CURRENCY", "warning"), issue("LOW_CONFIDENCE", "warning")]);
    expect(risk.level).toBe("medium");
    expect(risk.reasons.every((r) => !r.startsWith("Policy ("))).toBe(true);
  });

  it("leaves a single non-gated warning low", () => {
    expect(scoreRisk([issue("FOREIGN_CURRENCY", "warning")]).level).toBe("low");
  });

  it("keeps errors high and caps the score at 100", () => {
    const risk = scoreRisk([
      issue("TOTAL_MISMATCH", "error"),
      issue("LINE_SUM_MISMATCH", "error"),
      issue("UNKNOWN_VENDOR", "error"),
      issue("OVER_CFO_THRESHOLD", "warning"),
    ]);
    expect(risk.score).toBe(100);
    expect(risk.level).toBe("high");
  });
});
