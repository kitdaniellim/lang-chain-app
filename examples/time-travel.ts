/**
 * Time travel — rewind a finished batch to an earlier checkpoint, change a decision
 * there, and replay forward from that point. Offline, with the in-memory checkpointer.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { generateBatch } from "../src/data/generator.js";
import { buildBatchGraph } from "../src/graph/batch.graph.js";
import { createCheckpointer } from "../src/graph/checkpointer.js";
import type { BatchStateType } from "../src/graph/state.js";
import { createMemoryLogger } from "../src/observability/logger.js";
import { createPipelineContext } from "../src/pipeline/context.js";
import { autoReviewer, runBatch } from "../src/pipeline/run-batch.js";

async function main(): Promise<void> {
  console.log("Time travel: getStateHistory, updateState, replay from a past checkpoint\n");

  const manifest = generateBatch({ count: 3, seed: 7, defectRate: 1 });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "time-travel-example-"));
  try {
    const config = loadConfig({ llmProvider: "fake", outDir }, {} as NodeJS.ProcessEnv);
    const { context } = await createPipelineContext({
      config,
      batchId: manifest.batchId,
      batchDir: path.join(outDir, manifest.batchId),
      logger: createMemoryLogger("error"),
      sinks: [],
    });

    // 1. A normal run, approving everything a human was asked about.
    const checkpointer = createCheckpointer("memory", outDir);
    const { result, threadId } = await runBatch({
      manifest,
      config,
      context,
      checkpointer,
      reviewer: autoReviewer("approve"),
    });
    console.log(`1. first run — ${result.stats.total} invoices, ${checkpointerSummary(result.stats)}`);
    for (const invoice of result.processed) console.log(`   ${invoice.documentId}: ${invoice.decision}`);

    // 2. The same checkpointer replays the whole run, step by step.
    const graph = buildBatchGraph({ checkpointer });
    const runConfig = { configurable: { thread_id: threadId }, context };
    const history = [];
    for await (const snapshot of graph.getStateHistory(runConfig)) history.push(snapshot);

    console.log(`\n2. getStateHistory — ${history.length} checkpoints (newest first)`);
    for (const snapshot of history.slice(0, 6)) {
      const next = snapshot.next.join(", ") || "-";
      console.log(`   step ${snapshot.metadata?.step} (${snapshot.metadata?.source}): next [${next}]`);
    }

    // 3. Rewind to the checkpoint collect produced — the oldest one that has the fan-in
    //    behind it — and reject an invoice the reviewer had approved.
    const oldestFirst = [...history].reverse();
    const target = oldestFirst.find((s) => s.next.includes("review_next") || s.next.includes("summarize"));
    if (target === undefined) throw new Error("no checkpoint after collect was found");

    const values = target.values as BatchStateType;
    const victim = values.results[0]!;
    console.log(`\n3. rewinding to step ${target.metadata?.step} and rejecting ${victim.documentId}`);
    const forked = await graph.updateState(
      target.config,
      // The queue is emptied in the same write: this decision replaces the human review.
      { results: [{ ...victim, decision: "auto_rejected", reviewerNote: "rejected by time travel" }], reviewQueue: [] },
      "collect",
    );

    // 4. `null` input means "carry on from that checkpoint" — summarize and deliver re-run.
    const replayed = (await graph.invoke(null, { ...forked, context })) as BatchStateType;
    console.log(`\n4. replayed from the fork — ${checkpointerSummary(replayed.stats!)}`);
    for (const invoice of replayed.results) console.log(`   ${invoice.documentId}: ${invoice.decision}`);
    console.log(`\n   new summary: ${replayed.summary.slice(0, 120)}...`);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

function checkpointerSummary(stats: { autoApproved: number; approvedByHuman: number; autoRejected: number }): string {
  return `${stats.autoApproved} auto-approved, ${stats.approvedByHuman} approved by human, ${stats.autoRejected} auto-rejected`;
}

await main();
