// Locale-aware money/date/number formatting with safe fallbacks for bad data.

const currencyFormatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string): Intl.NumberFormat | null {
  const code = currency?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(code)) return null;
  const cached = currencyFormatters.get(code);
  if (cached) return cached;
  try {
    const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency: code });
    currencyFormatters.set(code, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/** Money as a localized currency string; falls back to `1,234.50 XYZ` for invalid codes. */
export function formatMoney(amount: number, currency: string): string {
  const value = Number.isFinite(amount) ? amount : 0;
  const formatter = currencyFormatter(currency);
  if (formatter) return formatter.format(value);
  const plain = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  const code = currency?.trim() ? ` ${currency.trim().toUpperCase()}` : "";
  return `${plain}${code}`;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

/** ISO date (or datetime) to a short localized date; returns a hyphen when absent. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const parsed = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return dateFormatter.format(parsed);
}

/** Quantities: up to 2 decimals, no trailing zeros. */
export function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

/** Parses a user-typed number, returning `fallback` for blank or non-numeric input. */
export function parseNumber(value: string, fallback = 0): number {
  const parsed = Number.parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}
