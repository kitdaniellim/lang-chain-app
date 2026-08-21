import type { Category } from "./schemas.js";

/**
 * Approval policy — the single source of truth for enforcement.
 * `renderPolicyDocument` turns it into the prose the RAG retriever indexes,
 * so the text the agent quotes can never drift from the numbers the code enforces.
 */
export interface ApprovalPolicy {
  baseCurrency: "USD";
  /** Totals at or above this need a human reviewer. */
  reviewThreshold: number;
  /** Totals at or above this need CFO sign-off (still routed to the same review queue, flagged). */
  cfoThreshold: number;
  /** Totals at or above this must reference a purchase order. */
  poRequiredAbove: number;
  /** Stricter review thresholds for specific categories. */
  categoryReviewThresholds: Partial<Record<Category, number>>;
  unknownVendorsRequireReview: boolean;
  /** Days back the duplicate check looks for similar invoices. */
  duplicateWindowDays: number;
  /** Extractions below this confidence are flagged. */
  minExtractionConfidence: number;
}

export const DEFAULT_POLICY: ApprovalPolicy = {
  baseCurrency: "USD",
  reviewThreshold: 5_000,
  cfoThreshold: 25_000,
  poRequiredAbove: 2_000,
  categoryReviewThresholds: {
    TRAVEL: 3_000,
    MARKETING: 4_000,
    EQUIPMENT: 4_000,
  },
  unknownVendorsRequireReview: true,
  duplicateWindowDays: 90,
  minExtractionConfidence: 0.6,
};

const money = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Markdown policy handbook. Each `##` section becomes one retrievable chunk. */
export function renderPolicyDocument(policy: ApprovalPolicy = DEFAULT_POLICY): string {
  const categoryLines = Object.entries(policy.categoryReviewThresholds)
    .map(([category, limit]) => `- ${category.replace(/_/g, " ")}: invoices of ${money(limit!)} or more require manager review.`)
    .join("\n");

  return `# Accounts Payable Approval Policy

## Approval thresholds
Invoices below ${money(policy.reviewThreshold)} may be auto-approved when they pass all data-quality checks.
Invoices of ${money(policy.reviewThreshold)} or more require review by an accounts-payable manager before payment.
Invoices of ${money(policy.cfoThreshold)} or more additionally require CFO sign-off and must be escalated.

## Purchase orders
Any invoice of ${money(policy.poRequiredAbove)} or more must reference a valid purchase order (PO) number.
Invoices above that amount without a PO must be held for review and the vendor contacted.

## Vendors
Only vendors in the approved vendor registry may be paid automatically.
Invoices from vendors that are not in the registry ${policy.unknownVendorsRequireReview ? "always require" : "do not require"} human review, regardless of amount.
Vendor names may vary slightly (trading names, suffixes such as Inc or LLC); registry aliases are authoritative.

## Duplicates
An invoice number that already appears in the payment ledger must be rejected as a duplicate.
Invoices from the same vendor for the same amount within ${policy.duplicateWindowDays} days are suspicious and must be reviewed.
Within a single batch, the first occurrence of an invoice number is processed and later occurrences are rejected.

## Category-specific limits
${categoryLines}

## Data quality
Line items must sum to the subtotal and subtotal plus tax must equal the total; arithmetic mismatches block auto-approval.
A due date earlier than the issue date is a data error and blocks auto-approval.
Extractions with confidence below ${policy.minExtractionConfidence} are flagged for review.
Invoices billed in a currency other than ${policy.baseCurrency} are flagged for treasury conversion but are not errors.
`;
}
