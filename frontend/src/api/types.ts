// Wire types mirroring backend/app/schemas.py — snake_case is kept exactly as sent.

export type InvoiceStatus = "paid" | "pending" | "overdue";

export type InvoiceSource = "seed" | "extracted" | "seed-fallback" | "uploaded";

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
