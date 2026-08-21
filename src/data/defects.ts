import { faker } from "@faker-js/faker";
import type { ApprovalPolicy } from "../domain/policy.js";
import type { DefectCode, Invoice, LineItem } from "../domain/schemas.js";
import { findVendor } from "../domain/vendors.js";
import type { Rng } from "./rng.js";

export interface DefectContext {
  /** Invoices already generated in this batch — the source for DUPLICATE_NUMBER. */
  earlier: Invoice[];
  policy: ApprovalPolicy;
}

/** Every money value in the corpus is rounded to cents through this helper. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Shifts an ISO date by whole days in UTC so results never depend on the host timezone. */
export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const sumLineAmounts = (items: readonly LineItem[]): number =>
  round2(items.reduce((sum, item) => sum + item.amount, 0));

/** Recomputes subtotal/tax/total from the line items — the "correct" arithmetic. */
export function withRecomputedTotals(invoice: Invoice, lineItems: LineItem[]): Invoice {
  const subtotal = sumLineAmounts(lineItems);
  const taxAmount = round2(subtotal * invoice.taxRate);
  return { ...invoice, lineItems, subtotal, taxAmount, total: round2(subtotal + taxAmount) };
}

/**
 * Rescales the invoice so its total lands inside [lo, hi]: quantities scale first,
 * then unit prices absorb the integer-rounding residue so the target is hit to the cent.
 */
function rescaleTotalInto(invoice: Invoice, lo: number, hi: number, rng: Rng): Invoice {
  const targetTotal = lo + (hi - lo) * (0.05 + 0.9 * rng.next());
  const targetSubtotal = targetTotal / (1 + invoice.taxRate);
  const current = sumLineAmounts(invoice.lineItems) || 1;

  const scaled = invoice.lineItems.map((item) => {
    const wanted = item.quantity * (targetSubtotal / current);
    const quantity = Math.max(1, Math.round(wanted));
    return { ...item, quantity, amount: round2(quantity * item.unitPrice) };
  });

  const residue = targetSubtotal / (sumLineAmounts(scaled) || 1);
  const lineItems = scaled.map((item) => {
    const unitPrice = Math.max(round2(item.unitPrice * residue), 0.01);
    return { ...item, unitPrice, amount: round2(item.quantity * unitPrice) };
  });

  return withRecomputedTotals(invoice, lineItems);
}

/** A company name the vendor registry will not match, so UNKNOWN_VENDOR really is unknown. */
function unknownVendorName(): string {
  let name = faker.company.name();
  for (let attempt = 0; attempt < 8 && findVendor(name) !== null; attempt++) name = faker.company.name();
  return name;
}

const FOREIGN_CURRENCIES = ["EUR", "GBP", "PHP"] as const;

/**
 * Injects one defect and appends its code to `invoice.defects`.
 * Pure: the input invoice is never mutated. DUPLICATE_NUMBER without an earlier
 * invoice is a no-op (the invoice stays clean) so callers can try the next code.
 */
export function applyDefect(invoice: Invoice, code: DefectCode, rng: Rng, ctx: DefectContext): Invoice {
  const tag = (next: Invoice): Invoice => ({ ...next, defects: [...invoice.defects, code] });

  switch (code) {
    case "MATH_MISMATCH":
      return tag({ ...invoice, total: round2(invoice.total + rng.int(5, 60)) });

    case "LINE_SUM_MISMATCH": {
      const subtotal = round2(invoice.subtotal + rng.int(3, 30));
      const taxAmount = round2(subtotal * invoice.taxRate);
      return tag({ ...invoice, subtotal, taxAmount, total: round2(subtotal + taxAmount) });
    }

    case "DUE_BEFORE_ISSUE":
      return tag({ ...invoice, dueDate: addDays(invoice.issueDate, -5) });

    case "MISSING_DUE_DATE":
      return tag({ ...invoice, dueDate: null });

    case "DUPLICATE_NUMBER": {
      if (ctx.earlier.length === 0) return invoice;
      const source = rng.pick(ctx.earlier);
      const copied = tag({ ...invoice, invoiceNumber: source.invoiceNumber, vendor: { ...source.vendor } });
      // The copied vendor may itself be unregistered - record that so ground truth matches the document.
      if (findVendor(source.vendor.name) !== null || copied.defects.includes("UNKNOWN_VENDOR")) return copied;
      return { ...copied, defects: [...copied.defects, "UNKNOWN_VENDOR"] };
    }

    case "UNKNOWN_VENDOR": {
      const name = unknownVendorName();
      return tag({
        ...invoice,
        vendor: {
          name,
          email: faker.internet.email({ firstName: "billing", provider: "unknown-vendor.example" }).toLowerCase(),
          address: faker.location.streetAddress({ useFullAddress: true }),
        },
      });
    }

    case "OVER_THRESHOLD":
      return tag(rescaleTotalInto(invoice, ctx.policy.reviewThreshold * 1.2, ctx.policy.cfoThreshold * 1.5, rng));

    case "MISSING_PO": {
      const rescaled = rescaleTotalInto(invoice, ctx.policy.poRequiredAbove * 1.05, ctx.policy.reviewThreshold * 0.95, rng);
      return tag({ ...rescaled, poNumber: null });
    }

    case "FOREIGN_CURRENCY":
      return tag({ ...invoice, currency: rng.pick(FOREIGN_CURRENCIES) });
  }
}

/**
 * Defects are applied in this order so a second code cannot erase the first
 * (amount rewrites first, then arithmetic corruption, then dates).
 */
export const DEFECT_APPLY_ORDER: readonly DefectCode[] = [
  "OVER_THRESHOLD",
  "MISSING_PO",
  "FOREIGN_CURRENCY",
  "UNKNOWN_VENDOR",
  "DUPLICATE_NUMBER",
  "LINE_SUM_MISMATCH",
  "MATH_MISMATCH",
  "DUE_BEFORE_ISSUE",
  "MISSING_DUE_DATE",
];

/** Pairs that would cancel each other out and are therefore never combined. */
const CONFLICTS: Partial<Record<DefectCode, readonly DefectCode[]>> = {
  OVER_THRESHOLD: ["MISSING_PO"],
  MISSING_PO: ["OVER_THRESHOLD"],
  UNKNOWN_VENDOR: ["DUPLICATE_NUMBER"],
  DUPLICATE_NUMBER: ["UNKNOWN_VENDOR"],
  DUE_BEFORE_ISSUE: ["MISSING_DUE_DATE"],
  MISSING_DUE_DATE: ["DUE_BEFORE_ISSUE"],
};

export function defectsConflict(a: DefectCode, b: DefectCode): boolean {
  return a === b || (CONFLICTS[a]?.includes(b) ?? false);
}
