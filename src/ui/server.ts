import fs from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { loadConfig } from "../config.js";
import { ReviewActionSchema } from "../domain/schemas.js";
import { createLogger, type Logger } from "../observability/logger.js";
import {
  listBatchSummaries,
  readBatchDetail,
  readDocumentText,
  readGraphDiagrams,
  readLedgerRows,
  readReportHtml,
} from "./api.js";
import { HttpError, readJsonBody, sendError, sendJson, sendText } from "./http.js";
import { RunManager, StartRunSchema, type RunEvent, type RunRecord } from "./run-manager.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4545;
/** Keeps proxies and idle timeouts from closing a stream that is waiting on a review. */
const HEARTBEAT_MS = 15_000;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(UI_DIR, "public", "index.html");

export interface UiServerOptions {
  /** Defaults to the configured `OUT_DIR`; the API reads and every run writes here. */
  outDir?: string;
  logger?: Logger;
}

export interface UiServer {
  server: Server;
  /** Resolves with the port actually bound (0 picks a free one). */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

/** Turns a zod failure into a 400 naming the offending fields. */
function parseOrBadRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new HttpError(400, `Invalid request: ${details || "unrecognised body"}`);
}

/** One SSE frame. `id` is the sequence number a reconnecting browser sends back. */
function frame(event: RunEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Streams one run: everything buffered since `Last-Event-ID`, then live events,
 * closing the response as soon as the run reports `done` or `error`.
 */
function streamRun(req: IncomingMessage, res: ServerResponse, manager: RunManager, record: RunRecord): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");

  const resumeFrom = Number.parseInt(String(req.headers["last-event-id"] ?? ""), 10);
  const since = Number.isFinite(resumeFrom) ? resumeFrom : -1;

  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
    if (!res.writableEnded) res.end();
  };

  const write = (event: RunEvent): void => {
    if (closed || res.writableEnded) return;
    res.write(frame(event));
    if (event.type === "done" || event.type === "error") finish();
  };

  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  // An interval must never be the reason `npm test` refuses to exit.
  heartbeat.unref?.();

  let unsubscribe: (() => void) | undefined;
  for (const buffered of [...record.events]) {
    if (buffered.seq > since) write(buffered);
  }
  if (closed) return;

  if (record.status !== "running") {
    finish();
    return;
  }
  unsubscribe = manager.subscribe(record.runId, write);
  res.on("close", finish);
}

async function serveIndex(res: ServerResponse): Promise<void> {
  try {
    sendText(res, 200, await fs.readFile(INDEX_HTML, "utf8"), "text/html; charset=utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new HttpError(500, `Dashboard page is missing at ${INDEX_HTML}`);
  }
}

/** The whole route table. Anything unmatched falls through to a 404. */
async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { outDir: string; logger: Logger; manager: RunManager },
  url: URL,
): Promise<void> {
  const { outDir, logger, manager } = deps;
  const method = req.method ?? "GET";
  const segments = url.pathname.split("/").filter((part) => part !== "");

  if (method === "GET" && segments.length === 0) return serveIndex(res);

  if (segments[0] !== "api") throw new HttpError(404, `No route for ${method} ${url.pathname}`);
  const [, resource, first, second, third] = segments;

  if (method === "GET" && resource === "batches" && first === undefined) {
    return sendJson(res, 200, await listBatchSummaries(outDir, logger));
  }
  if (method === "GET" && resource === "batches" && first !== undefined) {
    if (second === undefined) return sendJson(res, 200, await readBatchDetail(outDir, first));
    if (second === "report") return sendText(res, 200, await readReportHtml(outDir, first), "text/html; charset=utf-8");
    if (second === "documents" && third !== undefined) {
      return sendJson(res, 200, { text: await readDocumentText(outDir, first, third, logger) });
    }
  }
  if (method === "GET" && resource === "ledger") return sendJson(res, 200, { rows: await readLedgerRows(outDir) });
  if (method === "GET" && resource === "graphs") return sendJson(res, 200, await readGraphDiagrams());

  if (method === "POST" && resource === "run") {
    const input = parseOrBadRequest(StartRunSchema, await readJsonBody(req));
    return sendJson(res, 202, await manager.start(input));
  }
  if (method === "GET" && resource === "runs" && first === undefined) {
    return sendJson(res, 200, { active: manager.active(), runs: manager.summaries() });
  }
  if (resource === "runs" && first !== undefined) {
    if (method === "GET" && second === "events") return streamRun(req, res, manager, manager.get(first));
    if (method === "POST" && second === "review") {
      const action = parseOrBadRequest(ReviewActionSchema, await readJsonBody(req));
      return sendJson(res, 200, { ok: true, ...manager.resolveReview(first, action) });
    }
  }

  throw new HttpError(404, `No route for ${method} ${url.pathname}`);
}

/** Builds the dashboard server without binding a port. */
export function createUiServer(options: UiServerOptions = {}): UiServer {
  const logger = options.logger ?? createLogger({ level: "info", scope: "ui" });
  const outDir = options.outDir ?? loadConfig({}, process.env, { requireModelCredentials: false }).outDir;
  const manager = new RunManager({ outDir, logger });

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", `http://${HOST}`);

    const done = (status: number): void => {
      const line = `${req.method ?? "GET"} ${url.pathname} → ${status} (${Date.now() - started} ms)`;
      if (status >= 500) logger.error(line);
      else logger.info(line);
    };

    void route(req, res, { outDir, logger, manager }, url).then(
      // SSE responses stay open; their status is logged as soon as the headers go out.
      () => done(res.statusCode),
      (error: unknown) => done(sendError(res, error)),
    );
  });

  // A socket error must not take the process down with it.
  server.on("clientError", (error, socket) => {
    logger.warn(`client error: ${error.message}`);
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return {
    server,
    listen: (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, HOST, () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** `npm run ui` entry point. */
async function main(): Promise<void> {
  const logger = createLogger({ level: "info", scope: "ui" });
  const ui = createUiServer({ logger });
  const port = await ui.listen(Number.parseInt(process.env.UI_PORT ?? "", 10) || DEFAULT_PORT);
  logger.info(`dashboard on http://${HOST}:${port} — Ctrl-C to stop`);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
