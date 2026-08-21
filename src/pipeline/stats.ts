import type { BatchStats, ProcessedInvoice } from "../domain/schemas.js";

/** Decisions that mean the invoice is cleared for payment. */
const APPROVED_DECISIONS = new Set(["auto_approved", "approved_by_human"]);

/** Rolls a processed batch up into the counts, sums and histograms the reports render. */
export function computeStats(processed: ProcessedInvoice[]): BatchStats {
  const stats: BatchStats = {
    total: processed.length,
    autoApproved: 0,
    approvedByHuman: 0,
    rejectedByHuman: 0,
    autoRejected: 0,
    needsReview: 0,
    approvedAmount: 0,
    totalAmount: 0,
    byCategory: {},
    issuesByCode: {},
  };

  for (const invoice of processed) {
    switch (invoice.decision) {
      case "auto_approved":
        stats.autoApproved += 1;
        break;
      case "approved_by_human":
        stats.approvedByHuman += 1;
        break;
      case "rejected_by_human":
        stats.rejectedByHuman += 1;
        break;
      case "auto_rejected":
        stats.autoRejected += 1;
        break;
      case "needs_review":
        stats.needsReview += 1;
        break;
    }

    const total = invoice.extracted?.total;
    if (total !== null && total !== undefined) {
      stats.totalAmount += total;
      if (APPROVED_DECISIONS.has(invoice.decision)) stats.approvedAmount += total;
    }

    const category = invoice.categorization?.category;
    if (category) stats.byCategory[category] = (stats.byCategory[category] ?? 0) + 1;

    for (const issue of invoice.issues) {
      stats.issuesByCode[issue.code] = (stats.issuesByCode[issue.code] ?? 0) + 1;
    }
  }

  // Money sums accumulate float error; snap back to cents.
  stats.totalAmount = round2(stats.totalAmount);
  stats.approvedAmount = round2(stats.approvedAmount);
  return stats;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
