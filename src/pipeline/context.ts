import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { JsonLedger } from "../data/ledger.js";
import type { LedgerStore } from "../data/ledger.types.js";
import { LEDGER_FILENAME } from "../domain/constants.js";
import { DEFAULT_POLICY, type ApprovalPolicy } from "../domain/policy.js";
import { createModels } from "../llm/factory.js";
import type { ModelBundle } from "../llm/types.js";
import type { Logger } from "../observability/logger.js";
import { PolicyRetriever } from "../rag/policy-retriever.js";
import type { Sink } from "../sinks/types.js";
import { createTools } from "../tools/index.js";
import type { PipelineContext } from "./types.js";

/**
 * LangGraph context schema. It must be a zod *object* (`StateDefinitionInit` rejects
 * `z.custom`), but every field holding a live object stays an unchecked passthrough.
 */
export const PipelineContextSchema = z.object({
  models: z.custom<PipelineContext["models"]>(),
  tools: z.custom<PipelineContext["tools"]>(),
  ledger: z.custom<PipelineContext["ledger"]>(),
  retriever: z.custom<PipelineContext["retriever"]>(),
  policy: z.custom<PipelineContext["policy"]>(),
  sinks: z.custom<PipelineContext["sinks"]>(),
  logger: z.custom<PipelineContext["logger"]>(),
  batchDir: z.string(),
  batchId: z.string(),
});

export interface CreatePipelineContextOptions {
  config: AppConfig;
  batchId: string;
  /** Where this batch's artefacts are written (`<outDir>/<batchId>`). */
  batchDir: string;
  logger: Logger;
  sinks: Sink[];
  /** Injected in tests; defaults to `createModels(config)`. */
  models?: ModelBundle;
  policy?: ApprovalPolicy;
}

/**
 * The context plus the ledger's write side. `PipelineContext.ledger` is read-only
 * by design; `runBatch` needs the store to append the run's final decisions.
 */
export interface PipelineContextBundle {
  context: PipelineContext;
  ledger: LedgerStore;
}

/** Loads the ledger, indexes the policy handbook and wires the tools for one batch. */
export async function createPipelineContext(opts: CreatePipelineContextOptions): Promise<PipelineContextBundle> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const ledger = await JsonLedger.load(path.join(opts.config.outDir, LEDGER_FILENAME));
  const retriever = await PolicyRetriever.fromPolicy(policy);
  const tools = createTools({ ledger, retriever, policy, batchId: opts.batchId });

  const context: PipelineContext = {
    models: opts.models ?? createModels(opts.config),
    tools,
    ledger,
    retriever,
    policy,
    sinks: opts.sinks,
    logger: opts.logger,
    batchDir: opts.batchDir,
    batchId: opts.batchId,
  };

  return { context, ledger };
}
