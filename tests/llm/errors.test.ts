import { describe, expect, it } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { isRetryableError, TransientModelError } from "../../src/llm/errors.js";

describe("isRetryableError — Anthropic SDK connection errors", () => {
  it("retries APIConnectionError even though it reports no status and name 'Error'", () => {
    const err = new APIConnectionError({ message: "Connection error." });
    expect(err.status).toBeUndefined();
    expect(isRetryableError(err)).toBe(true);
  });

  it("retries APIConnectionTimeoutError", () => {
    expect(isRetryableError(new APIConnectionTimeoutError())).toBe(true);
  });

  it("retries a connection error wrapping a socket code on .cause", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isRetryableError(new APIConnectionError({ message: "Connection error.", cause }))).toBe(true);
  });
});

describe("isRetryableError — plain errors", () => {
  it("retries the fake model's simulated failure", () => {
    expect(isRetryableError(new TransientModelError())).toBe(true);
  });

  it("retries socket codes on the error itself and on its cause", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]) {
      expect(isRetryableError(Object.assign(new Error(code), { code })), code).toBe(true);
      expect(isRetryableError(Object.assign(new Error(code), { cause: { code } })), `cause ${code}`).toBe(true);
    }
  });

  it("retries 408/409/429/5xx statuses but not 400/401/404", () => {
    for (const status of [408, 409, 429, 500, 529]) expect(isRetryableError({ status }), String(status)).toBe(true);
    for (const status of [400, 401, 404, 422]) expect(isRetryableError({ status }), String(status)).toBe(false);
  });

  it("does not retry an ordinary error or a non-object", () => {
    expect(isRetryableError(new Error("x"))).toBe(false);
    expect(isRetryableError({ status: 400, message: "bad request: schema invalid" })).toBe(false);
    expect(isRetryableError("boom")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});
