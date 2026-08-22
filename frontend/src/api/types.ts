// Wire types mirroring backend/app/schemas.py; snake_case is kept exactly as sent.

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

/** One invoice draft on the wire, with the document text it came from. */
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

/** Sortable columns accepted by GET /invoices. */
export type InvoiceSortField = "created_at" | "invoice_date" | "due_date" | "total" | "vendor_name";

export type SortOrder = "asc" | "desc";

/** Query string of GET /invoices; every field is optional and empty ones are not sent. */
export interface InvoiceQuery {
  page?: number;
  page_size?: number;
  q?: string;
  status?: InvoiceStatus;
  needs_review?: boolean;
  source?: InvoiceSource;
  sort?: InvoiceSortField;
  order?: SortOrder;
}

/** One page of stored rows; `total` counts every row matching the filters, not the page. */
export interface InvoicePage {
  items: InvoiceOut[];
  total: number;
  page: number;
  page_size: number;
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

// --------------------------------------------------------------- file ingest
// A CSV/JSON/XLSX export rarely uses our column names: Claude fills ColumnMapping, then
// deterministic backend code applies it and returns a previewable IngestPreview.

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
  /** ISO 4217 code assumed when there is no currency column: a value, not a column name. */
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

/**
 * Response of POST /invoices/ingest: one shape for any uploaded file.
 * `extracted` means an unstructured document went through Claude and produced one draft;
 * `imported` means a structured export was column-mapped into N drafts.
 */
export interface IngestPreview {
  filename: string;
  kind: "extracted" | "imported";
  model: string | null;
  mapping: ColumnMapping | null;
  mapping_source: "claude" | "heuristic" | null;
  invoices: ImportedDraft[];
  unmapped_columns: string[];
  warnings: string[];
  /** The document text, for `kind === "extracted"` only. */
  raw_text: string | null;
}

/** Where the drafts came from; the server validates line items only for "uploaded". */
export type IngestSource = "uploaded" | "imported";

export interface BulkCreateRequest {
  invoices: InvoiceDraft[];
  source: IngestSource;
}

export interface SkippedInvoice {
  invoice_number: string;
  reason: string;
}

export interface BulkCreateResponse {
  created: InvoiceOut[];
  skipped: SkippedInvoice[];
}
