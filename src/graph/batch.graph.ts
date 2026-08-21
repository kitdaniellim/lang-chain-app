import {
  END,
  START,
  Send,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { buildSummaryChain, type SummaryChainInput } from "../chains/summarize.js";
import {
  ReviewActionSchema,
  type BatchResult,
  type Decision,
  type DeliveryReceipt,
  type ProcessedInvoice,
  type ReviewAction,
  type RiskAssessment,
} from "../domain/schemas.js";
import { normalizeVendorName } from "../domain/vendors.js";
import { isRetryableError } from "../llm/errors.js";
import { PipelineContextSchema } from "../pipeline/context.js";
import { computeStats } from "../pipeline/stats.js";
import { currencyLabel } from "../report/format.js";
import type { PipelineContext, ReviewRequest } from "../pipeline/types.js";
import { receipt, type SinkContext } from "../sinks/types.js";
import { emitProgress, traced } from "./instrument.js";
import { buildInvoiceGraph, lookupPolicyExcerpts } from "./invoice.graph.js";
import { BatchState, ProcessInvoiceInput, upsertResults, type BatchStateType, type BatchUpdate } from "./state.js";

/** How many malformed resume payloads one review tolerates before the invoice is left queued. */
const MAX_REVIEW_ATTEMPTS = 3;

/** Backoff between summary stream attempts, multiplied by the attempt number. */
const SUMMARY_BACKOFF_MS = 100;

/** Written to `reviewerNote` when a review is given up on, so the report says why. */
export const ABANDONED_NOTE = `Review abandoned after ${MAX_REVIEW_ATTEMPTS} invalid payloads; left as needs_review`;

type Config = LangGraphRunnableConfig<PipelineContext>;

/** Risk stamped on an invoice whose extraction never produced anything to score. */
function extractionFailedRisk(): RiskAssessment {
  return { score: 100, level: "high", reasons: ["extraction failed"] };
}

/** Invoice numbers are matched trimmed and case-insensitively, exactly as the ledger does. */
function normaliseInvoiceNumber(value: string | null): string | null {
  const key = value?.trim().toLowerCase() ?? "";
  return key === "" ? null : key;
}

/** LangGraph exposes the run's thread id through `executionInfo` (undefined without a checkpointer). */
function threadIdOf(config: Config): string {
  return config.executionInfo?.threadId ?? "";
}

export interface BatchResultOptions {
  provider: string;
  threadId: string;
  /** Overrides the state's `finishedAt`, for the delivery that has not been recorded yet. */
  finishedAt?: string;
}

/** Projects the batch state into the report/sink-facing `BatchResult`. */
export function toBatchResult(state: BatchStateType, opts: BatchResultOptions): BatchResult {
  return {
    batchId: state.batchId,
    threadId: opts.threadId,
    startedAt: state.startedAt,
    finishedAt: opts.finishedAt ?? state.finishedAt,
    provider: opts.provider,
    // Copies, so a caller appending to the result cannot mutate checkpointed state.
    processed: [...state.results],
    stats: state.stats ?? computeStats(state.results),
    summary: state.summary,
    deliveries: [...state.deliveries],
  };
}

/** Stamps the run's start time and announces the workload. */
async function loadNode(state: BatchStateType, config: Config): Promise<BatchUpdate> {
  return traced("load", config, (): BatchUpdate => {
    emitProgress(config, { type: "info", message: `batch ${state.batchId}: ${state.documents.length} document(s)` });
    return { startedAt: new Date().toISOString() };
  });
}

/** One `Send` per document; an empty batch skips straight to collection. */
function fanOutRouter(state: BatchStateType): Send[] | "collect" {
  if (state.documents.length === 0) return "collect";
  return state.documents.map((document) => new Send("process_invoice", { document }));
}

/** Runs the per-invoice subgraph and folds its final state into one `ProcessedInvoice`. */
function processInvoiceNode(invoiceGraph: ReturnType<typeof buildInvoiceGraph>) {
  return async (input: typeof ProcessInvoiceInput.State, config: Config): Promise<BatchUpdate> => {
    // The parent config carries the context, the writer and the callbacks into the subgraph.
    const out = await invoiceGraph.invoke({ document: input.document }, config);
    const processed: ProcessedInvoice = {
      documentId: input.document.id,
      invoiceNumber: out.extracted?.invoiceNumber ?? null,
      extracted: out.extracted,
      issues: out.issues,
      categorization: out.categorization,
      risk: out.risk ?? extractionFailedRisk(),
      investigation: out.investigation,
      decision: out.decision,
      decidedBy: "system",
      reviewerNote: null,
      provider: out.provider,
      timings: out.timings,
    };
    return { results: [processed] };
  };
}

/** First document seen for one normalised invoice number — the keeper every later hit is compared to. */
interface FirstSeen {
  documentId: string;
  /** Normalised vendor, or null for an unnamed vendor (which only matches another unnamed one). */
  vendor: string | null;
  vendorName: string | null;
}

/** Mirrors the ledger's exact-duplicate rule: a null vendor only ever matches another null vendor. */
function sameVendor(a: FirstSeen["vendor"], b: FirstSeen["vendor"]): boolean {
  return a === null ? b === null : b !== null && a === b;
}

function vendorKeyOf(result: ProcessedInvoice): string | null {
  const name = result.extracted?.vendorName ?? null;
  return name === null ? null : normalizeVendorName(name);
}

/**
 * Fan-in: applies the ledger's duplicate rule inside the batch (same number + same vendor is a
 * double payment, same number from another vendor is a warning a human decides), recomputes the
 * statistics and builds the human-review queue.
 */
async function collectNode(state: BatchStateType, config: Config): Promise<BatchUpdate> {
  return traced("collect", config, (): BatchUpdate => {
    const firstSeen = new Map<string, FirstSeen>();
    const overrides: ProcessedInvoice[] = [];

    // `results` arrives sorted by document id, so the lowest id is always the keeper.
    for (const result of state.results) {
      const key = normaliseInvoiceNumber(result.invoiceNumber);
      if (key === null) continue;
      const vendor = vendorKeyOf(result);
      const original = firstSeen.get(key);
      if (original === undefined) {
        firstSeen.set(key, { documentId: result.documentId, vendor, vendorName: result.extracted?.vendorName ?? null });
        continue;
      }

      if (sameVendor(original.vendor, vendor)) {
        overrides.push({
          ...result,
          issues: [
            ...result.issues,
            {
              code: "DUPLICATE_IN_BATCH",
              severity: "error",
              message: `Invoice number ${result.invoiceNumber} was already processed in this batch as ${original.documentId}`,
              field: "invoiceNumber",
            },
          ],
          decision: "auto_rejected",
        });
        emitProgress(config, {
          type: "decision",
          documentId: result.documentId,
          decision: "auto_rejected",
          reason: `duplicate of ${original.documentId} in this batch`,
        });
        continue;
      }

      // Same number from a different vendor: suspicious enough for a human, never enough to auto-reject.
      const other = original.vendorName ?? "an unnamed vendor";
      const decision: Decision = result.decision === "auto_approved" ? "needs_review" : result.decision;
      overrides.push({
        ...result,
        issues: [
          ...result.issues,
          {
            code: "DUPLICATE_IN_BATCH",
            severity: "warning",
            message: `Invoice number ${result.invoiceNumber} also used by ${other} in this batch (${original.documentId})`,
            field: "invoiceNumber",
          },
        ],
        decision,
      });
      if (decision !== result.decision) {
        emitProgress(config, {
          type: "decision",
          documentId: result.documentId,
          decision,
          reason: `invoice number also used by ${other} in this batch`,
        });
      }
    }

    const merged = upsertResults(state.results, overrides);
    return {
      results: overrides,
      stats: computeStats(merged),
      reviewQueue: merged.filter((r) => r.decision === "needs_review").map((r) => r.documentId),
    };
  });
}

/** Pauses the graph for the next queued invoice and applies the human's answer. */
async function reviewNextNode(state: BatchStateType, config: Config): Promise<BatchUpdate> {
  const ctx = config.context!;
  const [documentId, ...rest] = state.reviewQueue;
  if (documentId === undefined) return {};

  const target = state.results.find((r) => r.documentId === documentId);
  if (target === undefined) {
    ctx.logger.warn(`review queue references unknown document ${documentId}`);
    return { reviewQueue: rest };
  }

  const request: ReviewRequest = {
    documentId,
    invoiceNumber: target.invoiceNumber,
    vendorName: target.extracted?.vendorName ?? null,
    total: target.extracted?.total ?? null,
    currency: target.extracted?.currency ?? null,
    risk: target.risk,
    issues: target.issues,
    investigation: target.investigation,
    // Not carried on ProcessedInvoice; the BM25 lookup is deterministic, so re-running it is free.
    policyExcerpts: await lookupPolicyExcerpts(ctx, target.issues),
    remaining: rest.length,
  };

  const action = askReviewer(request, config);
  if (action === null) {
    emitProgress(config, {
      type: "warn",
      message: `review abandoned after ${MAX_REVIEW_ATTEMPTS} invalid payloads`,
      documentId,
    });
    // Keep the invoice queued-but-undecided in the report rather than losing why it stalled.
    return {
      results: [{ ...target, reviewerNote: ABANDONED_NOTE }],
      reviewQueue: rest,
    };
  }

  const decision: Decision = action.action === "approve" ? "approved_by_human" : "rejected_by_human";
  emitProgress(config, { type: "decision", documentId, decision, reason: action.note || "reviewed" });
  return {
    results: [{ ...target, decision, decidedBy: "human", reviewerNote: action.note === "" ? null : action.note }],
    reviewQueue: rest,
  };
}

/**
 * Interrupts until a valid `ReviewAction` comes back. LangGraph replays the node on
 * resume, so each further `interrupt()` call is matched with the next resume value.
 */
function askReviewer(request: ReviewRequest, config: Config): ReviewAction | null {
  const ctx = config.context!;
  let payload: ReviewRequest = request;

  // No progress event here: LangGraph replays this node on every resume, so an emit
  // inside the loop would re-announce reviews that were already answered. `runBatch`
  // announces each genuine pause instead, once, from the interrupt it actually sees.
  for (let attempt = 0; attempt < MAX_REVIEW_ATTEMPTS; attempt += 1) {
    const parsed = ReviewActionSchema.safeParse(interrupt<ReviewRequest, unknown>(payload));
    if (parsed.success) return parsed.data;

    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    ctx.logger.warn(`invalid review payload for ${request.documentId}: ${detail}`);
    payload = { ...request, error: `Invalid review payload: ${detail}` };
  }

  ctx.logger.warn(`leaving ${request.documentId} unreviewed after ${MAX_REVIEW_ATTEMPTS} invalid payloads`);
  return null;
}

/** Recomputes the stats after review and streams the prose digest token by token. */
async function summarizeNode(state: BatchStateType, config: Config): Promise<BatchUpdate> {
  return traced("summarize", config, async (): Promise<BatchUpdate> => {
    const ctx = config.context!;
    const stats = computeStats(state.results);
    const highlights = state.results
      .filter((r) => r.decision !== "auto_approved")
      .map((r) => `${r.documentId} ${r.invoiceNumber ?? "(no number)"}: ${r.decision} (risk ${r.risk.score})`);
    const { currencies } = currencyLabel(state.results);
    return { stats, summary: await writeSummary(ctx, { stats, highlights, currencies }, config) };
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries the primary's stream on transient failures, exactly like `resilient()` does for
 * the non-streaming chains; a non-retryable error stops immediately.
 */
async function streamWithRetry(ctx: PipelineContext, input: SummaryChainInput, config: Config): Promise<string> {
  const attempts = Math.max(1, ctx.models.maxRetries);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await streamText(ctx, input, config, false);
    } catch (error) {
      if (attempt >= attempts || !isRetryableError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`summary attempt ${attempt}/${attempts} failed (${message}); retrying`);
      await delay(SUMMARY_BACKOFF_MS * attempt);
    }
  }
}

/**
 * Streams the summary chain directly (not through `resilient`, which cannot stream),
 * retries transient failures itself, then falls back to the secondary provider before
 * giving up on a sentence of prose.
 */
async function writeSummary(ctx: PipelineContext, input: SummaryChainInput, config: Config): Promise<string> {
  try {
    return await streamWithRetry(ctx, input, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.models.fallback !== null) {
      ctx.logger.warn(`summary via ${ctx.models.primaryTag} failed (${message}); using ${ctx.models.fallbackTag}`);
      emitProgress(config, { type: "warn", message: `summary fell back to ${ctx.models.fallbackTag}` });
      try {
        return await streamText(ctx, input, config, true);
      } catch (fallbackError) {
        const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        ctx.logger.error(`summary fallback failed: ${detail}`);
        return `Summary unavailable: ${detail}`;
      }
    }
    ctx.logger.warn(`summary failed: ${message}`);
    return `Summary unavailable: ${message}`;
  }
}

async function streamText(
  ctx: PipelineContext,
  input: SummaryChainInput,
  config: Config,
  useFallback: boolean,
): Promise<string> {
  const model = useFallback ? ctx.models.fallback! : ctx.models.primary;
  let text = "";
  for await (const piece of await buildSummaryChain(model).stream(input, config)) text += piece;
  return text;
}

/** Fans the finished batch out to every sink; a rejected promise becomes a failed receipt. */
async function deliverNode(state: BatchStateType, config: Config): Promise<BatchUpdate> {
  return traced("deliver", config, async (): Promise<BatchUpdate> => {
    const ctx = config.context!;
    const finishedAt = new Date().toISOString();
    const result = toBatchResult(state, { provider: ctx.models.primaryTag, threadId: threadIdOf(config), finishedAt });
    const sinkContext: SinkContext = { batchDir: ctx.batchDir, logger: ctx.logger };

    const settled = await Promise.allSettled(ctx.sinks.map((sink) => sink.deliver(result, sinkContext)));
    const deliveries: DeliveryReceipt[] = settled.map((outcome, index) =>
      outcome.status === "fulfilled"
        ? outcome.value
        : receipt(ctx.sinks[index]!.name, false, String(outcome.reason)),
    );
    for (const delivery of deliveries) {
      emitProgress(config, { type: "delivery", sink: delivery.sink, ok: delivery.ok, detail: delivery.detail });
    }
    return { deliveries, finishedAt };
  });
}

export interface BuildBatchGraphOptions {
  checkpointer?: BaseCheckpointSaver;
}

/**
 * Batch graph: fan out one subgraph run per document, fan back in, pause for every
 * invoice a human must see, then summarise and deliver.
 */
export function buildBatchGraph(opts: BuildBatchGraphOptions = {}) {
  const invoiceGraph = buildInvoiceGraph();

  return new StateGraph(BatchState, PipelineContextSchema)
    .addNode("load", loadNode)
    .addNode("fan_out", (): BatchUpdate => ({}))
    .addNode("process_invoice", processInvoiceNode(invoiceGraph), { input: ProcessInvoiceInput })
    .addNode("collect", collectNode)
    // Not wrapped in `traced`: `interrupt()` throws GraphInterrupt, so a `finally`
    // would emit a node_end "completed" event on every pause.
    .addNode("review_next", reviewNextNode)
    .addNode("summarize", summarizeNode)
    .addNode("deliver", deliverNode)
    .addEdge(START, "load")
    .addEdge("load", "fan_out")
    .addConditionalEdges("fan_out", fanOutRouter, ["process_invoice", "collect"])
    .addEdge("process_invoice", "collect")
    .addConditionalEdges("collect", nextAfterReview, ["review_next", "summarize"])
    .addConditionalEdges("review_next", nextAfterReview, ["review_next", "summarize"])
    .addEdge("summarize", "deliver")
    .addEdge("deliver", END)
    .compile(opts.checkpointer ? { checkpointer: opts.checkpointer } : {});
}

/** Keep pausing while the review queue still holds an invoice. */
function nextAfterReview(state: BatchStateType): "review_next" | "summarize" {
  return state.reviewQueue.length > 0 ? "review_next" : "summarize";
}
