/**
 * SHARED FIXTURE — three processed invoices covering the decision spectrum.
 * Reused by report, sink, stats and pipeline tests; keep the numbers in sync with `stats`.
 */
import type { BatchResult, ProcessedInvoice } from "../../src/domain/schemas.js";

const APPROVED: ProcessedInvoice = {
  documentId: "doc-001",
  invoiceNumber: "INV-2026-0417",
  extracted: {
    invoiceNumber: "INV-2026-0417",
    vendorName: "Acme Cloud Inc",
    vendorEmail: "billing@acmecloud.example",
    issueDate: "2026-07-03",
    dueDate: "2026-08-02",
    currency: "USD",
    lineItems: [
      // Comma in the description exercises CSV/table quoting downstream.
      { description: "Compute hours, c5.large", quantity: 120, unitPrice: 0.45, amount: 54 },
      { description: "Object storage 2 TB", quantity: 2, unitPrice: 23, amount: 46 },
      { description: "Support plan - Business", quantity: 1, unitPrice: 100, amount: 100 },
    ],
    subtotal: 200,
    taxRate: 0.08,
    taxAmount: 16,
    total: 216,
    poNumber: "PO-48213",
    confidence: 0.96,
    warnings: [],
  },
  issues: [],
  categorization: {
    category: "CLOUD_HOSTING",
    glAccount: "6110",
    confidence: 0.94,
    rationale: "Compute hours and object storage are hosting spend.",
  },
  risk: { score: 5, level: "low", reasons: [] },
  investigation: null,
  decision: "auto_approved",
  decidedBy: "system",
  reviewerNote: null,
  provider: "fake",
  timings: { extract: 12, validate: 1, categorize: 8 },
};

/** One processed invoice; defaults to the clean auto-approved CLOUD_HOSTING invoice. */
export function makeProcessed(overrides: Partial<ProcessedInvoice> = {}): ProcessedInvoice {
  return { ...structuredClone(APPROVED), ...overrides };
}

function rejectedByHuman(): ProcessedInvoice {
  const base = structuredClone(APPROVED);
  return makeProcessed({
    documentId: "doc-002",
    invoiceNumber: "INV-2026-0418",
    extracted: {
      ...base.extracted!,
      invoiceNumber: "INV-2026-0418",
      // Comma in the vendor name must be quoted by the CSV renderer.
      vendorName: "Globex Consulting, LLC",
      vendorEmail: "ar@globex.example",
      currency: "EUR",
      subtotal: 1300,
      taxRate: 0.08,
      taxAmount: 104,
      total: 1450.5,
      poNumber: null,
      confidence: 0.71,
      warnings: ["Totals line partially illegible"],
    },
    issues: [
      { code: "TOTAL_MISMATCH", severity: "error", message: "Printed total 1450.50 != subtotal + tax 1404.00", field: "total" },
      { code: "UNKNOWN_VENDOR", severity: "error", message: "Vendor is not in the approved registry", field: "vendorName" },
    ],
    categorization: {
      category: "PROFESSIONAL_SERVICES",
      glAccount: "6300",
      confidence: 0.82,
      rationale: "Advisory engagement hours.",
    },
    risk: { score: 72, level: "high", reasons: ["Total mismatch", "Unknown vendor"] },
    investigation: {
      brief: 'Recomputed total is 1404.00 & the vendor "Globex" is unregistered. Recommend rejection.',
      recommendation: "reject",
      confidence: 0.88,
      toolsUsed: ["recompute_totals", "lookup_vendor"],
    },
    decision: "rejected_by_human",
    decidedBy: "human",
    reviewerNote: "Sent back to the vendor for a corrected invoice.",
    timings: { extract: 21, validate: 2, categorize: 9, investigate: 140, review: 4200 },
  });
}

function autoRejected(): ProcessedInvoice {
  const base = structuredClone(APPROVED);
  return makeProcessed({
    documentId: "doc-003",
    invoiceNumber: "INV-2026-0417",
    extracted: {
      ...base.extracted!,
      vendorName: "Initech Software",
      vendorEmail: "billing@initech.example",
      subtotal: 92,
      taxRate: 0.08,
      taxAmount: 7,
      total: 99,
      poNumber: "PO-48999",
      confidence: 0.9,
      warnings: [],
    },
    issues: [
      { code: "DUPLICATE_IN_BATCH", severity: "error", message: "INV-2026-0417 already seen on doc-001", field: "invoiceNumber" },
    ],
    categorization: { category: "SOFTWARE", glAccount: "6100", confidence: 0.91, rationale: "Seat licences." },
    risk: { score: 60, level: "medium", reasons: ["Duplicate invoice number"] },
    investigation: null,
    decision: "auto_rejected",
    decidedBy: "system",
    reviewerNote: null,
    timings: { extract: 15, validate: 1, categorize: 7 },
  });
}

/**
 * A three-invoice batch: auto-approved, human-rejected, auto-rejected.
 * `stats` is hard-coded and NOT recomputed when you override `processed` — pass matching `stats` too.
 */
export function makeBatchResult(overrides: Partial<BatchResult> = {}): BatchResult {
  const processed = [makeProcessed(), rejectedByHuman(), autoRejected()];
  return {
    batchId: "batch-2026-08-20-test",
    threadId: "thread-test-001",
    startedAt: "2026-08-20T09:00:00.000Z",
    finishedAt: "2026-08-20T09:00:12.500Z",
    provider: "fake",
    processed,
    stats: {
      total: 3,
      autoApproved: 1,
      approvedByHuman: 0,
      rejectedByHuman: 1,
      autoRejected: 1,
      needsReview: 0,
      approvedAmount: 216,
      totalAmount: 1765.5,
      byCategory: { CLOUD_HOSTING: 1, PROFESSIONAL_SERVICES: 1, SOFTWARE: 1 },
      issuesByCode: { TOTAL_MISMATCH: 1, UNKNOWN_VENDOR: 1, DUPLICATE_IN_BATCH: 1 },
    },
    summary: 'Processed 3 invoices: 1 auto-approved & 2 rejected. Watch <Globex> for "duplicate" filings.',
    deliveries: [],
    ...overrides,
  };
}
