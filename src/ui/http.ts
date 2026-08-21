import type { IncomingMessage, ServerResponse } from "node:http";

/** Request bodies larger than this are refused rather than buffered. */
const MAX_BODY_BYTES = 1_000_000;

/** An error that already knows which status code the client should see. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...NO_STORE });
  res.end(payload);
}

export function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { "Content-Type": contentType, ...NO_STORE });
  res.end(body);
}

/** Every failure leaves the wire as `{ error }` so the client never has to parse HTML. */
export function sendError(res: ServerResponse, error: unknown): number {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  const extra = error instanceof HttpError ? error.extra : {};
  if (!res.headersSent) sendJson(res, status, { error: message, ...extra });
  else res.end();
  return status;
}

/** Reads and parses a JSON body; malformed or oversized input becomes a 400. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, `Body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
