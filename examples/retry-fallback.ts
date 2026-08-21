/**
 * Resilience — the two layers the pipeline uses when a model misbehaves:
 * chain-level retry + provider fallback, and node-level retry inside a graph.
 */
import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { buildExtractChain } from "../src/chains/extract.js";
import { generateBatch } from "../src/data/generator.js";
import { TransientModelError, isRetryableError } from "../src/llm/errors.js";
import { ScriptedChatModel } from "../src/llm/fake-model.js";
import { resilient } from "../src/llm/factory.js";
import type { ModelBundle } from "../src/llm/types.js";

const MAX_RETRIES = 3;

async function chainLevel(): Promise<void> {
  // A flaky "primary" provider and a dependable fallback, exactly as createModels wires them.
  const primary = new ScriptedChatModel({ failureRate: 0.7, seed: 1 });
  const fallback = new ScriptedChatModel();
  const models: ModelBundle = {
    primary,
    primaryTag: "anthropic:claude-opus-5",
    fallback,
    fallbackTag: "fake",
    maxRetries: MAX_RETRIES,
  };

  console.log(`1. resilient(): up to ${MAX_RETRIES} attempts on the flaky primary, then the fallback\n`);
  const manifest = generateBatch({ count: 3, seed: 11, defectRate: 0 });

  for (const document of manifest.documents) {
    let lastError = "";
    const before = { primary: primary.calls, fallback: fallback.calls };
    const chain = resilient(models, buildExtractChain, {
      runName: "extract",
      onFallback: (error) => {
        lastError = error.message;
      },
    });

    const tagged = await chain.invoke({ document });
    const attempts = primary.calls - before.primary;
    const fellBack = fallback.calls - before.fallback > 0;
    console.log(
      `   ${document.id}: ${attempts} primary attempt(s), ${fellBack ? "fell back" : "primary succeeded"}` +
        ` → provider "${tagged.provider}", invoice ${tagged.value.invoiceNumber}`,
    );
    if (fellBack) console.log(`     last primary error: ${lastError}`);
  }

  // A primary that is completely down, so the fallback provider always answers.
  const down = new ScriptedChatModel({ failureRate: 1, seed: 1 });
  let downError = "";
  const tagged = await resilient(
    { ...models, primary: down },
    buildExtractChain,
    { onFallback: (error) => (downError = error.message) },
  ).invoke({ document: manifest.documents[0]! });
  console.log(`   primary down: ${down.calls} attempt(s), all failed → provider "${tagged.provider}"`);
  console.log(`     last primary error: ${downError}`);
}

/** State for the one-node graph below: how many attempts it took. */
const FlakyState = new StateSchema({
  attempts: z.number().default(0),
  done: z.boolean().default(false),
});

async function nodeLevel(): Promise<void> {
  console.log("\n2. Node retryPolicy: the node throws twice, LangGraph re-runs it\n");
  let calls = 0;

  const graph = new StateGraph(FlakyState)
    .addNode(
      "flaky",
      () => {
        calls += 1;
        if (calls <= 2) {
          console.log(`   attempt ${calls}: throwing TransientModelError`);
          throw new TransientModelError(`simulated failure on attempt ${calls}`);
        }
        console.log(`   attempt ${calls}: succeeded`);
        return { attempts: calls, done: true };
      },
      // retryOn is what keeps a genuine bug from being retried forever.
      { retryPolicy: { maxAttempts: 4, retryOn: isRetryableError, logWarning: false } },
    )
    .addEdge(START, "flaky")
    .addEdge("flaky", END)
    .compile();

  const result = await graph.invoke({});
  console.log(`   final state: attempts=${result.attempts}, done=${result.done}`);
}

console.log("Retry and fallback: chain-level resilience, then node-level retryPolicy\n");
await chainLevel();
await nodeLevel();
