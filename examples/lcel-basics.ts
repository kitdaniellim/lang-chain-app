/**
 * LCEL basics — how the pipeline's chains are composed.
 * Offline: everything runs against the deterministic fake model.
 */
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableLambda, RunnableParallel } from "@langchain/core/runnables";
import { buildCategorizeChain, type CategorizeChainInput } from "../src/chains/categorize.js";
import { SUMMARY_SYSTEM, buildSummaryChain, type SummaryChainInput } from "../src/chains/summarize.js";
import { PROMPT_MARKERS } from "../src/domain/constants.js";
import type { BatchStats, ExtractedInvoice } from "../src/domain/schemas.js";
import { ScriptedChatModel } from "../src/llm/fake-model.js";

const model = new ScriptedChatModel();

/** Only the vendor name and the line wording drive categorisation; the rest is filler. */
function extraction(vendorName: string, descriptions: string[]): ExtractedInvoice {
  const amount = 250;
  const total = amount * descriptions.length;
  return {
    invoiceNumber: "INV-2026-0001",
    vendorName,
    vendorEmail: null,
    issueDate: "2026-08-01",
    dueDate: "2026-08-31",
    currency: "USD",
    lineItems: descriptions.map((description) => ({ description, quantity: 1, unitPrice: amount, amount })),
    subtotal: total,
    taxRate: null,
    taxAmount: null,
    total,
    poNumber: null,
    confidence: 0.94,
    warnings: [],
  };
}

const STATS: BatchStats = {
  total: 3,
  autoApproved: 2,
  approvedByHuman: 1,
  rejectedByHuman: 0,
  autoRejected: 0,
  needsReview: 0,
  approvedAmount: 5400,
  totalAmount: 5400,
  byCategory: { SOFTWARE: 2, CLOUD_HOSTING: 1 },
  issuesByCode: { MISSING_PO: 1 },
};

const SHARED = {
  extracted: extraction("Northwind Software LLC", ["Annual subscription renewal", "Developer seats add-on"]),
  stats: STATS,
  highlights: ["doc-003 INV-2026-1016: approved_by_human (risk 47)"],
  currencies: ["USD"],
};
type Shared = typeof SHARED;

async function main(): Promise<void> {
  console.log("LCEL basics: prompt | model | parser, RunnableParallel, .batch(), RunnableLambda, withConfig\n");

  // 1. The canonical chain: a prompt template piped into a model piped into an output parser.
  const digest = ChatPromptTemplate.fromMessages([
    ["system", SUMMARY_SYSTEM],
    ["human", "{payload}"],
  ])
    .pipe(model)
    .pipe(new StringOutputParser());
  const payload = `${PROMPT_MARKERS.statsOpen}\n${JSON.stringify(STATS)}\n${PROMPT_MARKERS.statsClose}`;
  console.log("1. prompt | model | StringOutputParser\n  ", await digest.invoke({ payload }), "\n");

  // 2. RunnableParallel runs both branches at once; each starts with a RunnableLambda adapter.
  const both = RunnableParallel.from({
    category: RunnableLambda.from(
      (input: Shared): CategorizeChainInput => ({ extracted: input.extracted, vendorHint: null }),
    ).pipe(buildCategorizeChain(model)),
    digest: RunnableLambda.from(
      (input: Shared): SummaryChainInput => ({
        stats: input.stats,
        highlights: input.highlights,
        currencies: input.currencies,
      }),
    ).pipe(buildSummaryChain(model)),
  });
  const parallel = await both.invoke(SHARED);
  console.log("2. RunnableParallel (categorize + summarize at once)");
  console.log("   category:", parallel.category.category, `(gl ${parallel.category.glAccount})`);
  console.log("   digest  :", `${parallel.digest.slice(0, 80)}...`, "\n");

  // 3. One chain over many inputs, at most two model calls in flight.
  const categorize = buildCategorizeChain(model);
  const inputs: CategorizeChainInput[] = [
    { extracted: extraction("Acme Cloud Inc", ["Compute hours (c5.large)"]), vendorHint: null },
    { extracted: extraction("Paperclip Office Supply Co", ["Copy paper A4 (box)"]), vendorHint: null },
    { extracted: extraction("SkyLane Travel Partners", ["Return flight LAX-JFK"]), vendorHint: null },
  ];
  const batched = await categorize.batch(inputs, { maxConcurrency: 2 });
  console.log("3. .batch() over 3 inputs with maxConcurrency 2");
  console.log("  ", batched.map((c) => c.category).join(", "), "\n");

  // 4. withConfig stamps a run name and tags on the run and everything it spawns —
  //    that is what a trace groups on.
  //    Heads-up: core's callback typings and its runtime call disagree on argument order.
  //    handleChainStart is really invoked as (chain, inputs, runId, parentRunId, tags, metadata, runType, runName),
  //    so the run name is the 8th argument even though the .d.ts calls that slot parentRunId.
  const seen: string[] = [];
  let observedRunName = "";
  const named = digest.withConfig({ runName: "invoice-digest", tags: ["example", "lcel"] });
  await named.invoke(
    { payload },
    {
      callbacks: [
        {
          handleChainStart: (chain, _inputs, _runId, _parentRunId, tags, _metadata, _runName, runNameAtRuntime) => {
            seen.push(`${chain.id?.at(-1) ?? "?"}[${(tags ?? []).join(",")}]`);
            if (observedRunName === "" && runNameAtRuntime) observedRunName = runNameAtRuntime;
          },
        },
      ],
    },
  );
  console.log('4. withConfig({ runName: "invoice-digest", tags: ["example", "lcel"] })');
  console.log(`   runName reached: ${observedRunName}`);
  console.log("   tags reached:", seen.join(" "));
}

await main();
