import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { generateBatch } from "../../src/data/generator.js";
import { LedgerEntrySchema } from "../../src/data/ledger.js";
import type { BatchManifest, DeliveryReceipt } from "../../src/domain/schemas.js";
import { createCheckpointer } from "../../src/graph/checkpointer.js";
import { createMemoryLogger, createStreamAwareLogger } from "../../src/observability/logger.js";
import { createPipelineContext } from "../../src/pipeline/context.js";
import { autoReviewer, runBatch } from "../../src/pipeline/run-batch.js";
import type { PipelineContext, ProgressEvent, ReviewRequest } from "../../src/pipeline/types.js";
import { ConsoleSink } from "../../src/sinks/console.js";
import { FileSink } from "../../src/sinks/file.js";
import type { Sink, SinkContext } from "../../src/sinks/types.js";
import { receipt } from "../../src/sinks/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

class StubSink implements Sink {
  readonly name = "stub";
  calls = 0;
  async deliver(_result: unknown, _ctx: SinkContext): Promise<DeliveryReceipt> {
    this.calls += 1;
    return receipt(this.name, true, "stubbed");
  }
}

async function makeOutDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-batch-"));
  tempDirs.push(dir);
  return dir;
}

async function setup(
  manifest: BatchManifest,
  outDir: string,
  sinks: Sink[],
): Promise<{ config: AppConfig; context: PipelineContext }> {
  const config = loadConfig({ llmProvider: "fake", outDir }, {} as NodeJS.ProcessEnv);
  const { context } = await createPipelineContext({
    config,
    batchId: manifest.batchId,
    batchDir: path.join(outDir, manifest.batchId),
    logger: createMemoryLogger(),
    sinks,
  });
  return { config, context };
}

async function readLedger(outDir: string): Promise<Array<{ invoiceNumber: string; batchId: string }>> {
  const raw = await fs.readFile(path.join(outDir, "ledger.json"), "utf8");
  return LedgerEntrySchema.array().parse(JSON.parse(raw));
}

describe("runBatch", () => {
  it("runs a batch to completion with the auto-approving reviewer", async () => {
    const manifest = generateBatch({ count: 10, seed: 42, defectRate: 0.5 });
    const outDir = await makeOutDir();
    const stub = new StubSink();
    const { config, context } = await setup(manifest, outDir, [new FileSink(), stub]);

    const modes: string[] = [];
    const { result, threadId, checkpoints } = await runBatch({
      manifest,
      config,
      context,
      checkpointer: createCheckpointer("memory", outDir),
      reviewer: autoReviewer("approve"),
      onStream: (mode) => modes.push(mode),
    });

    expect(threadId).toBe(manifest.batchId);
    expect(checkpoints).toBeGreaterThan(0);
    expect(result.batchId).toBe(manifest.batchId);
    expect(result.threadId).toBe(manifest.batchId);
    expect(result.provider).toBe("fake");
    expect(result.processed).toHaveLength(10);
    expect(result.processed.map((p) => p.decision)).not.toContain("needs_review");
    expect(result.stats.total).toBe(10);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.startedAt).not.toBe("");
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));

    expect(result.deliveries.map((d) => d.sink).sort()).toEqual(["file", "stub"]);
    expect(result.deliveries.every((d) => d.ok)).toBe(true);
    expect(stub.calls).toBe(1);

    expect(new Set(modes)).toEqual(new Set(["updates", "custom", "messages"]));

    const reviewed = result.processed.filter((p) => p.decidedBy === "human");
    expect(reviewed.length).toBeGreaterThan(0);
    expect(reviewed.every((p) => p.decision === "approved_by_human")).toBe(true);
    expect(reviewed.every((p) => p.reviewerNote?.includes("auto-approve"))).toBe(true);
  });

  it("streams summary tokens through the messages mode tagged with the summarize node", async () => {
    const manifest = generateBatch({ count: 3, seed: 42, defectRate: 0 });
    const outDir = await makeOutDir();
    const { config, context } = await setup(manifest, outDir, []);

    let streamed = "";
    const { result } = await runBatch({
      manifest,
      config,
      context,
      checkpointer: createCheckpointer("memory", outDir),
      reviewer: autoReviewer("approve"),
      onStream: (mode, chunk) => {
        if (mode !== "messages" || !Array.isArray(chunk)) return;
        const [message, metadata] = chunk as [{ content?: unknown }, { langgraph_node?: string }];
        if (metadata?.langgraph_node !== "summarize") return;
        if (typeof message.content === "string") streamed += message.content;
      },
    });

    expect(streamed.length).toBeGreaterThan(0);
    expect(result.summary).toBe(streamed);
  });

  it("records human rejections with the auto-rejecting reviewer", async () => {
    const manifest = generateBatch({ count: 10, seed: 42, defectRate: 0.5 });
    const outDir = await makeOutDir();
    const { config, context } = await setup(manifest, outDir, []);

    const { result } = await runBatch({
      manifest,
      config,
      context,
      checkpointer: createCheckpointer("memory", outDir),
      reviewer: autoReviewer("reject"),
    });

    const rejected = result.processed.filter((p) => p.decision === "rejected_by_human");
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((p) => p.decidedBy === "human")).toBe(true);
    expect(result.stats.rejectedByHuman).toBe(rejected.length);
  });

  it("hands each queued invoice to the supplied reviewer and honours a custom threadId", async () => {
    const manifest = generateBatch({ count: 10, seed: 42, defectRate: 0.5 });
    const outDir = await makeOutDir();
    const { config, context } = await setup(manifest, outDir, []);

    const seen: ReviewRequest[] = [];
    const { result, threadId } = await runBatch({
      manifest,
      config,
      context,
      checkpointer: createCheckpointer("memory", outDir),
      threadId: "thread-custom",
      reviewer: async (request) => {
        seen.push(request);
        return { action: "approve", note: `seen ${seen.length}` };
      },
    });

    expect(threadId).toBe("thread-custom");
    expect(result.threadId).toBe("thread-custom");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.map((r) => r.remaining).at(-1)).toBe(0);
    expect(seen.every((r) => r.risk.level !== "low")).toBe(true);
    expect(result.processed.filter((p) => p.decidedBy === "human")).toHaveLength(seen.length);
  });

  it("appends the run to the ledger and does not flag its own re-run as a duplicate", async () => {
    const manifest = generateBatch({ count: 6, seed: 42, defectRate: 0.5 });
    const outDir = await makeOutDir();

    const first = await setup(manifest, outDir, []);
    const run1 = await runBatch({
      manifest,
      config: first.config,
      context: first.context,
      checkpointer: createCheckpointer("memory", outDir),
      reviewer: autoReviewer("approve"),
    });

    const rows = await readLedger(outDir);
    expect(rows).toHaveLength(run1.result.stats.total);
    expect(rows.every((r) => r.batchId === manifest.batchId)).toBe(true);

    // Same batch id again: its own rows must be excluded from the duplicate search.
    const second = await setup(manifest, outDir, []);
    const run2 = await runBatch({
      manifest,
      config: second.config,
      context: second.context,
      checkpointer: createCheckpointer("memory", outDir),
      reviewer: autoReviewer("approve"),
    });
    expect(run2.result.processed.flatMap((p) => p.issues.map((i) => i.code))).not.toContain("DUPLICATE_IN_LEDGER");

    // The re-run upserts its own rows rather than appending a second copy of every invoice.
    const afterRerun = await readLedger(outDir);
    expect(afterRerun).toHaveLength(rows.length);
    expect(afterRerun.filter((r) => r.batchId === manifest.batchId)).toHaveLength(rows.length);

    // A different batch replaying the same invoices is a genuine duplicate.
    const replay: BatchManifest = { ...manifest, batchId: "batch-replay" };
    const third = await setup(replay, outDir, []);
    const run3 = await runBatch({
      manifest: replay,
      config: third.config,
      context: third.context,
      checkpointer: createCheckpointer("memory", outDir),
      reviewer: autoReviewer("approve"),
    });
    expect(run3.result.processed.flatMap((p) => p.issues.map((i) => i.code))).toContain("DUPLICATE_IN_LEDGER");
    expect(run3.result.processed.filter((p) => p.decision === "auto_rejected").length).toBeGreaterThan(0);
  });

  it("streams sink output after the summary tokens instead of racing them to stdout", async () => {
    const manifest = generateBatch({ count: 4, seed: 42, defectRate: 0 });
    const outDir = await makeOutDir();
    const config = loadConfig({ llmProvider: "fake", outDir }, {} as NodeJS.ProcessEnv);
    // The fallback sink keeps pre/post-run lines out of the test's stdout.
    const stray: string[] = [];
    const { context } = await createPipelineContext({
      config,
      batchId: manifest.batchId,
      batchDir: path.join(outDir, manifest.batchId),
      logger: createStreamAwareLogger({ level: "debug", sink: (line) => stray.push(line) }),
      sinks: [new ConsoleSink()],
    });

    const events: Array<{ mode: string; chunk: unknown }> = [];
    await runBatch({
      manifest,
      config,
      context,
      checkpointer: createCheckpointer("memory", outDir),
      reviewer: autoReviewer("approve"),
      onStream: (mode, chunk) => events.push({ mode, chunk }),
    });

    const isSummaryToken = ({ mode, chunk }: { mode: string; chunk: unknown }): boolean => {
      if (mode !== "messages" || !Array.isArray(chunk)) return false;
      const [, metadata] = chunk as [unknown, { langgraph_node?: string } | undefined];
      return metadata?.langgraph_node === "summarize";
    };
    const isTableHeader = ({ mode, chunk }: { mode: string; chunk: unknown }): boolean => {
      const event = chunk as ProgressEvent | null;
      return mode === "custom" && event?.type === "log" && event.line.includes("Batch ");
    };

    const lastToken = events.findLastIndex(isSummaryToken);
    const firstTable = events.findIndex(isTableHeader);
    expect(lastToken).toBeGreaterThanOrEqual(0);
    expect(firstTable).toBeGreaterThanOrEqual(0);
    // The regression: the console table used to hit stdout while tokens were still draining.
    expect(lastToken).toBeLessThan(firstTable);
  });
});

describe("autoReviewer", () => {
  it("answers every request with the configured action and a note", async () => {
    const request = { documentId: "doc-001", remaining: 2 } as unknown as ReviewRequest;
    await expect(autoReviewer("approve")(request)).resolves.toEqual({
      action: "approve",
      note: "auto-approve (non-interactive run)",
    });
    await expect(autoReviewer("reject")(request)).resolves.toEqual({
      action: "reject",
      note: "auto-reject (non-interactive run)",
    });
  });
});
