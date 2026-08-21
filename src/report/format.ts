import type { ProcessedInvoice } from "../domain/schemas.js";

/** Shared by every renderer so the console, HTML and Markdown reports never drift. */
export const NO_VALUE = "—";

/** Two-decimal amount with thousands separators. */
export function formatAmount(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return NO_VALUE;
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Per-invoice money cell, e.g. `1,450.50 EUR`. */
export function money(amount: number | null | undefined, currency?: string | null): string {
  const text = formatAmount(amount);
  return text === NO_VALUE || !currency ? text : `${text} ${currency}`;
}

export interface CurrencyLabel {
  currencies: string[];
  /** `"USD "` when the batch is single-currency, otherwise empty. */
  prefix: string;
  /** Warning appended once when the batch mixes currencies, otherwise empty. */
  note: string;
}

/** The label for an already-collected currency list; shared with the summary prompt. */
export function currencyLabelFrom(currencies: string[]): CurrencyLabel {
  if (currencies.length === 1) return { currencies, prefix: `${currencies[0]} `, note: "" };
  if (currencies.length > 1) {
    return { currencies, prefix: "", note: ` (mixed currencies: ${currencies.join(", ")} — summed as printed)` };
  }
  return { currencies, prefix: "", note: "" };
}

/**
 * `BatchStats` sums are currency-blind, so the renderers must say which currency a figure is in —
 * or warn that several were added together.
 */
export function currencyLabel(processed: ProcessedInvoice[]): CurrencyLabel {
  const seen = new Set<string>();
  for (const p of processed) {
    const currency = p.extracted?.currency;
    if (currency) seen.add(currency);
  }
  return currencyLabelFrom([...seen]);
}

/** A standalone batch figure carrying its own currency label. */
export function batchAmount(amount: number, label: CurrencyLabel): string {
  return `${label.prefix}${formatAmount(amount)}${label.note}`;
}

/** Invoices worth calling out: anything with an issue or not cleanly approved. */
export function needsAttention(p: ProcessedInvoice): boolean {
  return p.issues.length > 0 || (p.decision !== "auto_approved" && p.decision !== "approved_by_human");
}

/** Null when either timestamp is unparsable, so renderers can print `n/a` instead of `NaN`. */
export function durationSeconds(startedAt: string, finishedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start) / 1000;
}

export function formatDuration(startedAt: string, finishedAt: string): string {
  const seconds = durationSeconds(startedAt, finishedAt);
  return seconds === null ? "n/a" : `${seconds.toFixed(1)}s`;
}
