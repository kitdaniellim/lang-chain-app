import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command, MemorySaver } from "@langchain/langgraph";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { generateBatch } from "../../src/data/generator.js";
import type { BatchManifest, BatchResult, DeliveryReceipt } from "../../src/domain/schemas.js";
import { ABANDONED_NOTE, buildBatchGraph } from "../../src/graph/batch.graph.js";
import type { BatchStateType } from "../../src/graph/state.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SYSTEM_MARKERS } from "../../src/domain/constants.js";
import { ScriptedChatModel } from "../../src/llm/fake-model.js";
import type { ModelBundle } from "../../src/llm/types.js";
import { createMemoryLogger } from "../../src/observability/logger.js";
import { SelectiveFailureModel, failFirst, failOnMarker } from "../fixtures/failing-models.js";
import { createPipelineContext } from "../../src/pipeline/context.js";
import type { PipelineContext, ReviewRequest } from "../../src/pipeline/types.js";
import { FileSink } from "../../src/sinks/file.js";
import type { Sink, SinkContext } from "../../src/sinks/types.js";
import { receipt } from "../../src/sinks/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** Records what it was handed so the test can assert on the delivered BatchResult. */
class RecordingSink implements Sink {
  readonly name = "recording";
  readonly calls: Array<{ result: BatchResult; batchDir: string }> = [];

  async deliver(result: BatchResult, ctx: SinkContext): Promise<DeliveryReceipt> {
    this.calls.push({ result, batchDir: ctx.batchDir });
    return receipt(this.name, true, `recorded ${result.processed.length} invoice(s)`);
  }
}

/** A sink that rejects rather than returning a receipt, so the graph must convert the throw. */
class ExplodingSink implements Sink {
  readonly name = "exploding";
  async deliver(): Promise<DeliveryReceipt> {
    throw new Error("sink is on fire");
  }
}

async function makeContext(
  manifest: BatchManifest,
  sinks: Sink[],
  models?: ModelBundle,
): Promise<{ context: PipelineContext; outDir: string; batchDir: string; logger: ReturnType<typeof createMemoryLogger> }> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-graph-"));
  tempDirs.push(outDir);
  const batchDir = path.join(outDir, manifest.batchId);
  const config = loadConfig({ llmProvider: "fake", outDir, llmMaxRetries: 1 }, {} as NodeJS.ProcessEnv);
  const logger = createMemoryLogger();
  const { context } = await createPipelineContext({
    config,
    batchId: manifest.batchId,
    batchDir,
    logger,
    sinks,
    ...(models ? { models } : {}),
  });
  return { context, outDir, batchDir, logger };
}

/** Primary that dies on the summariser's prompt only, with an optional fallback model. */
function summaryFailureBundle(fallback: BaseChatModel | null): ModelBundle {
  return {
    primary: SelectiveFailureModel.create(failOnMarker(SYSTEM_MARKERS.summarize)),
    primaryTag: fallback ? "anthropic:test-model" : "fake",
    fallback,
    fallbackTag: fallback ? "fake" : null,
    maxRetries: 1,
  };
}

interface DriveResult {
  state: BatchStateType;
  requests: ReviewRequest[];
}

/** Runs the batch graph to completion, answering every interrupt with `reply`. */
async function drive(
  manifest: BatchManifest,
  context: PipelineContext,
  reply: (request: ReviewRequest, index: number) => unknown,
  maxRounds = 30,
): Promise<DriveResult> {
  const graph = buildBatchGraph({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: manifest.batchId }, context };
  const requests: ReviewRequest[] = [];
  let input: unknown = { batchId: manifest.batchId, documents: manifest.documents };

  for (let round = 0; round < maxRounds; round += 1) {
    const stream = await graph.stream(input as never, { ...config, streamMode: ["updates", "custom"] });
    for await (const chunk of stream) void chunk;

    const snapshot = await graph.getState(config);
    const pending = snapshot.tasks.flatMap((task) => task.interrupts ?? []);
    if (pending.length === 0) return { state: snapshot.values as BatchStateType, requests };

    const request = pending[0]!.value as ReviewRequest;
    requests.push(request);
    input = new Command({ resume: reply(request, requests.length - 1) });
  }
  throw new Error("review loop did not settle");
}

describe("batch graph", () => {
  it("processes a batch, reviews every flagged invoice and delivers to each sink", async () => {
    const manifest = generateBatch({ count: 10, seed: 42, defectRate: 0.5 });
    const recording = new RecordingSink();
    const { context, batchDir } = await makeContext(manifest, [new FileSink(), recording]);

    const { state, requests } = await drive(manifest, context, () => ({ action: "approve", note: "ok" }));

    expect(state.results).toHaveLength(10);
    expect(state.results.map((r) => r.decision)).not.toContain("needs_review");
    expect(state.stats?.total).toBe(10);
    expect(state.summary.length).toBeGreaterThan(0);
    expect(state.reviewQueue).toEqual([]);
    expect(state.startedAt).not.toBe("");
    expect(state.finishedAt).not.toBe("");
    expect(requests.length).toBeGreaterThan(0);

    expect(state.deliveries.map((d) => d.sink).sort()).toEqual(["file", "recording"]);
    expect(state.deliveries.every((d) => d.ok)).toBe(true);
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]!.batchDir).toBe(batchDir);
    expect(recording.calls[0]!.result.stats.total).toBe(10);
    expect(recording.calls[0]!.result.threadId).toBe(manifest.batchId);
    expect(recording.calls[0]!.result.provider).toBe("fake");

    // processed/results.json holds the whole BatchResult, not just the rows.
    const written = JSON.parse(await fs.readFile(path.join(batchDir, "processed", "results.json"), "utf8"));
    expect(written.processed).toHaveLength(10);
    expect(written.stats.total).toBe(10);

    for (const reviewed of state.results.filter((r) => r.decidedBy === "human")) {
      expect(reviewed.decision).toBe("approved_by_human");
      expect(reviewed.reviewerNote).toBe("ok");
    }
  });

  it("records human rejections when the reviewer rejects", async () => {
    const manifest = generateBatch({ count: 10, seed: 42, defectRate: 0.5 });
    const { context } = await makeContext(manifest, []);

    const { state, requests } = await drive(manifest, context, () => ({ action: "reject", note: "no PO" }));

    const human = state.results.filter((r) => r.decidedBy === "human");
    expect(human.length).toBe(requests.length);
    expect(human.every((r) => r.decision === "rejected_by_human")).toBe(true);
    expect(human.every((r) => r.reviewerNote === "no PO")).toBe(true);
    expect(state.stats?.rejectedByHuman).toBe(human.length);
  });

  it("counts `remaining` down and carries the review context in the request", async () => {
    const manifest = generateBatch({ count: 10, seed: 42, defectRate: 0.5 });
    const { context } = await makeContext(manifest, []);

    const { requests } = await drive(manifest, context, () => ({ action: "approve", note: "" }));

    expect(requests.length).toBeGreaterThan(1);
    const remaining = requests.map((r) => r.remaining);
    expect(remaining).toEqual([...remaining].sort((a, b) => b - a));
    expect(remaining.at(-1)).toBe(0);
    expect(remaining[0]).toBe(requests.length - 1);

    const first = requests[0]!;
    expect(first.documentId).toMatch(/^doc-/);
    expect(first.risk.level).not.toBe("low");
    expect(first.issues.length).toBeGreaterThan(0);
    expect(Array.isArray(first.policyExcerpts)).toBe(true);
  });

  it("re-interrupts with an error when the resume payload is not a ReviewAction", async () => {
    const manifest = generateBatch({ count: 10, seed: 42, defectRate: 0.5 });
    const { context } = await makeContext(manifest, []);

    const seen: ReviewRequest[] = [];
    const { state } = await drive(manifest, context, (request, index) => {
      seen.push(request);
      // First answer is deliberately malformed; the node must ask again.
      return index === 0 ? ({ action: "maybe" } as unknown) : { action: "approve", note: "" };
    });

    expect(seen[0]!.error).toBeUndefined();
    expect(seen[1]!.error).toContain("Invalid review payload");
    expect(seen[1]!.documentId).toBe(seen[0]!.documentId);
    expect(state.results.map((r) => r.decision)).not.toContain("needs_review");
  });

  it("rejects the later of two invoices that share a number and a vendor", async () => {
    const base = generateBatch({ count: 10, seed: 42, defectRate: 0.5 });
    const clean = base.documents.find((d) => d.id === "doc-001")!;
    const manifest: BatchManifest = {
      ...base,
      documents: [clean, { ...clean, id: "doc-099", filename: "doc-099.plain.txt" }],
    };
    const { context } = await makeContext(manifest, []);

    const { state } = await drive(manifest, context, () => ({ action: "approve", note: "" }));

    const duplicates = state.results.filter((r) => r.issues.some((i) => i.code === "DUPLICATE_IN_BATCH"));
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.documentId).toBe("doc-099");
    expect(duplicates[0]!.decision).toBe("auto_rejected");
    expect(duplicates[0]!.issues.find((i) => i.code === "DUPLICATE_IN_BATCH")!.severity).toBe("error");
    expect(state.results.find((r) => r.documentId === "doc-001")!.decision).toBe("auto_approved");
    expect(state.stats?.issuesByCode["DUPLICATE_IN_BATCH"]).toBe(1);
  });

  it("sends a shared invoice number from a different vendor to review instead of rejecting it", async () => {
    const base = generateBatch({ count: 10, seed: 42, defectRate: 0 });
    const [firstTruth, secondTruth] = base.groundTruth;
    expect(firstTruth!.vendor.name).not.toBe(secondTruth!.vendor.name);

    // Same number, different vendor: only the number is rewritten, so the vendor block is untouched.
    const first = base.documents.find((d) => d.id === firstTruth!.id)!;
    const second = base.documents.find((d) => d.id === secondTruth!.id)!;
    const manifest: BatchManifest = {
      ...base,
      documents: [first, { ...second, text: second.text.replace(secondTruth!.invoiceNumber, firstTruth!.invoiceNumber) }],
    };
    const { context } = await makeContext(manifest, []);

    const { state, requests } = await drive(manifest, context, () => ({ action: "approve", note: "" }));

    const flagged = state.results.find((r) => r.documentId === second.id)!;
    const duplicate = flagged.issues.find((i) => i.code === "DUPLICATE_IN_BATCH")!;
    expect(duplicate.severity).toBe("warning");
    expect(duplicate.message).toContain(`also used by ${firstTruth!.vendor.name}`);
    // Queued for a human rather than auto-rejected, so the run's only interrupt is this invoice.
    expect(requests.map((r) => r.documentId)).toEqual([second.id]);
    expect(flagged.decision).toBe("approved_by_human");
    expect(state.results.find((r) => r.documentId === first.id)!.decision).toBe("auto_approved");
  });

  it("gives up on an invoice after repeated invalid payloads and still finishes the run", async () => {
    const manifest = generateBatch({ count: 10, seed: 42, defectRate: 0.5 });
    const { context } = await makeContext(manifest, []);

    const seen: ReviewRequest[] = [];
    const { state } = await drive(manifest, context, (request, index) => {
      seen.push(request);
      return index < 3 ? ({ action: "nope" } as unknown) : { action: "approve", note: "" };
    });

    // Three rejected answers for the same document, then the node moves on.
    expect(seen.slice(0, 3).every((r) => r.documentId === seen[0]!.documentId)).toBe(true);
    expect(seen[3]!.documentId).not.toBe(seen[0]!.documentId);
    const abandoned = state.results.find((r) => r.documentId === seen[0]!.documentId)!;
    expect(abandoned.decision).toBe("needs_review");
    expect(abandoned.reviewerNote).toBe(ABANDONED_NOTE);
    expect(state.stats?.needsReview).toBe(1);
    expect(state.reviewQueue).toEqual([]);
    expect(state.summary.length).toBeGreaterThan(0);
  });

  it("reports an unavailable summary rather than failing the run when there is no fallback", async () => {
    const manifest = generateBatch({ count: 3, seed: 42, defectRate: 0 });
    const { context, logger } = await makeContext(manifest, [new RecordingSink()], summaryFailureBundle(null));

    const { state } = await drive(manifest, context, () => ({ action: "approve", note: "" }));

    expect(state.summary.startsWith("Summary unavailable:")).toBe(true);
    expect(state.summary).toContain("Simulated failure");
    expect(logger.lines.some((line) => line.includes("summary failed"))).toBe(true);
    // The rest of the run is unaffected.
    expect(state.results).toHaveLength(3);
    expect(state.stats?.total).toBe(3);
    expect(state.deliveries.map((d) => d.ok)).toEqual([true]);
  });

  it("retries a transient summary failure and never reaches the fallback", async () => {
    const manifest = generateBatch({ count: 3, seed: 42, defectRate: 0 });
    const fallback = new ScriptedChatModel();
    const models: ModelBundle = {
      primary: SelectiveFailureModel.create(failFirst(1, failOnMarker(SYSTEM_MARKERS.summarize))),
      primaryTag: "anthropic:test-model",
      fallback,
      fallbackTag: "fake",
      maxRetries: 3,
    };
    const { context, logger } = await makeContext(manifest, [new RecordingSink()], models);

    const { state } = await drive(manifest, context, () => ({ action: "approve", note: "" }));

    expect(state.summary).toContain("Processed 3 invoices");
    expect(state.summary.startsWith("Summary unavailable:")).toBe(false);
    expect(fallback.calls).toBe(0);
    expect(logger.lines.some((line) => line.includes("summary attempt 1/3 failed"))).toBe(true);
  });

  it("gives up with an unavailable summary once the retries are exhausted", async () => {
    const manifest = generateBatch({ count: 3, seed: 42, defectRate: 0 });
    const models: ModelBundle = {
      primary: SelectiveFailureModel.create(failOnMarker(SYSTEM_MARKERS.summarize)),
      primaryTag: "fake",
      fallback: null,
      fallbackTag: null,
      maxRetries: 2,
    };
    const { context, logger } = await makeContext(manifest, [new RecordingSink()], models);

    const { state } = await drive(manifest, context, () => ({ action: "approve", note: "" }));

    expect(state.summary.startsWith("Summary unavailable:")).toBe(true);
    expect(logger.lines.some((line) => line.includes("summary attempt 1/2 failed"))).toBe(true);
    expect(logger.lines.some((line) => line.includes("summary failed"))).toBe(true);
  });

  it("streams the summary from the fallback model when the primary fails", async () => {
    const manifest = generateBatch({ count: 3, seed: 42, defectRate: 0 });
    const fallback = new ScriptedChatModel();
    const { context, logger } = await makeContext(manifest, [new RecordingSink()], summaryFailureBundle(fallback));

    const { state } = await drive(manifest, context, () => ({ action: "approve", note: "" }));

    expect(state.summary.length).toBeGreaterThan(0);
    expect(state.summary.startsWith("Summary unavailable:")).toBe(false);
    expect(state.summary).toContain("Processed 3 invoices");
    expect(logger.lines.some((line) => line.includes("summary via anthropic:test-model failed"))).toBe(true);
    expect(fallback.calls).toBe(1);
    expect(state.deliveries.map((d) => d.ok)).toEqual([true]);
  });

  it("skips straight to collection for an empty batch", async () => {
    const manifest: BatchManifest = { ...generateBatch({ count: 1, seed: 42, defectRate: 0 }), documents: [] };
    const { context } = await makeContext(manifest, [new RecordingSink()]);

    const { state, requests } = await drive(manifest, context, () => ({ action: "approve", note: "" }));

    expect(requests).toEqual([]);
    expect(state.results).toEqual([]);
    expect(state.stats?.total).toBe(0);
    expect(state.deliveries.map((d) => d.sink)).toEqual(["recording"]);
  });

  it("turns a throwing sink into a failed receipt instead of a crash", async () => {
    const manifest = generateBatch({ count: 2, seed: 42, defectRate: 0 });
    const { context } = await makeContext(manifest, [new ExplodingSink(), new RecordingSink()]);

    const { state } = await drive(manifest, context, () => ({ action: "approve", note: "" }));

    const failed = state.deliveries.find((d) => d.sink === "exploding");
    expect(failed?.ok).toBe(false);
    expect(failed?.detail).toContain("sink is on fire");
    expect(failed?.at).not.toBe("");
    expect(state.deliveries.find((d) => d.sink === "recording")?.ok).toBe(true);
  });
});
