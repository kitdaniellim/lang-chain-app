import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { writeBatch } from "../../src/data/batch-store.js";
import { generateBatch } from "../../src/data/generator.js";
import type { BatchResult } from "../../src/domain/schemas.js";
import { createCheckpointer } from "../../src/graph/checkpointer.js";
import { createMemoryLogger } from "../../src/observability/logger.js";
import { createPipelineContext } from "../../src/pipeline/context.js";
import { autoReviewer, runBatch } from "../../src/pipeline/run-batch.js";
import { FileSink } from "../../src/sinks/file.js";
import { createUiServer, type UiServer } from "../../src/ui/server.js";

/** A hung SSE stream has to fail the test, not hang the suite. */
const STREAM_TIMEOUT_MS = 30_000;

let outDir: string;
let ui: UiServer;
let base: string;
let seededBatchId: string;
let previousProvider: string | undefined;

interface HttpResult<T> {
  status: number;
  body: T;
}

async function get<T>(pathname: string): Promise<HttpResult<T>> {
  const res = await fetch(`${base}${pathname}`);
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: (type.includes("json") ? JSON.parse(text) : text) as T };
}

async function post<T>(pathname: string, body: unknown): Promise<HttpResult<T>> {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: (type.includes("json") ? JSON.parse(text) : text) as T };
}

interface SseEvent {
  id: string;
  type: string;
  /** Shape depends on the event type; each assertion narrows it where it is read. */
  data: any;
}

/** Parses one `id:/event:/data:` frame; comments and `retry:` lines are ignored. */
function parseFrame(raw: string): SseEvent | null {
  let id = "";
  let type = "message";
  const data: string[] = [];

  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).trimStart();
    if (field === "id") id = value;
    else if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }

  if (data.length === 0) return null;
  return { id, type, data: JSON.parse(data.join("\n")) };
}

/** Consumes a run's SSE stream to completion, handing every event to `onEvent`. */
async function consumeRun(runId: string, onEvent: (event: SseEvent) => void | Promise<void>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/api/runs/${runId}/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const frame = parseFrame(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        if (frame) await onEvent(frame);
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  // The run endpoint reads `.env`; pin the provider so the suite never reaches the network.
  previousProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "fake";

  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-server-"));

  const manifest = generateBatch({ count: 4, seed: 7, defectRate: 0.5 });
  seededBatchId = manifest.batchId;
  await writeBatch(outDir, manifest);

  const config = loadConfig({ llmProvider: "fake", outDir }, {} as NodeJS.ProcessEnv);
  const { context } = await createPipelineContext({
    config,
    batchId: manifest.batchId,
    batchDir: path.join(outDir, manifest.batchId),
    logger: createMemoryLogger("error"),
    sinks: [new FileSink()],
  });
  await runBatch({
    manifest,
    config,
    context,
    checkpointer: createCheckpointer("memory", outDir),
    reviewer: autoReviewer("approve"),
  });

  ui = createUiServer({ outDir, logger: createMemoryLogger("error") });
  base = `http://127.0.0.1:${await ui.listen(0)}`;
});

afterAll(async () => {
  await ui.close();
  await fs.rm(outDir, { recursive: true, force: true });
  if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousProvider;
});

describe("dashboard read routes", () => {
  it("serves the dashboard page", async () => {
    const { status, body } = await get<string>("/");
    expect(status).toBe(200);
    expect(body).toContain("<title>lang-chain-app");
  });

  it("lists the processed batch", async () => {
    const { status, body } = await get<Array<Record<string, unknown>>>("/api/batches");
    expect(status).toBe(200);
    const batch = body.find((entry) => entry.batchId === seededBatchId);
    expect(batch).toBeDefined();
    expect(batch?.processed).toBe(true);
    expect(batch?.documents).toBe(4);
    expect(batch?.provider).toBe("fake");
    expect(batch?.stats).toMatchObject({ total: 4 });
  });

  it("returns the manifest, the result and the evaluation for one batch", async () => {
    const { status, body } = await get<{
      manifest: { batchId: string; documents: unknown[] };
      result: BatchResult;
      evaluation: { overallFieldAccuracy: number; defects: unknown[] };
    }>(`/api/batches/${seededBatchId}`);

    expect(status).toBe(200);
    expect(body.manifest.batchId).toBe(seededBatchId);
    expect(body.manifest.documents).toHaveLength(4);
    expect(body.result.processed).toHaveLength(4);
    expect(body.evaluation.overallFieldAccuracy).toBeGreaterThan(0);
    expect(Array.isArray(body.evaluation.defects)).toBe(true);
  });

  it("serves one raw document and the saved HTML report", async () => {
    const document = await get<{ text: string }>(`/api/batches/${seededBatchId}/documents/doc-001`);
    expect(document.status).toBe(200);
    expect(document.body.text.length).toBeGreaterThan(0);

    const report = await get<string>(`/api/batches/${seededBatchId}/report`);
    expect(report.status).toBe(200);
    expect(report.body).toContain("<html");
  });

  it("returns the ledger rows and both Mermaid diagrams", async () => {
    const ledger = await get<{ rows: Array<{ batchId: string }> }>("/api/ledger");
    expect(ledger.status).toBe(200);
    expect(ledger.body.rows.some((row) => row.batchId === seededBatchId)).toBe(true);

    const graphs = await get<{ invoice: string; batch: string }>("/api/graphs");
    expect(graphs.status).toBe(200);
    expect(graphs.body.invoice).toContain("assess_risk");
    expect(graphs.body.batch).toContain("review_next");
  });

  it("answers a missing batch with a 404 JSON error", async () => {
    const { status, body } = await get<{ error: string }>("/api/batches/nope");
    expect(status).toBe(404);
    expect(body.error).toContain("nope");
  });

  it("answers an unknown document and an unknown route with a 404", async () => {
    expect((await get(`/api/batches/${seededBatchId}/documents/doc-999`)).status).toBe(404);
    expect((await get("/api/nothing-here")).status).toBe(404);
  });
});

describe("live runs over SSE", () => {
  let finishedRunId = "";

  it("streams a run to completion and reports its results", async () => {
    const started = await post<{ runId: string; batchId: string }>("/api/run", { count: 3, seed: 11 });
    expect(started.status).toBe(202);
    expect(started.body.batchId).toContain("11");
    finishedRunId = started.body.runId;

    const tokens: string[] = [];
    let done: { result: BatchResult; evaluation: unknown; checkpoints: number } | null = null;
    let failure: string | null = null;

    await consumeRun(finishedRunId, async (event) => {
      if (event.type === "token") tokens.push(event.data.text as string);
      if (event.type === "review") {
        const answered = await post(`/api/runs/${finishedRunId}/review`, { action: "approve", note: "ok from the test" });
        expect(answered.status).toBe(200);
      }
      if (event.type === "done") done = event.data;
      if (event.type === "error") failure = event.data.message as string;
    });

    expect(failure).toBeNull();
    expect(done).not.toBeNull();
    const outcome: { result: BatchResult; checkpoints: number } = done!;
    expect(outcome.result.processed).toHaveLength(3);
    expect(outcome.result.stats.total).toBe(3);
    expect(outcome.checkpoints).toBeGreaterThan(0);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join("").length).toBeGreaterThan(0);

    // The batch the run produced is now listed and readable like any other.
    const listed = await get<Array<{ batchId: string; processed: boolean }>>("/api/batches");
    expect(listed.body.find((entry) => entry.batchId === started.body.batchId)?.processed).toBe(true);
  });

  it("resolves a pending review from the browser endpoint", async () => {
    const started = await post<{ runId: string }>("/api/run", { count: 3, seed: 42, defectRate: 1 });
    expect(started.status).toBe(202);

    let reviews = 0;
    let done: { result: BatchResult } | null = null;

    await consumeRun(started.body.runId, async (event) => {
      if (event.type === "review") {
        reviews += 1;
        expect(event.data.documentId).toMatch(/^doc-/);
        const answered = await post<{ ok: boolean }>(`/api/runs/${started.body.runId}/review`, {
          action: "approve",
          note: "approved in the browser",
        });
        expect(answered.status).toBe(200);
        expect(answered.body.ok).toBe(true);
      }
      if (event.type === "done") done = event.data;
    });

    expect(reviews).toBeGreaterThan(0);
    const outcome: { result: BatchResult } = done!;
    const humanDecisions = outcome.result.processed.filter((invoice) => invoice.decidedBy === "human");
    expect(humanDecisions.length).toBe(reviews);
    expect(humanDecisions[0]?.reviewerNote).toBe("approved in the browser");
  });

  it("refuses a review when nothing is pending", async () => {
    const { status, body } = await post<{ error: string }>(`/api/runs/${finishedRunId}/review`, { action: "approve" });
    expect(status).toBe(409);
    expect(body.error).toContain("no review");
  });

  it("rejects a malformed body and an out-of-range count", async () => {
    const badJson = await post<{ error: string }>("/api/run", "{not json");
    expect(badJson.status).toBe(400);
    expect(badJson.body.error).toContain("not valid JSON");

    const badCount = await post<{ error: string }>("/api/run", { count: 500 });
    expect(badCount.status).toBe(400);
    expect(badCount.body.error).toContain("count");
  });

  it("reports 404 for an unknown run", async () => {
    const { status } = await get("/api/runs/00000000-0000-4000-8000-000000000000/events");
    expect(status).toBe(404);
  });
});
