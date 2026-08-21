/**
 * Streaming — three levels of it: LCEL tokens, LCEL events, and LangGraph node updates.
 * Offline: the fake model streams real chunks through the real LangChain code paths.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSummaryChain, type SummaryChainInput } from "../src/chains/summarize.js";
import { loadConfig } from "../src/config.js";
import { generateBatch } from "../src/data/generator.js";
import type { BatchStats } from "../src/domain/schemas.js";
import { buildInvoiceGraph } from "../src/graph/invoice.graph.js";
import { ScriptedChatModel } from "../src/llm/fake-model.js";
import { createMemoryLogger } from "../src/observability/logger.js";
import { createPipelineContext } from "../src/pipeline/context.js";
import type { ProgressEvent } from "../src/pipeline/types.js";

const STATS: BatchStats = {
  total: 4, autoApproved: 2, approvedByHuman: 1, rejectedByHuman: 0, autoRejected: 1, needsReview: 0,
  approvedAmount: 8100, totalAmount: 11400, byCategory: { CLOUD_HOSTING: 2, TRAVEL: 2 },
  issuesByCode: { TOTAL_MISMATCH: 1, MISSING_PO: 2 },
};
const SUMMARY_INPUT: SummaryChainInput = {
  stats: STATS,
  highlights: ["doc-002 INV-2026-1004: auto_rejected"],
  currencies: ["USD"],
};

async function main(): Promise<void> {
  console.log("Streaming: .stream() tokens, streamEvents({ version: 'v2' }), LangGraph streamMode\n");
  const chain = buildSummaryChain(new ScriptedChatModel());

  // 1. .stream() yields the parser's output piece by piece, as the model produces it.
  console.log("1. .stream() — tokens as they arrive");
  process.stdout.write("   ");
  let tokens = 0;
  for await (const piece of await chain.stream(SUMMARY_INPUT)) {
    process.stdout.write(piece);
    tokens += 1;
  }
  console.log(`\n   (${tokens} chunks)\n`);

  // 2. streamEvents reports the lifecycle of every runnable in the chain, not just the output.
  const counts = new Map<string, number>();
  for await (const event of chain.streamEvents(SUMMARY_INPUT, { version: "v2" })) {
    counts.set(event.event, (counts.get(event.event) ?? 0) + 1);
  }
  console.log("2. streamEvents({ version: \"v2\" }) — event names and how often each fired");
  for (const [name, count] of counts) console.log(`   ${name} x${count}`);
  console.log();

  // 3. A LangGraph run streams two channels at once: state updates and our own progress events.
  const manifest = generateBatch({ count: 3, seed: 7, defectRate: 1 });
  const document = manifest.documents[0]!;
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "streaming-example-"));
  try {
    const config = loadConfig({ llmProvider: "fake", outDir }, {} as NodeJS.ProcessEnv);
    const { context } = await createPipelineContext({
      config,
      batchId: manifest.batchId,
      batchDir: path.join(outDir, manifest.batchId),
      logger: createMemoryLogger("error"),
      sinks: [],
    });

    console.log(`3. LangGraph streamMode: ["updates", "custom"] over the invoice subgraph (${document.id})`);
    const stream = await buildInvoiceGraph().stream(
      { document },
      { context, streamMode: ["updates", "custom"] },
    );
    for await (const chunk of stream) {
      const [mode, payload] = chunk as [string, unknown];
      if (mode === "updates") {
        console.log(`   updates → ${Object.keys(payload as Record<string, unknown>).join(", ")}`);
      } else {
        const event = payload as ProgressEvent;
        if (event.type === "node_end") console.log(`   custom  → ${event.node} finished in ${event.ms} ms`);
        if (event.type === "decision") console.log(`   custom  → decision ${event.decision}: ${event.reason}`);
      }
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

await main();
