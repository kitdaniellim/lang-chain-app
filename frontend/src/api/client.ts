// Thin fetch wrapper over the FastAPI backend; every failure surfaces as ApiError.

import { mockApi } from "./mock";
import type {
  BulkCreateRequest,
  BulkCreateResponse,
  ChatResponse,
  HealthResponse,
  IngestPreview,
  IngestSource,
  InvoiceDraft,
  InvoicePage,
  InvoiceQuery,
} from "./types";

// Same origin by default: Vite proxies the API in dev, FastAPI serves the build in production.
export const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

export const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === "true";

/** An HTTP failure carrying the status and the server's `{error}` message. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function messageFromBody(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const { error } = body as { error: unknown };
    if (typeof error === "string" && error.trim()) return error;
  }
  return `Request failed with status ${status}`;
}

/** GET/POST JSON; throws ApiError(status, message) using the server's `{error}` body. */
export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "network error";
    throw new ApiError(0, `Cannot reach the API at ${API_BASE || window.location.origin} (${detail})`);
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) throw new ApiError(response.status, messageFromBody(body, response.status));
  return body as T;
}

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  if (USE_MOCK) return mockApi.health();
  return fetchJson<HealthResponse>("/health", { signal });
}

/** Serialises a query, dropping empty values so the URL only carries active filters. */
function toSearchParams(query: InvoiceQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (!text.trim()) continue;
    params.set(key, text);
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}

export function listInvoices(query: InvoiceQuery = {}, signal?: AbortSignal): Promise<InvoicePage> {
  if (USE_MOCK) return mockApi.listInvoices(query);
  return fetchJson<InvoicePage>(`/invoices${toSearchParams(query)}`, { signal });
}

/** Any supported file in, invoice drafts out; nothing is stored until bulkCreate. */
export function ingestFile(file: File): Promise<IngestPreview> {
  if (USE_MOCK) return mockApi.ingest(file);
  const form = new FormData();
  form.append("file", file);
  return fetchJson<IngestPreview>("/invoices/ingest", { method: "POST", body: form });
}

/** Creates the reviewed drafts in one request; the server reports what it skipped. */
export function bulkCreate(
  invoices: InvoiceDraft[],
  source: IngestSource,
): Promise<BulkCreateResponse> {
  if (USE_MOCK) return mockApi.bulkCreate(invoices, source);
  const body: BulkCreateRequest = { invoices, source };
  return fetchJson<BulkCreateResponse>("/invoices/bulk", jsonPost(body));
}

export function askQuestion(question: string): Promise<ChatResponse> {
  if (USE_MOCK) return mockApi.chat(question);
  return fetchJson<ChatResponse>("/chat", jsonPost({ question }));
}
