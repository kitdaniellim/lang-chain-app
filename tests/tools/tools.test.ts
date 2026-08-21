import { beforeAll, describe, expect, it } from "vitest";
import type { ExactQuery, LedgerEntry, LedgerReader, SimilarQuery } from "../../src/data/ledger.types.js";
import { TOOL_NAMES } from "../../src/domain/constants.js";
import { DEFAULT_POLICY } from "../../src/domain/policy.js";
import { normalizeVendorName } from "../../src/domain/vendors.js";
import type { ExtractedInvoice, ValidationIssue } from "../../src/domain/schemas.js";
import { PolicyRetriever } from "../../src/rag/policy-retriever.js";
import {
  checkDates,
  checkLedgerDuplicates,
  checkPolicy,
  checkTotals,
  checkVendor,
  computeTotals,
  createTools,
} from "../../src/tools/index.js";
import type { ToolKit } from "../../src/pipeline/types.js";
import { FIXTURE_EXTRACTED } from "../fixtures/sample-documents.js";

const BATCH_ID = "batch-now";

/** Fixture extraction with overrides; confidence/warnings are not part of the shared fixture. */
const extracted = (over: Partial<ExtractedInvoice> = {}): ExtractedInvoice => ({
  ...FIXTURE_EXTRACTED,
  lineItems: FIXTURE_EXTRACTED.lineItems.map((item) => ({ ...item })),
  confidence: 0.95,
  warnings: [],
  ...over,
});

const codes = (issues: ValidationIssue[]): string[] => issues.map((i) => i.code);
const find = (issues: ValidationIssue[], code: string): ValidationIssue | undefined =>
  issues.find((i) => i.code === code);

// ---------------------------------------------------------------------------
// In-memory LedgerReader stub (the real ledger is written by another task)
// ---------------------------------------------------------------------------

const LEDGER_ENTRIES: LedgerEntry[] = [
  {
    invoiceNumber: "INV-2026-0417",
    vendorName: "Acme Cloud Inc",
    total: 216,
    currency: "USD",
    issueDate: "2024-01-05",
    documentId: "doc-900",
    batchId: "batch-old",
    decision: "auto_approved",
    processedAt: "2024-01-06T00:00:00.000Z",
  },
  {
    invoiceNumber: "INV-2026-0417",
    vendorName: "Acme Cloud Inc",
    total: 216,
    currency: "USD",
    issueDate: "2026-07-03",
    documentId: "doc-001",
    batchId: BATCH_ID,
    decision: "auto_approved",
    processedAt: "2026-07-04T00:00:00.000Z",
  },
  {
    invoiceNumber: "INV-2026-0390",
    vendorName: "Acme Cloud Inc",
    total: 216,
    currency: "USD",
    issueDate: "2026-06-12",
    documentId: "doc-901",
    batchId: "batch-old",
    decision: "auto_approved",
    processedAt: "2026-06-13T00:00:00.000Z",
  },
];

const dayDiff = (a: string, b: string): number =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

function makeLedger(entries: LedgerEntry[] = LEDGER_ENTRIES): LedgerReader {
  const find = (invoiceNumber: string, excludeBatchId?: string): LedgerEntry[] =>
    entries.filter((e) => e.invoiceNumber === invoiceNumber && (!excludeBatchId || e.batchId !== excludeBatchId));

  return {
    find,
    findExact: (q: ExactQuery) =>
      find(q.invoiceNumber, q.excludeBatchId).filter((e) =>
        e.vendorName === null
          ? q.vendorName === null
          : q.vendorName !== null && normalizeVendorName(e.vendorName) === normalizeVendorName(q.vendorName),
      ),
    findSimilar: (q: SimilarQuery) =>
      entries.filter(
        (e) =>
          (!q.excludeBatchId || e.batchId !== q.excludeBatchId) &&
          q.vendorName !== null &&
          e.vendorName === q.vendorName &&
          q.total !== null &&
          e.total === q.total &&
          q.issueDate !== null &&
          e.issueDate !== null &&
          dayDiff(e.issueDate, q.issueDate) <= q.windowDays,
      ),
    size: () => entries.length,
  };
}

// ---------------------------------------------------------------------------

describe("checkTotals", () => {
  it("reports nothing for the clean fixture", () => {
    expect(checkTotals(extracted())).toEqual([]);
  });

  it("flags TOTAL_MISMATCH when the printed total is off by 10", () => {
    const issues = checkTotals(extracted({ total: 226 }));
    const issue = find(issues, "TOTAL_MISMATCH");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("216.00");
    expect(issue?.message).toContain("226.00");
  });

  it("flags LINE_SUM_MISMATCH when the printed subtotal is off by 5", () => {
    const issues = checkTotals(extracted({ subtotal: 205 }));
    expect(codes(issues)).toContain("LINE_SUM_MISMATCH");
    expect(find(issues, "LINE_SUM_MISMATCH")?.severity).toBe("error");
    // The bad subtotal also cascades into the total comparison.
    expect(codes(issues)).toContain("TOTAL_MISMATCH");
  });

  it("treats a null total as MISSING_FIELD, never a mismatch", () => {
    const issues = checkTotals(extracted({ total: null }));
    expect(codes(issues)).toEqual(["MISSING_FIELD"]);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.field).toBe("total");
  });

  it("cannot verify a total with no tax amount and no tax rate, and says so", () => {
    const result = computeTotals({
      lineItems: [{ quantity: 1, unitPrice: 200, amount: 200 }],
      subtotal: 200,
      taxRate: null,
      taxAmount: null,
      total: 216,
    });
    // Nothing to derive tax from, so the printed total must NOT come back as verified.
    expect(result.computedTax).toBeNull();
    expect(result.computedTotal).toBeNull();
    expect(result.totalMatches).toBeNull();
    expect(result.totalMatches).not.toBe(true);
    expect(codes(result.issues)).toEqual(["MISSING_FIELD"]);
    expect(result.issues[0]!.field).toBe("taxAmount");
    expect(result.issues[0]!.message).toContain("216.00");
  });

  it("leaves lineSumMatches null when the sum could not be checked", () => {
    expect(computeTotals({ lineItems: [], subtotal: 200, taxRate: null, taxAmount: 16, total: 216 }).lineSumMatches)
      .toBeNull();
    expect(checkTotals(extracted()).length).toBe(0);
  });

  it("warns when there are no line items to verify the subtotal against", () => {
    const issues = checkTotals(extracted({ lineItems: [] }));
    expect(codes(issues)).toEqual(["MISSING_FIELD"]);
    expect(issues[0]!.field).toBe("lineItems");
    expect(codes(issues)).not.toContain("LINE_SUM_MISMATCH");
  });

  it("warns once per line item with a null amount and does not fake a sum mismatch", () => {
    const items = FIXTURE_EXTRACTED.lineItems.map((item) => ({ ...item }));
    items[1]!.amount = null;
    const issues = checkTotals(extracted({ lineItems: items }));
    expect(codes(issues)).toEqual(["MISSING_FIELD"]);
    expect(issues[0]!.field).toBe("lineItems[1].amount");
  });
});

describe("checkDates", () => {
  it("reports nothing for the clean fixture", () => {
    expect(checkDates(extracted())).toEqual([]);
  });

  it("flags a due date before the issue date", () => {
    const issues = checkDates(extracted({ dueDate: "2026-06-01" }));
    const issue = find(issues, "DUE_BEFORE_ISSUE");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("2026-06-01");
    expect(issue?.message).toContain("2026-07-03");
  });

  it("flags a missing due date as a warning", () => {
    const issues = checkDates(extracted({ dueDate: null }));
    expect(codes(issues)).toEqual(["MISSING_DUE_DATE"]);
    expect(issues[0]!.severity).toBe("warning");
  });

  it("flags a missing issue date as MISSING_FIELD", () => {
    const issues = checkDates(extracted({ issueDate: null }));
    expect(codes(issues)).toContain("MISSING_FIELD");
    expect(find(issues, "MISSING_FIELD")?.field).toBe("issueDate");
  });
});

describe("checkVendor", () => {
  it("matches a registry vendor with no issues", () => {
    const result = checkVendor(extracted());
    expect(result.issues).toEqual([]);
    expect(result.match?.vendor.id).toBe("v-001");
  });

  it("flags an off-registry vendor as UNKNOWN_VENDOR", () => {
    const result = checkVendor(extracted({ vendorName: "Totally Unknown GmbH" }));
    expect(result.match).toBeNull();
    expect(codes(result.issues)).toContain("UNKNOWN_VENDOR");
    expect(find(result.issues, "UNKNOWN_VENDOR")?.severity).toBe("error");
  });

  it("flags a null vendor name as both MISSING_FIELD and UNKNOWN_VENDOR", () => {
    const result = checkVendor(extracted({ vendorName: null }));
    expect(codes(result.issues).sort()).toEqual(["MISSING_FIELD", "UNKNOWN_VENDOR"]);
    expect(find(result.issues, "MISSING_FIELD")?.field).toBe("vendorName");
  });
});

describe("checkPolicy", () => {
  it("flags a 6,000 total as OVER_REVIEW_THRESHOLD", () => {
    const issues = checkPolicy(extracted({ total: 6_000 }), "SOFTWARE", DEFAULT_POLICY);
    const issue = find(issues, "OVER_REVIEW_THRESHOLD");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("6,000.00");
    expect(issue?.message).toContain("5,000");
    expect(codes(issues)).not.toContain("OVER_CFO_THRESHOLD");
  });

  it("flags a 30,000 total as OVER_CFO_THRESHOLD as well", () => {
    const issues = checkPolicy(extracted({ total: 30_000 }), "SOFTWARE", DEFAULT_POLICY);
    expect(codes(issues)).toContain("OVER_REVIEW_THRESHOLD");
    expect(find(issues, "OVER_CFO_THRESHOLD")?.message).toContain("25,000");
  });

  it("flags a 2,500 total with no PO as MISSING_PO", () => {
    const issues = checkPolicy(
      extracted({ total: 2_500, poNumber: null }),
      "SOFTWARE",
      DEFAULT_POLICY,
    );
    expect(codes(issues)).toContain("MISSING_PO");
    expect(find(issues, "MISSING_PO")?.field).toBe("poNumber");
    expect(codes(issues)).not.toContain("OVER_REVIEW_THRESHOLD");
  });

  it("does not ask for a PO when one is present", () => {
    const issues = checkPolicy(extracted({ total: 2_500 }), "SOFTWARE", DEFAULT_POLICY);
    expect(codes(issues)).not.toContain("MISSING_PO");
  });

  it("flags a non-base currency", () => {
    const issues = checkPolicy(extracted({ currency: "EUR" }), "SOFTWARE", DEFAULT_POLICY);
    const issue = find(issues, "FOREIGN_CURRENCY");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("EUR");
  });

  it("flags a missing currency rather than assuming base currency", () => {
    const issues = checkPolicy(extracted({ currency: null }), "SOFTWARE", DEFAULT_POLICY);
    const issue = find(issues, "MISSING_FIELD");
    expect(issue?.severity).toBe("warning");
    expect(issue?.field).toBe("currency");
    expect(codes(issues)).not.toContain("FOREIGN_CURRENCY");
  });

  it("uses the stricter TRAVEL threshold for a 3,500 total", () => {
    const travel = checkPolicy(extracted({ total: 3_500 }), "TRAVEL", DEFAULT_POLICY);
    expect(codes(travel)).toContain("OVER_REVIEW_THRESHOLD");
    expect(find(travel, "OVER_REVIEW_THRESHOLD")?.message).toContain("3,000");

    const software = checkPolicy(extracted({ total: 3_500 }), "SOFTWARE", DEFAULT_POLICY);
    expect(codes(software)).not.toContain("OVER_REVIEW_THRESHOLD");
  });

  it("falls back to the global threshold when the category is unknown", () => {
    const issues = checkPolicy(extracted({ total: 5_000 }), null, DEFAULT_POLICY);
    expect(codes(issues)).toContain("OVER_REVIEW_THRESHOLD");
  });

  it("flags a low-confidence extraction", () => {
    const issues = checkPolicy(extracted({ confidence: 0.4 }), "SOFTWARE", DEFAULT_POLICY);
    const issue = find(issues, "LOW_CONFIDENCE");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("0.6");
  });

  it("reports nothing for a small, well-formed invoice", () => {
    expect(checkPolicy(extracted(), "CLOUD_HOSTING", DEFAULT_POLICY)).toEqual([]);
  });
});

describe("checkLedgerDuplicates", () => {
  it("errors on the same invoice number from the same vendor outside the current batch", () => {
    const issues = checkLedgerDuplicates(extracted(), makeLedger(), BATCH_ID, DEFAULT_POLICY);
    const exact = issues.find((i) => i.severity === "error");
    expect(exact?.code).toBe("DUPLICATE_IN_LEDGER");
    expect(exact?.message).toContain("INV-2026-0417");
    expect(exact?.message).toContain("Acme Cloud Inc");
  });

  it("only warns when the same invoice number belongs to a different vendor", () => {
    const otherVendor: LedgerEntry[] = [
      {
        invoiceNumber: "INV-2026-0417",
        vendorName: "Northwind Software LLC",
        total: 999,
        currency: "USD",
        issueDate: "2026-07-01",
        documentId: "doc-902",
        batchId: "batch-old",
        decision: "auto_approved",
        processedAt: "2026-07-02T00:00:00.000Z",
      },
    ];
    const issues = checkLedgerDuplicates(extracted(), makeLedger(otherVendor), BATCH_ID, DEFAULT_POLICY);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("DUPLICATE_IN_LEDGER");
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toBe(
      "Invoice number INV-2026-0417 already used by vendor Northwind Software LLC (document doc-902 from batch batch-old)",
    );
  });

  it("warns on a same-vendor same-amount hit inside the window", () => {
    const issues = checkLedgerDuplicates(extracted(), makeLedger(), BATCH_ID, DEFAULT_POLICY);
    const similar = issues.find((i) => i.severity === "warning");
    expect(similar?.code).toBe("DUPLICATE_IN_LEDGER");
    expect(similar?.message.startsWith("Possible duplicate:")).toBe(true);
  });

  it("reports nothing against an empty ledger", () => {
    expect(checkLedgerDuplicates(extracted(), makeLedger([]), BATCH_ID, DEFAULT_POLICY)).toEqual([]);
  });

  it("reports a row that is both an exact and a near match only once", () => {
    const bothWays: LedgerEntry[] = [
      {
        invoiceNumber: "INV-2026-0417",
        vendorName: "Acme Cloud Inc",
        total: 216,
        currency: "USD",
        issueDate: "2026-06-20",
        documentId: "doc-950",
        batchId: "batch-old",
        decision: "auto_approved",
        processedAt: "2026-06-21T00:00:00.000Z",
      },
    ];
    const ledger = makeLedger(bothWays);
    // The stub really does return the same row from both searches.
    expect(ledger.find("INV-2026-0417", BATCH_ID)).toHaveLength(1);
    expect(
      ledger.findSimilar({
        vendorName: "Acme Cloud Inc",
        total: 216,
        issueDate: "2026-07-03",
        windowDays: 90,
        excludeBatchId: BATCH_ID,
      }),
    ).toHaveLength(1);

    const issues = checkLedgerDuplicates(extracted(), ledger, BATCH_ID, DEFAULT_POLICY);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toContain("doc-950");
  });

  it("skips the near-duplicate search when there is nothing to match on", () => {
    let calls = 0;
    const base = makeLedger();
    const ledger: LedgerReader = {
      ...base,
      findSimilar: (q) => {
        calls += 1;
        return base.findSimilar(q);
      },
    };
    const issues = checkLedgerDuplicates(
      extracted({ invoiceNumber: null, vendorName: null, total: null, issueDate: null }),
      ledger,
      BATCH_ID,
      DEFAULT_POLICY,
    );
    expect(issues).toEqual([]);
    expect(calls).toBe(0);
  });

  it("ignores rows written by the current batch (re-runs are not duplicates)", () => {
    const sameBatchOnly = LEDGER_ENTRIES.filter((e) => e.batchId === BATCH_ID);
    expect(
      checkLedgerDuplicates(extracted(), makeLedger(sameBatchOnly), BATCH_ID, DEFAULT_POLICY),
    ).toEqual([]);
  });
});

describe("createTools", () => {
  let tools: ToolKit;

  beforeAll(async () => {
    const retriever = await PolicyRetriever.fromPolicy(DEFAULT_POLICY);
    tools = createTools({ ledger: makeLedger(), retriever, policy: DEFAULT_POLICY, batchId: BATCH_ID });
  });

  it("exposes four tools under the shared TOOL_NAMES", () => {
    expect(tools.all).toHaveLength(4);
    expect(tools.all.map((t) => t.name)).toEqual([
      TOOL_NAMES.recomputeTotals,
      TOOL_NAMES.lookupVendor,
      TOOL_NAMES.findDuplicates,
      TOOL_NAMES.searchPolicy,
    ]);
    expect(tools.all).toEqual([
      tools.recomputeTotals,
      tools.lookupVendor,
      tools.findDuplicates,
      tools.searchPolicy,
    ]);
    for (const t of tools.all) expect(t.description.length).toBeGreaterThan(20);
  });

  it("recompute_totals confirms the fixture and returns an object, not a string", async () => {
    const result = await tools.recomputeTotals.invoke({
      lineItems: FIXTURE_EXTRACTED.lineItems.map(({ quantity, unitPrice, amount }) => ({
        quantity,
        unitPrice,
        amount,
      })),
      subtotal: FIXTURE_EXTRACTED.subtotal,
      taxRate: FIXTURE_EXTRACTED.taxRate,
      taxAmount: FIXTURE_EXTRACTED.taxAmount,
      total: FIXTURE_EXTRACTED.total,
    });
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    expect(typeof result).toBe("object");
    // Must survive the JSON round-trip LangChain does when building a ToolMessage.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.computedLineSum).toBe(200);
    expect(result.computedTax).toBe(16);
    expect(result.computedTotal).toBe(216);
    expect(result.lineSumMatches).toBe(true);
    expect(result.totalMatches).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("recompute_totals flags a total that is off by 10", async () => {
    const result = await tools.recomputeTotals.invoke({
      lineItems: [{ quantity: 1, unitPrice: 200, amount: 200 }],
      subtotal: 200,
      taxRate: 0.08,
      taxAmount: 16,
      total: 226,
    });
    expect(result.totalMatches).toBe(false);
    expect(codes(result.issues)).toContain("TOTAL_MISMATCH");
  });

  it("lookup_vendor resolves the upper-cased legal name", async () => {
    const result = await tools.lookupVendor.invoke({ name: "ACME CLOUD INC" });
    expect(result.found).toBe(true);
    expect(result.vendorId).toBe("v-001");
    expect(result.canonicalName).toBe("Acme Cloud Inc");
    expect(result.approved).toBe(true);
    expect(result.defaultCategory).toBe("CLOUD_HOSTING");
    expect(typeof result.score).toBe("number");
  });

  it("lookup_vendor resolves a registry alias", async () => {
    expect((await tools.lookupVendor.invoke({ name: "Acme Cloud" })).vendorId).toBe("v-001");
    const northwind = await tools.lookupVendor.invoke({ name: "Northwind" });
    expect(northwind.vendorId).toBe("v-002");
    expect(northwind.matchedOn).toBe("alias");
  });

  it("lookup_vendor reports an off-registry vendor as not found", async () => {
    const result = await tools.lookupVendor.invoke({ name: "Totally Unknown GmbH" });
    expect(result.found).toBe(false);
    expect(result.vendorId).toBeUndefined();
  });

  it("find_duplicates returns exact, same-number-other-vendor and similar ledger rows", async () => {
    const result = await tools.findDuplicates.invoke({
      invoiceNumber: "INV-2026-0417",
      vendorName: "Acme Cloud Inc",
      total: 216,
      issueDate: "2026-07-03",
    });
    expect(result.exact.map((e: LedgerEntry) => e.documentId)).toEqual(["doc-900"]);
    expect(result.sameNumberOtherVendor).toEqual([]);
    expect(result.similar.map((e: LedgerEntry) => e.documentId)).toEqual(["doc-901"]);
  });

  it("find_duplicates reports a different vendor's reuse of the number separately from an exact hit", async () => {
    const other = createTools({
      ledger: makeLedger(LEDGER_ENTRIES),
      retriever: await PolicyRetriever.fromPolicy(DEFAULT_POLICY),
      policy: DEFAULT_POLICY,
      batchId: BATCH_ID,
    });
    const result = await other.findDuplicates.invoke({
      invoiceNumber: "INV-2026-0417",
      vendorName: "Northwind Software LLC",
      total: 216,
      issueDate: "2026-07-03",
    });
    expect(result.exact).toEqual([]);
    expect(result.sameNumberOtherVendor.map((e: LedgerEntry) => e.documentId)).toEqual(["doc-900"]);
    expect(result.similar).toEqual([]);
  });

  it("find_duplicates tolerates a null invoice number", async () => {
    const result = await tools.findDuplicates.invoke({
      invoiceNumber: null,
      vendorName: null,
      total: null,
      issueDate: null,
    });
    expect(result.exact).toEqual([]);
    expect(result.similar).toEqual([]);
  });

  it("search_policy returns no excerpts for a query that matches nothing", async () => {
    const result = await tools.searchPolicy.invoke({ query: "zzzz qqqq xyzzy" });
    expect(result.excerpts).toEqual([]);
  });

  it("search_policy drops the retriever's zero-score padding", async () => {
    const result = await tools.searchPolicy.invoke({ query: "purchase order required" });
    expect(result.excerpts).toHaveLength(1);
    for (const excerpt of result.excerpts) expect(excerpt.score).toBeGreaterThan(0);
  });

  it("search_policy returns scored excerpts tagged with their section", async () => {
    const result = await tools.searchPolicy.invoke({ query: "purchase order required" });
    expect(result.excerpts.length).toBeGreaterThan(0);
    expect(result.excerpts[0].section).toBe("Purchase orders");
    expect(result.excerpts[0].text).toContain("purchase order");
    expect(typeof result.excerpts[0].score).toBe("number");
  });
});
