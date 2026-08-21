// Thin fetch wrapper over the FastAPI backend; every failure surfaces as ApiError.

import { mockApi } from "./mock";
import type {
  BulkCreateResponse,
  ChatResponse,
  ExtractResponse,
  HealthResponse,
  ImportPreview,
  InvoiceDraft,
  InvoiceOut,
} from "./types";

export const API_BASE: string = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";

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
    throw new ApiError(0, `Cannot reach the API at ${API_BASE} (${detail})`);
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

export function getInvoices(signal?: AbortSignal): Promise<InvoiceOut[]> {
  if (USE_MOCK) return mockApi.invoices();
  return fetchJson<InvoiceOut[]>("/invoices", { signal });
}

export function extractFromText(text: string): Promise<ExtractResponse> {
  if (USE_MOCK) return mockApi.extract();
  return fetchJson<ExtractResponse>("/invoices/extract", jsonPost({ text }));
}

export function extractFromFile(file: File): Promise<ExtractResponse> {
  if (USE_MOCK) return mockApi.extract();
  const form = new FormData();
  form.append("file", file);
  return fetchJson<ExtractResponse>("/invoices/upload", { method: "POST", body: form });
}

export function saveInvoice(draft: InvoiceDraft): Promise<InvoiceOut> {
  if (USE_MOCK) return mockApi.save(draft);
  return fetchJson<InvoiceOut>("/invoices", jsonPost(draft));
}

/** Maps a .csv/.json/.xlsx export onto invoices; nothing is stored until bulkCreate. */
export function importFile(file: File): Promise<ImportPreview> {
  if (USE_MOCK) return mockApi.importFile(file);
  const form = new FormData();
  form.append("file", file);
  return fetchJson<ImportPreview>("/invoices/import", { method: "POST", body: form });
}

/** Creates the reviewed drafts in one request; the server reports what it skipped. */
export function bulkCreate(invoices: InvoiceDraft[]): Promise<BulkCreateResponse> {
  if (USE_MOCK) return mockApi.bulkCreate(invoices);
  return fetchJson<BulkCreateResponse>("/invoices/bulk", jsonPost({ invoices }));
}

export function askQuestion(question: string): Promise<ChatResponse> {
  if (USE_MOCK) return mockApi.chat(question);
  return fetchJson<ChatResponse>("/chat", jsonPost({ question }));
}
