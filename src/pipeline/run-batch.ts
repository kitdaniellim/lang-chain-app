import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { Command, type BaseCheckpointSaver, type Interrupt, type StreamMode } from "@langchain/langgraph";
import type { AppConfig } from "../config.js";
import type { LedgerEntry, LedgerReader, LedgerStore } from "../data/ledger.types.js";
import type { BatchManifest, BatchResult, ReviewAction } from "../domain/schemas.js";
import { buildBatchGraph, toBatchResult } from "../graph/batch.graph.js";
import { closeCheckpointer, createCheckpointer } from "../graph/checkpointer.js";
import type { BatchStateType } from "../graph/state.js";
import { receipt } from "../sinks/types.js";
import type { PipelineContext, ProgressEvent, ReviewRequest, Reviewer } from "./types.js";

const STREAM_MODES: StreamMode[] = ["updates", "custom", "messages"];

/** Review rounds allowed per document before the loop is declared stuck. */
const ROUNDS_PER_DOCUMENT = 3;
const ROUNDS_HEADROOM = 5;

export interface RunBatchOptions {
  manifest: BatchManifest;
  config: AppConfig;
  context: PipelineContext;
  /** Defaults to `createCheckpointer(config.checkpointer, config.outDir)`. */
  checkpointer?: BaseCheckpointSaver;
  reviewer: Reviewer;
  /** Defaults to the manifest's batch id; a fresh id replays the batch from scratch. */
  threadId?: string;
  callbacks?: BaseCallbackHandler[];
  /** Receives every `[mode, chunk]` the graph streams (`updates`, `custom`, `messages`). */
  onStream?: (mode: string, chunk: unknown) => void;
  /** Write side of the ledger; defaults to `context.ledger` when it is a store. */
  ledger?: LedgerStore;
}

export interface ResumeBatchOptions extends RunBatchOptions {
  /** Answer applied to the review interrupt already pending on the thread. */
  decision: ReviewAction;
}

export interface RunBatchOutcome {
  result: BatchResult;
  threadId: string;
  /**
   * Root-namespace checkpoints the run left behind (what `getStateHistory` / time-travel
   * can rewind to); the per-invoice subgraph namespaces are not included.
   */
  checkpoints: number;
}

/** Non-interactive reviewer: answers every pause with the same action. */
export function autoReviewer(mode: "approve" | "reject"): Reviewer {
  return async () => ({ action: mode, note: `auto-${mode} (non-interactive run)` });
}

function isLedgerStore(ledger: LedgerReader): ledger is LedgerStore {
  const candidate = ledger as Partial<LedgerStore>;
  return typeof candidate.append === "function" && typeof candidate.save === "function";
}

/** One ledger row per invoice that produced a number; unnumbered invoices cannot be deduped later. */
function toLedgerEntries(result: BatchResult): LedgerEntry[] {
  return result.processed.flatMap((invoice) =>
    invoice.invoiceNumber === null
      ? []
      : [
          {
            invoiceNumber: invoice.invoiceNumber,
            vendorName: invoice.extracted?.vendorName ?? null,
            total: invoice.extracted?.total ?? null,
            currency: invoice.extracted?.currency ?? null,
            issueDate: invoice.extracted?.issueDate ?? null,
            documentId: invoice.documentId,
            batchId: result.batchId,
            decision: invoice.decision,
            processedAt: result.finishedAt,
          },
        ],
  );
}

/** Compiles the graph and builds the two run configs shared by `runBatch` and `resumeBatch`. */
function prepareRun(opts: RunBatchOptions) {
  const threadId = opts.threadId ?? opts.manifest.batchId;
  // Only a checkpointer we opened ourselves may be closed again; a caller's outlives the run.
  const ownsCheckpointer = opts.checkpointer === undefined;
  const checkpointer = opts.checkpointer ?? createCheckpointer(opts.config.checkpointer, opts.config.outDir);
  const graph = buildBatchGraph({ checkpointer });

  const runConfig = {
    configurable: { thread_id: threadId },
    context: opts.context,
    // LangGraph's task runner honours this, so `--concurrency` really throttles the fan-out.
    maxConcurrency: opts.config.concurrency,
    ...(opts.callbacks ? { callbacks: opts.callbacks } : {}),
  };

  return {
    graph,
    checkpointer,
    ownsCheckpointer,
    runConfig,
    streamConfig: { ...runConfig, streamMode: [...STREAM_MODES] },
    threadId,
  };
}

type GraphRun = ReturnType<typeof prepareRun>;

async function pendingReviews(run: GraphRun): Promise<ReviewRequest[]> {
  const snapshot = await run.graph.getState(run.runConfig);
  const pending: Interrupt<ReviewRequest>[] = snapshot.tasks.flatMap((task) => task.interrupts ?? []);
  // An interrupt without a payload carries nothing a reviewer could answer.
  return pending.flatMap((entry) => (entry.value === undefined ? [] : [entry.value]));
}

/** Streams the graph, answering every review interrupt, until the thread settles. */
async function drive(run: GraphRun, firstInput: unknown, opts: RunBatchOptions): Promise<void> {
  let input = firstInput;
  const maxRounds = opts.manifest.documents.length * ROUNDS_PER_DOCUMENT + ROUNDS_HEADROOM;

  for (let round = 0; round < maxRounds; round += 1) {
    for await (const chunk of await run.graph.stream(input as never, run.streamConfig)) {
      const [mode, payload] = chunk as [string, unknown];
      opts.onStream?.(mode, payload);
    }

    const pending = await pendingReviews(run);
    if (pending.length === 0) return;

    // Announced here, not inside the node: the node is replayed on every resume.
    const request = pending[0]!;
    const event: ProgressEvent = {
      type: "review_request",
      documentId: request.documentId,
      remaining: request.remaining,
    };
    opts.onStream?.("custom", event);
    input = new Command({ resume: await opts.reviewer(request) });
  }

  throw new Error(`Batch ${opts.manifest.batchId} did not settle after ${maxRounds} review rounds`);
}

/** Projects the settled thread into a `BatchResult` and records it in the payment ledger. */
async function settle(run: GraphRun, opts: RunBatchOptions): Promise<RunBatchOutcome> {
  const state = (await run.graph.getState(run.runConfig)).values as BatchStateType;
  const result = toBatchResult(state, {
    provider: opts.context.models.primaryTag,
    threadId: run.threadId,
    finishedAt: state.finishedAt || new Date().toISOString(),
  });

  let checkpoints = 0;
  for await (const _ of run.graph.getStateHistory(run.runConfig)) checkpoints += 1;

  await recordInLedger(opts, result);
  return { result, threadId: run.threadId, checkpoints };
}

/**
 * Runs one batch to completion: stream, pause at every human-review interrupt, resume
 * with the reviewer's answer, then record the run in the payment ledger.
 */
export async function runBatch(opts: RunBatchOptions): Promise<RunBatchOutcome> {
  const run = prepareRun(opts);
  try {
    await drive(run, { batchId: opts.manifest.batchId, documents: opts.manifest.documents }, opts);
    return await settle(run, opts);
  } finally {
    releaseCheckpointer(run, opts);
  }
}

/**
 * Answers the interrupt a previous process left pending on `threadId` and finishes the batch.
 * Needs a checkpointer that outlives the process (sqlite) to be useful across CLI runs.
 */
export async function resumeBatch(opts: ResumeBatchOptions): Promise<RunBatchOutcome> {
  const run = prepareRun(opts);
  try {
    // Inside the try so a thread with nothing pending still releases the sqlite handle.
    const pending = await pendingReviews(run);
    if (pending.length === 0) {
      throw new Error(`Thread ${run.threadId} has no pending review to resume`);
    }

    await drive(run, new Command({ resume: opts.decision }), opts);
    return await settle(run, opts);
  } finally {
    releaseCheckpointer(run, opts);
  }
}

/** Closes a checkpointer we opened; a throwing close must never mask the run's real error. */
function releaseCheckpointer(run: GraphRun, opts: RunBatchOptions): void {
  if (!run.ownsCheckpointer) return;
  try {
    closeCheckpointer(run.checkpointer);
  } catch (error) {
    opts.context.logger.warn(`closing the checkpointer failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Appends the run's final decisions so the next batch can spot duplicates.
 * A write failure becomes a failed receipt rather than throwing away a finished run.
 */
async function recordInLedger(opts: RunBatchOptions, result: BatchResult): Promise<void> {
  const store = opts.ledger ?? (isLedgerStore(opts.context.ledger) ? opts.context.ledger : null);
  if (store === null) {
    opts.context.logger.debug("ledger is read-only; the run was not recorded");
    return;
  }

  try {
    store.append(toLedgerEntries(result));
    await store.save();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    opts.context.logger.error(`ledger write failed: ${message}`);
    result.deliveries.push(receipt("ledger", false, message));
  }
}
