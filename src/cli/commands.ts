import pc from "picocolors";
import { loadConfig, type AppConfig, type ConfigOverrides } from "../config.js";
import { assertBatchId, batchDir, readManifest, readResult, writeBatch } from "../data/batch-store.js";
import { generateBatch } from "../data/generator.js";
import type { BatchManifest, DeliveryReceipt } from "../domain/schemas.js";
import { evaluateBatch, renderEvaluation } from "../evaluate/evaluate.js";
import { buildBatchGraph } from "../graph/batch.graph.js";
import { buildInvoiceGraph } from "../graph/invoice.graph.js";
import { createStreamAwareLogger, type Logger } from "../observability/logger.js";
import { createProgressPrinter } from "../observability/progress.js";
import { UsageTracker } from "../observability/usage-tracker.js";
import { createPipelineContext, type PipelineContextBundle } from "../pipeline/context.js";
import { resumeBatch, runBatch, type RunBatchOutcome } from "../pipeline/run-batch.js";
import type { ReviewMode } from "../pipeline/types.js";
import { createSinks, type EmailSinkOptions } from "../sinks/index.js";
import { renderDocumentTable, renderDocumentText, renderGroundTruthTable } from "./preview.js";
import { defaultReviewMode, resolveReviewer, type ClosableReviewer } from "./reviewers.js";

/** What the caller needs to pick an exit code. */
export interface RunOutcomeSummary {
  batchId: string;
  threadId: string;
  failedDeliveries: number;
}

export interface GenerateArgs {
  count: number;
  seed: number;
  defectRate: number;
  batchId?: string;
  out?: string;
}

export interface PreviewArgs {
  show?: string;
  groundTruth?: boolean;
  out?: string;
}

export interface RunArgs {
  provider?: "fake" | "anthropic";
  model?: string;
  review?: ReviewMode;
  email?: string;
  chaos?: number;
  checkpointer?: "memory" | "sqlite";
  concurrency?: number;
  out?: string;
  /** `demo` prints the evaluation itself, through the `evaluate` command. */
  evaluate?: boolean;
}

export interface ResumeArgs extends RunArgs {
  decision: "approve" | "reject";
  note?: string;
}

export interface DemoArgs extends RunArgs {
  count: number;
  seed: number;
  defectRate?: number;
}

/** CLI flags win over `.env`; anything absent falls back to the environment. */
function configOverrides(args: RunArgs): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  if (args.provider) overrides.llmProvider = args.provider;
  if (args.model) overrides.anthropicModel = args.model;
  if (args.chaos !== undefined) overrides.fakeFailureRate = args.chaos;
  if (args.checkpointer) overrides.checkpointer = args.checkpointer;
  if (args.concurrency !== undefined) overrides.concurrency = args.concurrency;
  if (args.out) overrides.outDir = args.out;
  return overrides;
}

/** Email is only wired when a recipient exists; without SMTP the sink falls back to Ethereal. */
function emailOptions(config: AppConfig, to?: string): EmailSinkOptions | null {
  const recipient = to ?? config.email.to;
  if (!recipient) return null;
  const smtp = config.email.smtpHost
    ? {
        host: config.email.smtpHost,
        port: config.email.smtpPort,
        user: config.email.smtpUser,
        pass: config.email.smtpPass,
        secure: config.email.smtpSecure,
      }
    : undefined;
  return { to: recipient, from: config.email.from, smtp };
}

function receiptLine(delivery: DeliveryReceipt): string {
  const mark = delivery.ok ? pc.green("✓") : pc.red("✗");
  return `  ${mark} ${delivery.sink} — ${delivery.detail}`;
}

/**
 * Generates a batch and shows both views of it: the documents the pipeline will read,
 * and the ground truth it has to rediscover.
 */
export async function generateCommand(args: GenerateArgs, logger: Logger): Promise<BatchManifest> {
  const config = loadConfig(args.out ? { outDir: args.out } : {}, process.env, { requireModelCredentials: false });
  if (args.batchId !== undefined) assertBatchId(args.batchId);
  const manifest = generateBatch({
    count: args.count,
    seed: args.seed,
    defectRate: args.defectRate,
    batchId: args.batchId,
    // A real timestamp, so two generate runs never collide on a batch id.
    now: new Date(),
  });

  const dir = await writeBatch(config.outDir, manifest);
  logger.raw(renderDocumentTable(manifest));
  logger.raw(renderGroundTruthTable(manifest));
  logger.info(`seed ${manifest.seed} — pass --seed ${manifest.seed} to reproduce this batch`);
  logger.info(`batch ${pc.bold(manifest.batchId)} written to ${dir}`);
  return manifest;
}

export async function previewCommand(batchId: string, args: PreviewArgs, logger: Logger): Promise<void> {
  const config = loadConfig(args.out ? { outDir: args.out } : {}, process.env, { requireModelCredentials: false });
  const manifest = await readManifest(config.outDir, batchId);

  logger.raw(renderDocumentTable(manifest));
  if (args.groundTruth) logger.raw(renderGroundTruthTable(manifest));
  if (args.show) logger.raw(renderDocumentText(manifest, args.show));
}

/** Deliveries, cost, checkpoints and (when the batch has ground truth) the evaluation. */
function reportRun(
  logger: Logger,
  manifest: BatchManifest,
  outcome: RunBatchOutcome,
  tracker: UsageTracker,
  showEvaluation: boolean,
): RunOutcomeSummary {
  const { result, threadId, checkpoints } = outcome;

  logger.raw(pc.bold("\nDeliveries"));
  for (const delivery of result.deliveries) logger.raw(receiptLine(delivery));

  logger.raw(pc.bold("\nLLM usage"));
  logger.raw(tracker.renderSummary());
  logger.raw(pc.dim(`\n${checkpoints} checkpoint(s) on thread ${threadId}`));

  if (showEvaluation && manifest.groundTruth.length > 0) {
    logger.raw(pc.bold("\nEvaluation vs ground truth"));
    logger.raw(renderEvaluation(evaluateBatch(manifest, result)));
  }

  return {
    batchId: result.batchId,
    threadId,
    failedDeliveries: result.deliveries.filter((delivery) => !delivery.ok).length,
  };
}

/** Everything `runBatch` / `resumeBatch` share, so the two commands differ by one call. */
interface RunHandles {
  manifest: BatchManifest;
  config: AppConfig;
  context: PipelineContextBundle["context"];
  ledger: PipelineContextBundle["ledger"];
  reviewer: ClosableReviewer;
  callbacks: UsageTracker[];
  onStream: (mode: string, chunk: unknown) => void;
}

interface Wiring {
  manifest: BatchManifest;
  tracker: UsageTracker;
  run: (mode: ReviewMode, execute: (handles: RunHandles) => Promise<RunBatchOutcome>) => Promise<RunBatchOutcome>;
}

/** Shared wiring for `run` and `resume`: config, manifest, sinks, context, tracker, progress. */
async function wire(batchId: string, args: RunArgs, logger: Logger): Promise<Wiring> {
  const config = loadConfig(configOverrides(args));
  const manifest = await readManifest(config.outDir, batchId);
  const sinks = createSinks({ email: emailOptions(config, args.email) });
  const { context, ledger } = await createPipelineContext({
    config,
    batchId,
    batchDir: batchDir(config.outDir, batchId),
    // Everything logged inside a node (sink tables included) rides the graph stream, so it
    // lands after the tokens it followed instead of racing them to stdout.
    logger: createStreamAwareLogger({ level: logger.level }),
    sinks,
  });
  const tracker = new UsageTracker();

  const run = async (
    mode: ReviewMode,
    execute: (handles: RunHandles) => Promise<RunBatchOutcome>,
  ): Promise<RunBatchOutcome> => {
    const printer = createProgressPrinter(logger);
    const reviewer = resolveReviewer(mode, logger);
    logger.info(
      `batch ${batchId}: ${manifest.documents.length} document(s) · provider ${context.models.primaryTag} · review ${mode}`,
    );
    try {
      return await execute({
        manifest,
        config,
        context,
        ledger,
        reviewer,
        callbacks: [tracker],
        onStream: (streamMode, chunk) => printer.onEvent(streamMode, chunk),
      });
    } finally {
      // readline is released first: a throwing finish() must never leave stdin open.
      reviewer.close();
      printer.finish();
    }
  };

  return { manifest, tracker, run };
}

/** Processes one generated batch end to end. The processed table is printed by the ConsoleSink. */
export async function runCommand(batchId: string, args: RunArgs, logger: Logger): Promise<RunOutcomeSummary> {
  const { manifest, tracker, run } = await wire(batchId, args, logger);
  const outcome = await run(args.review ?? defaultReviewMode(), (handles) => runBatch(handles));
  return reportRun(logger, manifest, outcome, tracker, args.evaluate !== false);
}

/** Answers the review a previous process left pending, then finishes the rest of the queue. */
export async function resumeCommand(threadId: string, args: ResumeArgs, logger: Logger): Promise<RunOutcomeSummary> {
  // The interrupt lives in the checkpointer, so an in-memory one has nothing to resume from.
  const probe = loadConfig(configOverrides(args));
  if (probe.checkpointer !== "sqlite") {
    throw new Error("resume needs a durable checkpointer — pass --checkpointer sqlite (or set CHECKPOINTER=sqlite)");
  }

  // Threads are named after their batch, which is how `run` creates them.
  const { manifest, tracker, run } = await wire(threadId, args, logger);
  logger.info(`resuming thread ${threadId} with "${args.decision}"`);

  const outcome = await run(args.review ?? defaultReviewMode(), (handles) =>
    resumeBatch({ ...handles, threadId, decision: { action: args.decision, note: args.note ?? "" } }),
  );
  return reportRun(logger, manifest, outcome, tracker, args.evaluate !== false);
}

/** Scores a finished batch against the ground truth the pipeline never saw. */
export async function evaluateCommand(batchId: string, args: { out?: string }, logger: Logger): Promise<void> {
  const config = loadConfig(args.out ? { outDir: args.out } : {}, process.env, { requireModelCredentials: false });
  const manifest = await readManifest(config.outDir, batchId);
  const result = await readResult(config.outDir, batchId);
  if (result === null) {
    throw new Error(`Batch ${batchId} has no results yet — run it first: npm run cli -- run ${batchId}`);
  }

  logger.raw(pc.bold(`\nEvaluation — batch ${batchId}`));
  logger.raw(renderEvaluation(evaluateBatch(manifest, result)));
}

export type GraphKind = "invoice" | "batch" | "both";

/** Prints the compiled graphs as Mermaid, straight from LangGraph. */
export async function graphCommand(args: { which?: GraphKind }, logger: Logger): Promise<void> {
  const which = args.which ?? "both";

  if (which !== "batch") {
    logger.raw(pc.bold("\n## invoice subgraph — one run per document"));
    logger.raw((await buildInvoiceGraph().getGraphAsync()).drawMermaid());
  }
  if (which !== "invoice") {
    logger.raw(pc.bold("\n## batch graph — fan out, review, summarise, deliver"));
    logger.raw((await buildBatchGraph().getGraphAsync()).drawMermaid());
  }
}

const WHAT_JUST_HAPPENED = [
  "",
  pc.bold("What just happened"),
  "  1. generate     seeded invoices rendered as plain text, email and ASCII tables, with defects injected.",
  "  2. LCEL chains  prompt | model | structured output for extraction, few-shot categorisation, streamed summary.",
  "  3. resilience   chains run through resilient(): retry on transient errors, then fall back to another provider.",
  "  4. subgraph     LangGraph fans out one invoice graph per document: extract, validate + categorise, assess_risk.",
  "  5. RAG          a BM25 retriever pulls the policy passages that explain each flagged issue.",
  "  6. agent        createAgent plus four deterministic tools writes the investigator brief for risky invoices.",
  "  7. human loop   interrupt() pauses the batch per queued invoice; Command({ resume }) applies the decision.",
  "  8. checkpoints  every step is saved, so `resume` and the time-travel example can rewind the run.",
  "  9. delivery     console table, JSON/CSV/HTML/Markdown files and (with --email) an email, each with a receipt.",
  " 10. evaluation   the run is scored against ground truth the pipeline never saw.",
  "",
].join("\n");

/** generate then run then evaluate, offline, in one command. */
export async function demoCommand(args: DemoArgs, logger: Logger): Promise<RunOutcomeSummary> {
  const manifest = await generateCommand(
    { count: args.count, seed: args.seed, defectRate: args.defectRate ?? 0.35, out: args.out },
    logger,
  );

  const summary = await runCommand(
    manifest.batchId,
    { ...args, review: args.review ?? "approve", evaluate: false },
    logger,
  );

  // Evaluating a batch whose file sink failed would report "no results yet" and hide the real cause.
  if (summary.failedDeliveries > 0) return summary;

  await evaluateCommand(manifest.batchId, { out: args.out }, logger);
  logger.raw(WHAT_JUST_HAPPENED);
  return summary;
}
