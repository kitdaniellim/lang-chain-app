import { APIConnectionError } from "@anthropic-ai/sdk";

/** Thrown by the fake model's fault injector; marked retryable so retry policies pick it up. */
export class TransientModelError extends Error {
  readonly retryable = true;
  constructor(message = "Simulated transient model failure (rate limit / 529)") {
    super(message);
    this.name = "TransientModelError";
  }
}

/** Node/undici socket failures worth another attempt; they arrive on `err.code` or `err.cause.code`. */
const RETRYABLE_SYSTEM_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]);

/**
 * True for errors worth retrying: our simulated ones, the Anthropic SDK's connection
 * errors (`APIConnectionError`, and `APIConnectionTimeoutError` which extends it — both
 * report `name: "Error"` and no status, so only `instanceof` recognises them), 429/5xx
 * HTTP failures, and raw socket errors wrapped or not.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof TransientModelError) return true;
  if (err instanceof APIConnectionError) return true;
  if (typeof err !== "object" || err === null) return false;

  const e = err as { status?: number; name?: string; code?: string; cause?: { code?: string } };
  if (typeof e.status === "number") return e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  if (e.name === "APIConnectionError" || e.name === "APIConnectionTimeoutError") return true;
  return RETRYABLE_SYSTEM_CODES.has(e.code ?? "") || RETRYABLE_SYSTEM_CODES.has(e.cause?.code ?? "");
}
