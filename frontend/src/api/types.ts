// Wire types mirroring backend/app/schemas.py — snake_case is kept exactly as sent.

export type InvoiceStatus = "paid" | "pending" | "overdue";

export type InvoiceSource = "seed" | "extracted" | "seed-fallback" | "uploaded" | "imported";

export interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

/** The structured-extraction target Claude fills in (schemas.Invoice). */
export interface Invoice {
  invoice_number: string;
  vendor_name: string;
  vendor_email: string | null;
  invoice_date: string; // ISO date, YYYY-MM-DD
  due_date: string | null;
  currency: string;
  line_items: LineItem[];
  subtotal: number;
  tax: number;
  total: number;
  po_number: string | null;
  status: InvoiceStatus;
}

/** Body of POST /invoices — the extracted invoice, possibly edited by the user. */
export interface InvoiceDraft extends Invoice {
  raw_text?: string | null;
}

/** A stored row returned by GET /invoices and POST /invoices. */
export interface InvoiceOut extends Invoice {
  id: number;
  needs_review: boolean;
  review_notes: string[];
  source: InvoiceSource;
  created_at: string; // ISO datetime
}

export interface ExtractRequest {
  text: string;
}

export interface ExtractResponse {
  invoice: Invoice;
  needs_review: boolean;
  review_notes: string[];
  model: string;
}

export interface ChatRequest {
  question: string;
}

export interface ChatResponse {
  answer: string;
  sql_query_used: string;
}

export interface HealthResponse {
  ok: boolean;
  database: "postgres" | "sqlite";
  llm_configured: boolean;
  model: string;
}

export interface ErrorResponse {
  error: string;
}

// --------------------------------------------------------------- structured-file import
// A CSV/JSON/XLSX export rarely uses our column names: Claude fills ColumnMapping, then
// deterministic backend code applies it and returns a previewable ImportPreview.

/** invoice: one row per invoice; line_item: one row per billed line, grouped by invoice number. */
export type RowGranularity = "invoice" | "line_item";

export type DateFormatHint = "ISO" | "DMY" | "MDY" | "YMD" | "unknown";

/** Source-column name for each Invoice field (null when the file has no such column). */
export interface ColumnMapping {
  granularity: RowGranularity;
  invoice_number: string | null;
  vendor_name: string | null;
  vendor_email: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  /** ISO 4217 code assumed when there is no currency column — a value, not a column name. */
  currency_default: string | null;
  status: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  po_number: string | null;
  line_item_description: string | null;
  line_item_quantity: string | null;
  line_item_unit_price: string | null;
  line_item_amount: string | null;
  line_items_json: string | null;
  date_format: DateFormatHint;
  /** Per-file translation of the status column's vocabulary (e.g. bezahlt → paid). */
  status_values: Record<string, InvoiceStatus>;
  notes: string[];
}

/** One invoice built from the file, with the derivations made while converting its rows. */
export interface ImportedDraft {
  invoice: Invoice;
  needs_review: boolean;
  review_notes: string[];
  import_notes: string[];
  source_rows: number[];
}

/** Response of POST /invoices/import — nothing is stored until the user confirms. */
export interface ImportPreview {
  filename: string;
  row_count: number;
  headers: string[];
  mapping: ColumnMapping;
  mapping_source: "claude" | "heuristic";
  model: string | null;
  invoices: ImportedDraft[];
  unmapped_columns: string[];
  warnings: string[];
}

export interface BulkCreateRequest {
  invoices: InvoiceDraft[];
}

export interface SkippedInvoice {
  invoice_number: string;
  reason: string;
}

export interface BulkCreateResponse {
  created: InvoiceOut[];
  skipped: SkippedInvoice[];
}
