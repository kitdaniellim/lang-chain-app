import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { generateBatch } from "../../src/data/generator.js";
import type { LedgerEntry } from "../../src/data/ledger.types.js";
import type { BatchManifest, RawInvoiceDocument } from "../../src/domain/schemas.js";
import { buildInvoiceGraph } from "../../src/graph/invoice.graph.js";
import { createMemoryLogger } from "../../src/observability/logger.js";
import { createPipelineContext } from "../../src/pipeline/context.js";
import type { PipelineContext, ProgressEvent } from "../../src/pipeline/types.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ModelBundle } from "../../src/llm/types.js";
import { SelectiveFailureModel, failOnTool } from "../fixtures/failing-models.js";
import { TOOL_NAMES } from "../../src/domain/constants.js";

/** Seed 7 at defectRate 1: doc-009 is defect-free, the rest carry one of every interesting defect. */
const MANIFEST: BatchManifest = generateBatch({ count: 12, seed: 7, defectRate: 1 });

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function doc(id: string): RawInvoiceDocument {
  const found = MANIFEST.documents.find((d) => d.id === id);
  if (!found) throw new Error(`fixture document ${id} is missing`);
  return found;
}

async function makeContext(
  opts: { failureRate?: number; ledgerRows?: LedgerEntry[]; models?: ModelBundle } = {},
): Promise<{ context: PipelineContext; logger: ReturnType<typeof createMemoryLogger> }> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "invoice-graph-"));
  tempDirs.push(outDir);

  if (opts.ledgerRows?.length) {
    await fs.writeFile(path.join(outDir, "ledger.json"), JSON.stringify(opts.ledgerRows, null, 2), "utf8");
  }

  const config = loadConfig(
    { llmProvider: "fake", outDir, fakeFailureRate: opts.failureRate ?? 0, llmMaxRetries: 1 },
    {} as NodeJS.ProcessEnv,
  );
  const logger = createMemoryLogger();
  const { context } = await createPipelineContext({
    config,
    batchId: MANIFEST.batchId,
    batchDir: path.join(outDir, MANIFEST.batchId),
    logger,
    sinks: [],
    ...(opts.models ? { models: opts.models } : {}),
  });
  return { context, logger };
}

/** Bundle around one model, with retries off so a failing chain gives up immediately. */
function bundleOf(primary: BaseChatModel): ModelBundle {
  return { primary, primaryTag: "fake", fallback: null, fallbackTag: null, maxRetries: 1 };
}

function ledgerRow(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    invoiceNumber: "INV-0000",
    vendorName: "Someone Else Ltd",
    total: 10,
    currency: "USD",
    issueDate: "2026-01-01",
    documentId: "old-doc",
    batchId: "batch-earlier",
    decision: "auto_approved",
    processedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("invoice subgraph", () => {
  it("auto-approves a defect-free invoice and records timings for every node", async () => {
    const { context } = await makeContext();
    const state = await buildInvoiceGraph().invoke({ document: doc("doc-009") }, { context });

    expect(state.decision).toBe("auto_approved");
    expect(state.extracted?.invoiceNumber).toBe("INV-2026-1997");
    expect(state.issues).toEqual([]);
    expect(state.risk?.level).toBe("low");
    expect(state.categorization?.category).toBe("MARKETING");
    expect(state.provider).toBe("fake");
    expect(Object.keys(state.timings).sort()).toEqual([
      "assess_risk",
      "auto_approve",
      "categorize",
      "extract",
      "validate",
    ]);
    expect(state.investigation).toBeNull();
  });

  it("flags an arithmetic mismatch for review with an investigation attached", async () => {
    const { context } = await makeContext();
    const state = await buildInvoiceGraph().invoke({ document: doc("doc-007") }, { context });

    expect(state.decision).toBe("needs_review");
    expect(state.issues.map((i) => i.code)).toContain("TOTAL_MISMATCH");
    expect(state.risk?.level).not.toBe("low");
    expect(state.investigation).not.toBeNull();
    expect(["approve", "reject", "escalate"]).toContain(state.investigation?.recommendation);
    expect(state.investigation?.brief.length ?? 0).toBeGreaterThan(0);
    expect(state.investigation?.toolsUsed.length ?? 0).toBeGreaterThan(0);
    expect(state.timings["investigate"]).toBeGreaterThanOrEqual(0);
    expect(state.policyExcerpts.length).toBeGreaterThan(0);
  });

  it("flags an unknown vendor for review", async () => {
    const { context } = await makeContext();
    const state = await buildInvoiceGraph().invoke({ document: doc("doc-001") }, { context });

    expect(state.decision).toBe("needs_review");
    expect(state.issues.map((i) => i.code)).toContain("UNKNOWN_VENDOR");
    expect(state.risk?.reasons.length ?? 0).toBeGreaterThan(0);
  });

  it("auto-rejects an invoice number the same vendor already has in the ledger", async () => {
    const { context } = await makeContext({
      ledgerRows: [
        ledgerRow({
          invoiceNumber: "INV-2026-1997",
          vendorName: "Brightside Media Group",
          documentId: "doc-900",
        }),
      ],
    });
    const state = await buildInvoiceGraph().invoke({ document: doc("doc-009") }, { context });

    expect(state.decision).toBe("auto_rejected");
    expect(state.issues.find((i) => i.code === "DUPLICATE_IN_LEDGER")?.severity).toBe("error");
    expect(state.investigation).toBeNull();
  });

  it("sends the same invoice number from a different vendor to review instead of rejecting it", async () => {
    const { context } = await makeContext({
      ledgerRows: [ledgerRow({ invoiceNumber: "INV-2026-1997", documentId: "doc-900" })],
    });
    const state = await buildInvoiceGraph().invoke({ document: doc("doc-009") }, { context });

    expect(state.decision).toBe("needs_review");
    const duplicate = state.issues.find((i) => i.code === "DUPLICATE_IN_LEDGER");
    expect(duplicate?.severity).toBe("warning");
    expect(duplicate?.message).toContain("Someone Else Ltd");
    expect(state.investigation).not.toBeNull();
  });

  it("auto-rejects with EXTRACTION_FAILED when every model call fails", async () => {
    const { context } = await makeContext({ failureRate: 1 });
    const state = await buildInvoiceGraph().invoke({ document: doc("doc-009") }, { context });

    expect(state.decision).toBe("auto_rejected");
    expect(state.extracted).toBeNull();
    expect(state.issues.map((i) => i.code)).toContain("EXTRACTION_FAILED");
    expect(state.issues.find((i) => i.code === "EXTRACTION_FAILED")?.severity).toBe("error");
  });

  it("keeps going when categorization fails, recording a warning instead of throwing", async () => {
    const models = bundleOf(SelectiveFailureModel.create(failOnTool(TOOL_NAMES.categorize)));
    const { context, logger } = await makeContext({ models });

    const state = await buildInvoiceGraph().invoke({ document: doc("doc-009") }, { context });

    expect(state.extracted).not.toBeNull();
    expect(state.extracted?.invoiceNumber).toBe("INV-2026-1997");
    expect(state.categorization).toBeNull();
    const warning = state.issues.find((i) => i.code === "MISSING_FIELD" && i.field === "category");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("category unavailable");
    // The decision is still computed, from the checks that did run.
    expect(state.decision).toBe("auto_approved");
    expect(state.risk?.level).toBe("low");
    expect(logger.lines.some((line) => line.includes("categorization failed for doc-009"))).toBe(true);
  });

  it("emits node_start / node_end progress events through the custom stream", async () => {
    const { context } = await makeContext();
    const events: ProgressEvent[] = [];
    for await (const chunk of await buildInvoiceGraph().stream(
      { document: doc("doc-009") },
      { context, streamMode: "custom" },
    )) {
      events.push(chunk as ProgressEvent);
    }

    const started = events.filter((e) => e.type === "node_start").map((e) => e.node);
    const ended = events.filter((e) => e.type === "node_end").map((e) => e.node);
    expect(started).toEqual(expect.arrayContaining(["extract", "validate", "categorize", "assess_risk"]));
    expect(ended).toEqual(expect.arrayContaining(["extract", "validate", "categorize", "assess_risk"]));
    expect(events.some((e) => e.type === "decision" && e.decision === "auto_approved")).toBe(true);
    expect(events.every((e) => !("documentId" in e) || e.documentId === "doc-009")).toBe(true);
  });
});
