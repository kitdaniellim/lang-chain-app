import type { ProcessedInvoice } from "../domain/schemas.js";

export const CSV_COLUMNS = [
  "documentId",
  "invoiceNumber",
  "vendorName",
  "issueDate",
  "dueDate",
  "currency",
  "total",
  "category",
  "riskLevel",
  "riskScore",
  "decision",
  "decidedBy",
  "issues",
  "provider",
] as const;

/** Spreadsheets execute a cell starting with one of these, so the value gets an apostrophe prefix. */
const FORMULA_START_RE = /^\s*[=+\-@]/;

// Numeric cells are prefixed too — a negative total serialises as `'-12.50`, which OWASP's
// CSV-injection guidance prefers over letting a spreadsheet evaluate the leading `-`.

/** RFC-4180: quote when the value holds a comma, quote, CR/LF or edge whitespace; double inner quotes. */
function escapeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  if (raw === "") return "";
  const text = FORMULA_START_RE.test(raw) ? "'" + raw : raw;
  const needsQuotes = /[",\r\n]/.test(text) || text.trim() !== text;
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One CRLF-terminated row per processed invoice, in CSV_COLUMNS order. */
export function toCsv(processed: ProcessedInvoice[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const p of processed) {
    const e = p.extracted;
    const cells: Array<string | number | null> = [
      p.documentId,
      p.invoiceNumber,
      e?.vendorName ?? null,
      e?.issueDate ?? null,
      e?.dueDate ?? null,
      e?.currency ?? null,
      e?.total ?? null,
      p.categorization?.category ?? null,
      p.risk.level,
      p.risk.score,
      p.decision,
      p.decidedBy,
      p.issues.map((i) => i.code).join(","),
      p.provider,
    ];
    rows.push(cells.map(escapeCell).join(","));
  }
  return `${rows.join("\r\n")}\r\n`;
}
