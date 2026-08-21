import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertBatchId, batchDir, listBatches, readManifest, readResult, writeBatch } from "../../src/data/batch-store.js";
import { generateBatch } from "../../src/data/generator.js";
import type { BatchResult } from "../../src/domain/schemas.js";
import { createMemoryLogger } from "../../src/observability/logger.js";
import { FileSink } from "../../src/sinks/file.js";

let outDir: string;

beforeEach(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcd-batches-"));
});

afterEach(async () => {
  await fs.rm(outDir, { recursive: true, force: true });
});

const sampleResult = (batchId: string): BatchResult => ({
  batchId,
  threadId: "thread-1",
  startedAt: "2026-08-20T00:00:00.000Z",
  finishedAt: "2026-08-20T00:00:05.000Z",
  provider: "fake",
  processed: [
    {
      documentId: "doc-001",
      invoiceNumber: "INV-2026-0417",
      extracted: null,
      issues: [{ code: "MISSING_FIELD", severity: "warning", message: "no due date" }],
      categorization: null,
      risk: { score: 12, level: "low", reasons: ["clean"] },
      investigation: null,
      decision: "auto_approved",
      decidedBy: "system",
      reviewerNote: null,
      provider: "fake",
      timings: { extract: 4 },
    },
  ],
  stats: {
    total: 1,
    autoApproved: 1,
    approvedByHuman: 0,
    rejectedByHuman: 0,
    autoRejected: 0,
    needsReview: 0,
    approvedAmount: 216,
    totalAmount: 216,
    byCategory: { CLOUD_HOSTING: 1 },
    issuesByCode: { MISSING_FIELD: 1 },
  },
  summary: "One invoice auto-approved.",
  deliveries: [{ sink: "console", ok: true, detail: "printed", at: "2026-08-20T00:00:05.000Z" }],
});

describe("batchDir", () => {
  it("joins the output directory and the batch id", () => {
    expect(batchDir(outDir, "batch-x")).toBe(path.join(outDir, "batch-x"));
  });
});

describe("writeBatch / readManifest", () => {
  it("round-trips a manifest and writes one raw document per invoice", async () => {
    const manifest = generateBatch({ count: 4, seed: 21, defectRate: 0.5, batchId: "batch-a" });
    const dir = await writeBatch(outDir, manifest);

    expect(dir).toBe(batchDir(outDir, "batch-a"));
    expect(await readManifest(outDir, "batch-a")).toEqual(manifest);

    for (const doc of manifest.documents) {
      const text = await fs.readFile(path.join(dir, "raw", doc.filename), "utf8");
      expect(text).toBe(doc.text);
    }
    expect((await fs.readdir(path.join(dir, "raw"))).sort()).toEqual(manifest.documents.map((d) => d.filename).sort());
  });

  it("drops raw documents from a previous write of the same batch", async () => {
    const big = generateBatch({ count: 3, seed: 31, defectRate: 0, batchId: "batch-rewrite" });
    const dir = await writeBatch(outDir, big);
    expect(await fs.readdir(path.join(dir, "raw"))).toHaveLength(3);

    const small = generateBatch({ count: 1, seed: 32, defectRate: 0, batchId: "batch-rewrite" });
    await writeBatch(outDir, small);

    const remaining = await fs.readdir(path.join(dir, "raw"));
    expect(remaining).toEqual([small.documents[0]!.filename]);
    expect(await readManifest(outDir, "batch-rewrite")).toEqual(small);
  });

  it("creates the directory tree when it does not exist yet", async () => {
    const nested = path.join(outDir, "deep", "nested");
    const manifest = generateBatch({ count: 1, seed: 2, defectRate: 0, batchId: "batch-b" });
    await writeBatch(nested, manifest);
    expect((await readManifest(nested, "batch-b")).batchId).toBe("batch-b");
  });

  it("throws an error naming the batch when the manifest is missing", async () => {
    await expect(readManifest(outDir, "batch-missing")).rejects.toThrow(/batch-missing/);
  });

  it("names the offending field when the manifest is malformed", async () => {
    const manifest = generateBatch({ count: 1, seed: 5, defectRate: 0, batchId: "batch-bad-manifest" });
    await writeBatch(outDir, manifest);
    const file = path.join(batchDir(outDir, "batch-bad-manifest"), "manifest.json");
    await fs.writeFile(file, JSON.stringify({ ...manifest, seed: "forty-two" }), "utf8");

    await expect(readManifest(outDir, "batch-bad-manifest")).rejects.toThrow(
      /batch-bad-manifest manifest is invalid: seed/,
    );
  });

  it("reports unparseable JSON instead of a raw syntax error", async () => {
    const manifest = generateBatch({ count: 1, seed: 6, defectRate: 0, batchId: "batch-not-json" });
    await writeBatch(outDir, manifest);
    await fs.writeFile(path.join(batchDir(outDir, "batch-not-json"), "manifest.json"), "{ nope", "utf8");

    await expect(readManifest(outDir, "batch-not-json")).rejects.toThrow(/batch-not-json manifest is invalid/);
  });
});

describe("listBatches", () => {
  it("returns batch ids sorted and ignores directories without a manifest", async () => {
    for (const id of ["batch-c", "batch-a", "batch-b"]) {
      await writeBatch(outDir, generateBatch({ count: 1, seed: 1, defectRate: 0, batchId: id }));
    }
    await fs.mkdir(path.join(outDir, "not-a-batch"), { recursive: true });
    await fs.writeFile(path.join(outDir, "stray.txt"), "ignore me", "utf8");

    expect(await listBatches(outDir)).toEqual(["batch-a", "batch-b", "batch-c"]);
  });

  it("returns an empty list when the output directory does not exist", async () => {
    expect(await listBatches(path.join(outDir, "nope"))).toEqual([]);
  });
});

describe("readResult", () => {
  it("round-trips the result the FileSink wrote", async () => {
    const manifest = generateBatch({ count: 1, seed: 4, defectRate: 0, batchId: "batch-r" });
    await writeBatch(outDir, manifest);

    // The FileSink is the only writer of processed/results.json.
    const result = sampleResult("batch-r");
    const dir = batchDir(outDir, "batch-r");
    const rc = await new FileSink().deliver(result, { batchDir: dir, logger: createMemoryLogger() });
    expect(rc.ok).toBe(true);

    expect(await readResult(outDir, "batch-r")).toEqual(result);
    const onDisk = path.join(dir, "processed", "results.json");
    expect(JSON.parse(await fs.readFile(onDisk, "utf8"))).toEqual(result);
  });

  it("returns null when no result has been written", async () => {
    expect(await readResult(outDir, "batch-none")).toBeNull();
  });

  it("names the offending field when the results file is malformed", async () => {
    const manifest = generateBatch({ count: 1, seed: 4, defectRate: 0, batchId: "batch-bad" });
    await writeBatch(outDir, manifest);
    const dir = path.join(batchDir(outDir, "batch-bad"), "processed");
    await fs.mkdir(dir, { recursive: true });
    const broken = { ...sampleResult("batch-bad"), stats: "not-an-object" };
    await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(broken), "utf8");

    await expect(readResult(outDir, "batch-bad")).rejects.toThrow(/batch-bad results are invalid: stats/);
  });
});

describe("batchDir — batch id validation", () => {
  it("accepts the ids the generator produces", () => {
    expect(assertBatchId("batch-20260820-000000-42")).toBe("batch-20260820-000000-42");
    expect(batchDir("out", "batch_1.v2")).toBe(path.join("out", "batch_1.v2"));
  });

  it("rejects traversal and separators", () => {
    for (const bad of ["..", "../etc", "a/../b", "a/b", "a\\b", "", "batch id", "batch:1"]) {
      expect(() => batchDir("out", bad), bad).toThrow(/Invalid batch id/);
    }
  });
});
