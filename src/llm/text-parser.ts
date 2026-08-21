import type { ExtractedInvoice, ExtractedLineItem } from "../domain/schemas.js";

/**
 * Heuristic inverse of the three document renderers (plain / email / table).
 * Never throws: an unrecognised layout yields all-null fields and one warning.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const EMAIL_RE = /[^\s<>()[\],;:]+@[^\s<>()[\],;:]+\.[a-z]{2,}/i;

/**
 * Label regexes the plain and email layouts share verbatim.
 * No `g`/`y` flag, so they carry no `lastIndex` state and are safe as module constants.
 */
const CURRENCY_RE = /^Currency:\s*([A-Za-z]{3})\b/m;
const SUBTOTAL_RE = /^Subtotal:\s*(.+)$/m;
const TAX_LABEL_RE = /^(Tax\s*\(?\s*\d+(?:\.\d+)?\s*%\)?)\s*:/im;
const TAX_AMOUNT_RE = /^Tax[^:\n]*:\s*(.+)$/im;

/** Fields we expect every rendering to carry; each absent one costs confidence and adds a warning. */
const EXPECTED_FIELDS = [
  "invoiceNumber",
  "vendorName",
  "issueDate",
  "dueDate",
  "currency",
  "subtotal",
  "taxAmount",
  "total",
  "poNumber",
] as const;

const CONFIDENCE_COMPLETE = 0.92;
const CONFIDENCE_PARTIAL = 0.75;
const CONFIDENCE_UNKNOWN = 0.1;

type Draft = Omit<ExtractedInvoice, "confidence" | "warnings">;

export type ParsedDocumentFormat = "plain" | "email" | "table" | "unknown";

/** Which of the three renderers produced this text (best effort). */
export function detectFormat(text: string): ParsedDocumentFormat {
  if (/^\+-{10,}\+\s*$/m.test(text)) return "table";
  if (/^Subject:/m.test(text) || /^From:\s*\S+@\S+/m.test(text)) return "email";
  if (/^Invoice Number:/m.test(text) || /^Line Items:/m.test(text) || /^Total Due:/m.test(text)) return "plain";
  return "unknown";
}

/** Parses ISO, "DD Mon YYYY" and "MM/DD/YYYY" into YYYY-MM-DD; null when unreadable. */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const spelled = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(value);
  if (spelled) {
    const month = MONTHS[spelled[2]!.slice(0, 3).toLowerCase()];
    if (month) return ymd(Number(spelled[3]), month, Number(spelled[1]));
  }

  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (slashed) return ymd(Number(slashed[3]), Number(slashed[1]), Number(slashed[2]));

  return null;
}

function ymd(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** First number in the string, ignoring thousands separators and currency prefixes. */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const match = /-?\d+(?:\.\d+)?/.exec(raw.replace(/,/g, ""));
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/** "Tax (8%)" / "Tax 8%" / "TAX 8%" -> 0.08. */
function parseTaxRate(label: string | null): number | null {
  if (!label) return null;
  const match = /tax\s*\(?\s*(\d+(?:\.\d+)?)\s*%/i.exec(label);
  return match ? Number(match[1]) / 100 : null;
}

function firstMatch(text: string, re: RegExp): string | null {
  const match = re.exec(text);
  return match && match[1] !== undefined ? match[1].trim() : null;
}

function emptyDraft(): Draft {
  return {
    invoiceNumber: null,
    vendorName: null,
    vendorEmail: null,
    issueDate: null,
    dueDate: null,
    currency: null,
    lineItems: [],
    subtotal: null,
    taxRate: null,
    taxAmount: null,
    total: null,
    poNumber: null,
  };
}

/** Parses one of the three invoice renderings into the structured extraction shape. */
export function parseInvoiceText(text: string): ExtractedInvoice {
  const source = typeof text === "string" ? text : "";
  const format = detectFormat(source);

  let draft: Draft;
  if (format === "table") draft = parseTable(source);
  else if (format === "email") draft = parseEmail(source);
  else if (format === "plain") draft = parsePlain(source);
  else draft = emptyDraft();

  const recognised =
    format !== "unknown" &&
    (draft.invoiceNumber !== null || draft.vendorName !== null || draft.total !== null || draft.lineItems.length > 0);

  if (!recognised) {
    return { ...emptyDraft(), confidence: CONFIDENCE_UNKNOWN, warnings: ["Unrecognised document layout"] };
  }

  const missing = EXPECTED_FIELDS.filter((field) => draft[field] === null);
  const warnings = missing.map((field) => `Missing ${field} in document`);
  if (draft.lineItems.length === 0) warnings.push("No line items found in document");

  return {
    ...draft,
    confidence: warnings.length === 0 ? CONFIDENCE_COMPLETE : CONFIDENCE_PARTIAL,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Format "plain": label/value lines, ISO dates, "N. desc - qty x unit = amount"
// ---------------------------------------------------------------------------

function parsePlain(text: string): Draft {
  const draft = emptyDraft();
  const lines = text.split(/\r?\n/);

  draft.invoiceNumber = firstMatch(text, /^Invoice Number:\s*(.+)$/m);
  draft.issueDate = normalizeDate(firstMatch(text, /^Invoice Date:\s*(.+)$/m));
  draft.dueDate = normalizeDate(firstMatch(text, /^Due Date:\s*(.+)$/m));
  draft.poNumber = firstMatch(text, /^PO Number:\s*(.+)$/m);
  draft.currency = firstMatch(text, CURRENCY_RE)?.toUpperCase() ?? null;

  // Vendor block: the lines under a standalone "From:" label, up to the next blank line.
  const fromIndex = lines.findIndex((line) => line.trim() === "From:");
  if (fromIndex >= 0) {
    for (let i = fromIndex + 1; i < lines.length; i += 1) {
      const line = lines[i]!.trim();
      if (line === "" || /^Bill To:/i.test(line)) break;
      if (EMAIL_RE.test(line)) draft.vendorEmail ??= EMAIL_RE.exec(line)![0];
      else draft.vendorName ??= line;
    }
  }

  const itemRe = /^\s*\d+\.\s+(.+)\s+-\s+([\d.,]+)\s+x\s+([\d.,]+)\s+=\s+([\d.,]+)\s*$/;
  for (const line of lines) {
    const match = itemRe.exec(line);
    if (!match) continue;
    draft.lineItems.push(lineItem(match[1]!, match[2]!, match[3]!, match[4]!));
  }

  draft.subtotal = parseAmount(firstMatch(text, SUBTOTAL_RE));
  draft.taxRate = parseTaxRate(firstMatch(text, TAX_LABEL_RE));
  draft.taxAmount = parseAmount(firstMatch(text, TAX_AMOUNT_RE));
  draft.total = parseAmount(firstMatch(text, /^Total Due:\s*(.+)$/m));
  return draft;
}

// ---------------------------------------------------------------------------
// Format "email": RFC-822-ish headers, "DD Mon YYYY", "- desc | qty N | @ U | A"
// ---------------------------------------------------------------------------

function parseEmail(text: string): Draft {
  const draft = emptyDraft();
  const lines = text.split(/\r?\n/);

  const fromHeader = firstMatch(text, /^From:\s*(.+)$/m);
  if (fromHeader) draft.vendorEmail = EMAIL_RE.exec(fromHeader)?.[0] ?? null;

  draft.vendorName =
    firstMatch(text, /^Subject:.*\bfrom\s+(.+?)\s*$/im) ?? firstMatch(text, /^(.+?)\s+Billing\s*$/m);

  draft.invoiceNumber =
    firstMatch(text, /^Invoice\s*(?:#|No\.?|Number)?:\s*(.+)$/im) ??
    firstMatch(text, /^Subject:.*\bInvoice\s+(\S+)\s+from\b/im);

  draft.issueDate = normalizeDate(firstMatch(text, /^Date:\s*(.+)$/m));
  draft.dueDate = normalizeDate(firstMatch(text, /^Due:\s*(.+)$/m));
  draft.poNumber = firstMatch(text, /^PO:\s*(.+)$/m);
  draft.currency = firstMatch(text, CURRENCY_RE)?.toUpperCase() ?? null;

  const itemRe = /^-\s+(.+?)\s*\|\s*qty\s+([\d.,]+)\s*\|\s*@\s*([\d.,]+)\s*\|\s*([\d.,]+)\s*$/;
  for (const line of lines) {
    const match = itemRe.exec(line);
    if (!match) continue;
    draft.lineItems.push(lineItem(match[1]!, match[2]!, match[3]!, match[4]!));
  }

  draft.subtotal = parseAmount(firstMatch(text, SUBTOTAL_RE));
  draft.taxRate = parseTaxRate(firstMatch(text, TAX_LABEL_RE));
  draft.taxAmount = parseAmount(firstMatch(text, TAX_AMOUNT_RE));
  draft.total = parseAmount(firstMatch(text, /^Amount due:\s*(.+)$/im));
  return draft;
}

// ---------------------------------------------------------------------------
// Format "table": fixed-width box, MM/DD/YYYY dates, UPPER-CASE vendor header
// ---------------------------------------------------------------------------

const META_LABELS: Record<string, keyof Draft> = {
  "invoice no": "invoiceNumber",
  issued: "issueDate",
  due: "dueDate",
  po: "poNumber",
  currency: "currency",
};

function parseTable(text: string): Draft {
  const draft = emptyDraft();
  const rows: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s?(.*?)\s?\|$/.exec(line.trimEnd());
    if (match) rows.push(match[1]!);
  }

  let inHeader = true;
  for (const row of rows) {
    if (row.trim() === "") continue;

    // Totals row: first 40 columns are blank, then label + right-aligned amount.
    if (row.slice(0, 40).trim() === "") {
      inHeader = false;
      const label = row.slice(40, 50).trim();
      const amount = parseAmount(row.slice(50, 60));
      if (/^subtotal$/i.test(label)) draft.subtotal = amount;
      else if (/^tax\b/i.test(label)) {
        draft.taxRate = parseTaxRate(label);
        draft.taxAmount = amount;
      } else if (/^total$/i.test(label)) draft.total = amount;
      continue;
    }

    // Item row: numeric qty column plus a numeric amount column.
    const qty = row.slice(0, 6).trim();
    const amountCol = row.slice(50, 60).trim();
    if (/^\d/.test(qty) && /^[\d.,]+$/.test(amountCol)) {
      inHeader = false;
      draft.lineItems.push(lineItem(row.slice(6, 40).trim(), qty, row.slice(40, 50).trim(), amountCol));
      continue;
    }

    // Meta row: label.padEnd(13) + value.
    const metaKey = row.slice(0, 13).trim().toLowerCase();
    const metaValue = row.slice(13).trim();
    if (metaKey in META_LABELS && metaValue !== "") {
      inHeader = false;
      const field = META_LABELS[metaKey]!;
      if (field === "issueDate" || field === "dueDate") draft[field] = normalizeDate(metaValue);
      else if (field === "currency") draft.currency = metaValue.slice(0, 3).toUpperCase();
      else if (field === "invoiceNumber") draft.invoiceNumber = metaValue;
      else if (field === "poNumber") draft.poNumber = metaValue;
      continue;
    }

    if (!inHeader) continue;
    const trimmed = row.trim();
    if (EMAIL_RE.test(trimmed)) draft.vendorEmail ??= EMAIL_RE.exec(trimmed)![0];
    else draft.vendorName ??= stripInvoiceLabel(trimmed);
  }

  return draft;
}

/**
 * Drops the right-aligned INVOICE label from the table header row. The vendor column is
 * 53 chars wide, so a 53-char name leaves no whitespace at all before the label.
 */
function stripInvoiceLabel(row: string): string {
  const spaced = row.replace(/\s+INVOICE$/, "");
  if (spaced !== row) return spaced.trim();
  return row.endsWith("INVOICE") ? row.slice(0, -"INVOICE".length).trim() : row;
}

function lineItem(description: string, qty: string, unit: string, amount: string): ExtractedLineItem {
  return {
    description: description.trim(),
    quantity: parseAmount(qty),
    unitPrice: parseAmount(unit),
    amount: parseAmount(amount),
  };
}
