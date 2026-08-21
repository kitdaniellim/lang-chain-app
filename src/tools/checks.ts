import type { LedgerReader } from "../data/ledger.types.js";
import { MONEY_TOLERANCE } from "../domain/constants.js";
import { DEFAULT_POLICY, type ApprovalPolicy } from "../domain/policy.js";
import type { Category, ExtractedInvoice, IssueCode, ValidationIssue } from "../domain/schemas.js";
import { findVendor, type VendorMatch } from "../domain/vendors.js";

/**
 * Deterministic checks. The LLM extracts and categorises; every arithmetic,
 * date, vendor, duplicate and policy verdict is decided here, in plain code.
 */

// ---------------------------------------------------------------------------
// Formatting + small helpers
// ---------------------------------------------------------------------------

/** "6000" -> "6,000.00" — how money is quoted in issue messages. */
const money = (n: number): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "5000" -> "5,000" — how policy thresholds are quoted. */
const threshold = (n: number): string => n.toLocaleString("en-US");

const round2 = (n: number): number => Math.round(n * 100) / 100;

const issue = (
  code: IssueCode,
  severity: ValidationIssue["severity"],
  message: string,
  field?: string,
): ValidationIssue => (field === undefined ? { code, severity, message } : { code, severity, message, field });

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a strict YYYY-MM-DD date to epoch ms (UTC); null when malformed. */
function parseIsoDate(value: string | null): number | null {
  if (!value || !ISO_DATE_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface TotalsLineItem {
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
}

export interface TotalsInput {
  lineItems: TotalsLineItem[];
  subtotal: number | null;
  taxRate: number | null;
  taxAmount: number | null;
  total: number | null;
}

export interface TotalsResult {
  /** Sum of the line amounts that were actually present. */
  computedLineSum: number;
  /** Printed tax, or subtotal x taxRate when only the rate is printed; null when neither is available. */
  computedTax: number | null;
  /** subtotal + computedTax; null when either input is missing. */
  computedTotal: number | null;
  /** True/false when the line sum could be compared with the printed subtotal; null when it could not be checked. */
  lineSumMatches: boolean | null;
  /** True/false when subtotal + tax could be compared with the printed total; null when it could not be checked. */
  totalMatches: boolean | null;
  issues: ValidationIssue[];
}

/**
 * Re-derive an invoice's arithmetic from its parts and compare with what was printed.
 * Missing inputs become MISSING_FIELD warnings; they never produce a mismatch.
 */
export function computeTotals(input: TotalsInput): TotalsResult {
  const issues: ValidationIssue[] = [];

  let lineSum = 0;
  let missingAmounts = 0;
  input.lineItems.forEach((item, index) => {
    if (item.amount === null || item.amount === undefined) {
      missingAmounts += 1;
      issues.push(
        issue(
          "MISSING_FIELD",
          "warning",
          `Line item ${index + 1} has no amount, so it is excluded from the line sum`,
          `lineItems[${index}].amount`,
        ),
      );
      return;
    }
    lineSum += item.amount;
  });
  const computedLineSum = round2(lineSum);

  const computedTax =
    input.taxAmount !== null
      ? input.taxAmount
      : input.subtotal !== null && input.taxRate !== null
        ? round2(input.subtotal * input.taxRate)
        : null;
  const computedTotal =
    input.subtotal !== null && computedTax !== null ? round2(input.subtotal + computedTax) : null;

  if (input.lineItems.length === 0) {
    issues.push(
      issue("MISSING_FIELD", "warning", "No line items were extracted, so the subtotal cannot be verified", "lineItems"),
    );
  }

  // Line sum vs printed subtotal. A partial sum cannot be compared honestly, so it stays null.
  let lineSumMatches: boolean | null = null;
  if (input.subtotal === null) {
    issues.push(issue("MISSING_FIELD", "warning", "Subtotal is missing from the document", "subtotal"));
  } else if (missingAmounts === 0 && input.lineItems.length > 0) {
    lineSumMatches = Math.abs(computedLineSum - input.subtotal) <= MONEY_TOLERANCE;
    if (!lineSumMatches) {
      issues.push(
        issue(
          "LINE_SUM_MISMATCH",
          "error",
          `Line items sum to ${money(computedLineSum)} but the printed subtotal is ${money(input.subtotal)}`,
          "subtotal",
        ),
      );
    }
  }

  // subtotal + tax vs printed total. Without a tax basis the total cannot be checked at all.
  let totalMatches: boolean | null = null;
  if (input.total === null) {
    issues.push(issue("MISSING_FIELD", "warning", "Total is missing from the document", "total"));
  } else if (computedTax === null) {
    issues.push(
      issue(
        "MISSING_FIELD",
        "warning",
        `Neither a tax amount nor a tax rate was found, so the printed total ${money(input.total)} could not be verified`,
        "taxAmount",
      ),
    );
  } else if (computedTotal !== null) {
    totalMatches = Math.abs(computedTotal - input.total) <= MONEY_TOLERANCE;
    if (!totalMatches) {
      issues.push(
        issue(
          "TOTAL_MISMATCH",
          "error",
          `Subtotal plus tax is ${money(computedTotal)} but the printed total is ${money(input.total)}`,
          "total",
        ),
      );
    }
  }

  return { computedLineSum, computedTax, computedTotal, lineSumMatches, totalMatches, issues };
}

/** Arithmetic verdict for an extraction. */
export function checkTotals(extracted: ExtractedInvoice): ValidationIssue[] {
  return computeTotals(extracted).issues;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Issue/due date sanity: presence, format, and ordering. */
export function checkDates(extracted: ExtractedInvoice): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (extracted.issueDate === null) {
    issues.push(issue("MISSING_FIELD", "warning", "Issue date is missing from the document", "issueDate"));
  }
  if (extracted.dueDate === null) {
    issues.push(issue("MISSING_DUE_DATE", "warning", "No due date was found on the invoice", "dueDate"));
  }

  const issued = parseIsoDate(extracted.issueDate);
  const due = parseIsoDate(extracted.dueDate);

  if (extracted.issueDate !== null && issued === null) {
    issues.push(
      issue(
        "MISSING_FIELD",
        "warning",
        `Issue date "${extracted.issueDate}" is not a valid YYYY-MM-DD date`,
        "issueDate",
      ),
    );
  }
  if (extracted.dueDate !== null && due === null) {
    issues.push(
      issue(
        "MISSING_FIELD",
        "warning",
        `Due date "${extracted.dueDate}" is not a valid YYYY-MM-DD date`,
        "dueDate",
      ),
    );
  }

  if (issued !== null && due !== null && due < issued) {
    issues.push(
      issue(
        "DUE_BEFORE_ISSUE",
        "error",
        `Due date ${extracted.dueDate} is earlier than the issue date ${extracted.issueDate}`,
        "dueDate",
      ),
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------

/** Resolve the vendor against the approved registry. */
export function checkVendor(extracted: ExtractedInvoice): {
  issues: ValidationIssue[];
  match: VendorMatch | null;
} {
  const issues: ValidationIssue[] = [];

  if (extracted.vendorName === null) {
    issues.push(issue("MISSING_FIELD", "warning", "Vendor name is missing from the document", "vendorName"));
    issues.push(
      issue("UNKNOWN_VENDOR", "error", "No vendor name to match against the approved registry", "vendorName"),
    );
    return { issues, match: null };
  }

  const match = findVendor(extracted.vendorName);
  if (match === null) {
    issues.push(
      issue(
        "UNKNOWN_VENDOR",
        "error",
        `Vendor "${extracted.vendorName}" is not in the approved vendor registry`,
        "vendorName",
      ),
    );
    return { issues, match: null };
  }

  if (!match.vendor.approved) {
    issues.push(
      issue(
        "UNKNOWN_VENDOR",
        "error",
        `Vendor "${match.vendor.name}" (${match.vendor.id}) is in the registry but is not approved for payment`,
        "vendorName",
      ),
    );
  }

  return { issues, match };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Approval-policy verdicts: thresholds, PO requirement, currency, confidence. */
export function checkPolicy(
  extracted: ExtractedInvoice,
  category: Category | null,
  policy: ApprovalPolicy = DEFAULT_POLICY,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const reviewLimit =
    (category !== null ? policy.categoryReviewThresholds[category] : undefined) ?? policy.reviewThreshold;

  if (extracted.total !== null) {
    if (extracted.total >= reviewLimit) {
      issues.push(
        issue(
          "OVER_REVIEW_THRESHOLD",
          "warning",
          `Total ${money(extracted.total)} is at or above the ${threshold(reviewLimit)} review threshold`,
          "total",
        ),
      );
    }
    if (extracted.total >= policy.cfoThreshold) {
      issues.push(
        issue(
          "OVER_CFO_THRESHOLD",
          "warning",
          `Total ${money(extracted.total)} is at or above the ${threshold(policy.cfoThreshold)} CFO sign-off threshold`,
          "total",
        ),
      );
    }
    if (extracted.total >= policy.poRequiredAbove && !extracted.poNumber) {
      issues.push(
        issue(
          "MISSING_PO",
          "warning",
          `Total ${money(extracted.total)} is at or above the ${threshold(policy.poRequiredAbove)} PO threshold but no purchase order number was found`,
          "poNumber",
        ),
      );
    }
  }

  if (extracted.currency === null) {
    issues.push(
      issue("MISSING_FIELD", "warning", "Currency is missing, so the invoice cannot be confirmed as base currency", "currency"),
    );
  } else if (extracted.currency !== policy.baseCurrency) {
    issues.push(
      issue(
        "FOREIGN_CURRENCY",
        "warning",
        `Invoice is billed in ${extracted.currency}, not the ${policy.baseCurrency} base currency`,
        "currency",
      ),
    );
  }

  if (extracted.confidence < policy.minExtractionConfidence) {
    issues.push(
      issue(
        "LOW_CONFIDENCE",
        "warning",
        `Extraction confidence ${extracted.confidence.toFixed(2)} is below the ${policy.minExtractionConfidence} minimum`,
        "confidence",
      ),
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Ledger duplicates
// ---------------------------------------------------------------------------

/** A near-duplicate search needs a vendor, an amount and a date to centre the window on. */
export function canSearchSimilar(fields: {
  vendorName: string | null;
  total: number | null;
  issueDate: string | null;
}): boolean {
  return fields.vendorName !== null && fields.total !== null && fields.issueDate !== null;
}

/** Ledger rows are identified by (batchId, documentId) — a document id alone repeats across batches. */
const rowId = (entry: { batchId: string; documentId: string }): string =>
  JSON.stringify([entry.batchId, entry.documentId]);

/**
 * Duplicate checks against the payment ledger. Only the same invoice number from the
 * same vendor is a real duplicate payment (error); the same number from a *different*
 * vendor, and a same-vendor same-amount hit inside the window, are warnings a human decides.
 */
export function checkLedgerDuplicates(
  extracted: ExtractedInvoice,
  ledger: LedgerReader,
  batchId: string,
  policy: ApprovalPolicy = DEFAULT_POLICY,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const number = extracted.invoiceNumber;

  const exact =
    number === null
      ? []
      : ledger.findExact({ invoiceNumber: number, vendorName: extracted.vendorName, excludeBatchId: batchId });
  const first = exact[0];
  if (first) {
    issues.push(
      issue(
        "DUPLICATE_IN_LEDGER",
        "error",
        `Invoice number ${number} from ${first.vendorName ?? "an unnamed vendor"} already appears in the ledger (${exact.length} row(s); first: document ${first.documentId} from batch ${first.batchId}, ${first.decision})`,
        "invoiceNumber",
      ),
    );
  }

  const exactIds = new Set(exact.map(rowId));

  // Same number, different vendor: suspicious enough for a human, never enough to auto-reject.
  const otherVendor = (number === null ? [] : ledger.find(number, batchId)).filter((e) => !exactIds.has(rowId(e)));
  const otherFirst = otherVendor[0];
  if (otherFirst) {
    issues.push(
      issue(
        "DUPLICATE_IN_LEDGER",
        "warning",
        `Invoice number ${number} already used by vendor ${otherFirst.vendorName ?? "(unnamed)"} (document ${otherFirst.documentId} from batch ${otherFirst.batchId})`,
        "invoiceNumber",
      ),
    );
  }

  // Rows already reported as exact hits must not be reported a second time as near duplicates.
  const similar = (
    canSearchSimilar(extracted)
      ? ledger.findSimilar({
          vendorName: extracted.vendorName,
          total: extracted.total,
          issueDate: extracted.issueDate,
          windowDays: policy.duplicateWindowDays,
          excludeBatchId: batchId,
        })
      : []
  ).filter((entry) => !exactIds.has(rowId(entry)));
  const closest = similar[0];
  if (closest) {
    issues.push(
      issue(
        "DUPLICATE_IN_LEDGER",
        "warning",
        `Possible duplicate: ${similar.length} ledger row(s) from ${closest.vendorName ?? "the same vendor"} for ${closest.total === null ? "the same amount" : money(closest.total)} within ${policy.duplicateWindowDays} days (first: ${closest.invoiceNumber}, issued ${closest.issueDate ?? "unknown"})`,
        "invoiceNumber",
      ),
    );
  }

  return issues;
}
