import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { generateBatch } from "../../src/data/generator.js";
import type { BatchManifest } from "../../src/domain/schemas.js";
import { LedgerEntrySchema } from "../../src/data/ledger.js";
import { CHECKPOINT_FILENAME, closeCheckpointer, createCheckpointer } from "../../src/graph/checkpointer.js";
import { createMemoryLogger } from "../../src/observability/logger.js";
import { createPipelineContext } from "../../src/pipeline/context.js";
import { autoReviewer, resumeBatch, runBatch } from "../../src/pipeline/run-batch.js";
import type { PipelineContext, ReviewRequest } from "../../src/pipeline/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup(manifest: BatchManifest): Promise<{ outDir: string; context: PipelineContext }> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-resume-"));
  tempDirs.push(outDir);
  const config = loadConfig({ llmProvider: "fake", outDir }, {} as NodeJS.ProcessEnv);
  const { context } = await createPipelineContext({
    config,
    batchId: manifest.batchId,
    batchDir: path.join(outDir, manifest.batchId),
    logger: createMemoryLogger(),
    sinks: [],
  });
  return { outDir, context };
}

describe("resumeBatch", () => {
  it("answers the interrupt a crashed run left pending and finishes the batch", async () => {
    const manifest = generateBatch({ count: 6, seed: 42, defectRate: 1, batchId: "batch-resume" });
    const { outDir, context } = await setup(manifest);
    const config = loadConfig({ llmProvider: "fake", outDir }, {} as NodeJS.ProcessEnv);
    // One checkpointer shared by both runs is what makes the pause outlive the crash.
    const checkpointer = createCheckpointer("memory", outDir);

    let pending: ReviewRequest | null = null;
    await expect(
      runBatch({
        manifest,
        config,
        context,
        checkpointer,
        reviewer: async (request) => {
          pending = request;
          throw new Error("reviewer crashed");
        },
      }),
    ).rejects.toThrow("reviewer crashed");

    const paused = pending as ReviewRequest | null;
    expect(paused).not.toBeNull();

    const outcome = await resumeBatch({
      manifest,
      config,
      context,
      checkpointer,
      threadId: manifest.batchId,
      decision: { action: "reject", note: "resumed from the CLI" },
      reviewer: autoReviewer("approve"),
    });

    const resumed = outcome.result.processed.find((invoice) => invoice.documentId === paused!.documentId);
    expect(resumed?.decision).toBe("rejected_by_human");
    expect(resumed?.reviewerNote).toBe("resumed from the CLI");
    expect(outcome.result.stats.needsReview).toBe(0);
    expect(outcome.threadId).toBe(manifest.batchId);
    expect(outcome.result.summary).not.toBe("");
  });

  it("resumes across processes through the sqlite checkpointer", async () => {
    const manifest = generateBatch({ count: 6, seed: 42, defectRate: 1, batchId: "batch-resume-sqlite" });
    const { outDir, context } = await setup(manifest);
    const config = loadConfig({ llmProvider: "fake", outDir, checkpointer: "sqlite" }, {} as NodeJS.ProcessEnv);

    let pending: ReviewRequest | null = null;
    const crashed = createCheckpointer("sqlite", outDir);
    await expect(
      runBatch({
        manifest,
        config,
        context,
        checkpointer: crashed,
        reviewer: async (request) => {
          pending = request;
          throw new Error("reviewer crashed");
        },
      }),
    ).rejects.toThrow("reviewer crashed");

    const paused = pending as ReviewRequest | null;
    expect(paused).not.toBeNull();
    await expect(fs.stat(path.join(outDir, CHECKPOINT_FILENAME))).resolves.toBeTruthy();
    // The crashed process dies here, releasing its handle on the file.
    closeCheckpointer(crashed);

    // A brand-new saver on the same file is what the second CLI process gets.
    const reopened = createCheckpointer("sqlite", outDir);
    const outcome = await resumeBatch({
      manifest,
      config,
      context,
      checkpointer: reopened,
      threadId: manifest.batchId,
      decision: { action: "reject", note: "resumed in a new process" },
      reviewer: autoReviewer("approve"),
    });
    closeCheckpointer(reopened);

    const resumed = outcome.result.processed.find((invoice) => invoice.documentId === paused!.documentId);
    expect(resumed?.decision).toBe("rejected_by_human");
    expect(resumed?.reviewerNote).toBe("resumed in a new process");
    expect(outcome.result.stats.needsReview).toBe(0);
    expect(outcome.result.stats.total).toBe(manifest.documents.length);

    // The ledger records the finished run, and it agrees with the result.
    const rows = LedgerEntrySchema.array().parse(
      JSON.parse(await fs.readFile(path.join(outDir, "ledger.json"), "utf8")),
    );
    const numbered = outcome.result.processed.filter((invoice) => invoice.invoiceNumber !== null);
    expect(rows).toHaveLength(numbered.length);
    expect(rows.every((row) => row.batchId === manifest.batchId)).toBe(true);
    expect(rows.find((row) => row.documentId === paused!.documentId)?.decision).toBe("rejected_by_human");
  });

  it("refuses to resume a thread with no pending review", async () => {
    const manifest = generateBatch({ count: 2, seed: 4, defectRate: 0, batchId: "batch-clean" });
    const { outDir, context } = await setup(manifest);
    const config = loadConfig({ llmProvider: "fake", outDir }, {} as NodeJS.ProcessEnv);

    await expect(
      resumeBatch({
        manifest,
        config,
        context,
        checkpointer: createCheckpointer("memory", outDir),
        threadId: manifest.batchId,
        decision: { action: "approve", note: "" },
        reviewer: autoReviewer("approve"),
      }),
    ).rejects.toThrow(/no pending review/);
  });
});
