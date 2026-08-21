import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig, type AppConfig } from "../config.js";
import { batchDir, writeBatch } from "../data/batch-store.js";
import { generateBatch } from "../data/generator.js";
import type { BatchManifest, BatchResult, ReviewAction } from "../domain/schemas.js";
import { evaluateBatch, type EvaluationReport } from "../evaluate/evaluate.js";
import { createStreamAwareLogger, type Logger } from "../observability/logger.js";
import { UsageTracker } from "../observability/usage-tracker.js";
import { createPipelineContext } from "../pipeline/context.js";
import { runBatch } from "../pipeline/run-batch.js";
import type { ProgressEvent, ReviewRequest, Reviewer } from "../pipeline/types.js";
import { EmailSink, FileSink } from "../sinks/index.js";
import type { Sink } from "../sinks/types.js";
import { HttpError } from "./http.js";

/** Body of `POST /api/run`. */
export const StartRunSchema = z.object({
  count: z.coerce.number().int().min(1).max(50),
  seed: z.coerce.number().int().min(0).optional(),
  defectRate: z.coerce.number().min(0).max(1).optional(),
  email: z.string().min(3).optional(),
});
export type StartRunInput = z.infer<typeof StartRunSchema>;

/** What the browser subscribes to, before the stream stamps a sequence number on it. */
export type RunEventPayload =
  | { type: "progress"; data: ProgressEvent }
  | { type: "token"; data: { text: string } }
  | { type: "review"; data: ReviewRequest }
  | { type: "done"; data: { result: BatchResult; evaluation: EvaluationReport | null; checkpoints: number } }
  | { type: "error"; data: { message: string } };

export type RunEvent = RunEventPayload & { seq: number };

export type RunStatus = "running" | "done" | "error";
export type RunListener = (event: RunEvent) => void;

export interface RunRecord {
  runId: string;
  batchId: string;
  status: RunStatus;
  startedAt: string;
  events: RunEvent[];
  listeners: Set<RunListener>;
  pending: { request: ReviewRequest; resolve: (action: ReviewAction) => void } | null;
  nextSeq: number;
  /** Set once the replay buffer is full, so the warning is only emitted once. */
  bufferFull: boolean;
}

export interface RunSummary {
  runId: string;
  batchId: string;
  status: RunStatus;
  startedAt: string;
  awaitingReview: boolean;
}

/** How much of a run can be replayed to a page that refreshes mid-run. */
const MAX_BUFFERED_EVENTS = 5_000;
const MAX_RUNS = 20;
const DEFAULT_DEFECT_RATE = 0.35;
const SEED_MODULUS = 1_000_000;

/** Log lines arrive painted for a terminal; the browser wants the plain text. */
const ANSI = /\u001B\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const RUN_ID_RE = /^[A-Za-z0-9-]{6,64}$/;

/**
 * Owns the one run the dashboard may have in flight: its event buffer, its SSE
 * subscribers, and the promise a browser review has to resolve.
 */
export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private activeRunId: string | null = null;

  constructor(private readonly opts: { outDir: string; logger: Logger }) {}

  summaries(): RunSummary[] {
    return [...this.runs.values()]
      .map((record) => ({
        runId: record.runId,
        batchId: record.batchId,
        status: record.status,
        startedAt: record.startedAt,
        awaitingReview: record.pending !== null,
      }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  active(): RunSummary | null {
    if (this.activeRunId === null) return null;
    return this.summaries().find((summary) => summary.runId === this.activeRunId) ?? null;
  }

  get(runId: string): RunRecord {
    if (!RUN_ID_RE.test(runId)) throw new HttpError(400, `Invalid run id: "${runId}"`);
    const record = this.runs.get(runId);
    if (!record) throw new HttpError(404, `No run ${runId} — it may have aged out of memory`);
    return record;
  }

  /** Generates and writes the batch, then starts the graph in the background. */
  async start(input: StartRunInput): Promise<{ runId: string; batchId: string }> {
    if (this.activeRunId !== null) {
      const running = this.active();
      throw new HttpError(409, "A run is already in progress — wait for it to finish", {
        runId: running?.runId ?? this.activeRunId,
        batchId: running?.batchId ?? null,
      });
    }

    // Mirrors `runCommand`: `.env` decides provider and email, the server decides where output lands.
    const config = loadConfig({ outDir: this.opts.outDir }, process.env);
    const manifest = generateBatch({
      count: input.count,
      seed: input.seed ?? Date.now() % SEED_MODULUS,
      defectRate: input.defectRate ?? DEFAULT_DEFECT_RATE,
      now: new Date(),
    });
    await writeBatch(config.outDir, manifest);

    const record: RunRecord = {
      runId: randomUUID(),
      batchId: manifest.batchId,
      status: "running",
      startedAt: new Date().toISOString(),
      events: [],
      listeners: new Set(),
      pending: null,
      nextSeq: 0,
      bufferFull: false,
    };
    this.runs.set(record.runId, record);
    this.activeRunId = record.runId;
    this.evict();

    // Deliberately not awaited: the POST answers with the ids and the browser follows the SSE stream.
    void this.execute(record, manifest, config, input.email);
    return { runId: record.runId, batchId: record.batchId };
  }

  /** Replays nothing — the caller decides what to replay — and returns an unsubscribe function. */
  subscribe(runId: string, listener: RunListener): () => void {
    const record = this.get(runId);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  /** Resolves the interrupt the graph is parked on. */
  resolveReview(runId: string, action: ReviewAction): { documentId: string } {
    const record = this.get(runId);
    if (record.pending === null) throw new HttpError(409, `Run ${runId} has no review waiting for an answer`);
    const { request, resolve } = record.pending;
    record.pending = null;
    resolve(action);
    return { documentId: request.documentId };
  }

  private evict(): void {
    if (this.runs.size <= MAX_RUNS) return;
    const disposable = [...this.runs.values()]
      .filter((record) => record.runId !== this.activeRunId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const record of disposable.slice(0, this.runs.size - MAX_RUNS)) this.runs.delete(record.runId);
  }

  private emit(record: RunRecord, event: RunEventPayload): void {
    const stamped = { ...event, seq: record.nextSeq } as RunEvent;
    record.nextSeq += 1;

    if (record.events.length < MAX_BUFFERED_EVENTS) {
      record.events.push(stamped);
    } else if (!record.bufferFull) {
      record.bufferFull = true;
      this.opts.logger.warn(`run ${record.runId} exceeded ${MAX_BUFFERED_EVENTS} events; replay is truncated`);
    }

    for (const listener of [...record.listeners]) {
      try {
        listener(stamped);
      } catch (error) {
        record.listeners.delete(listener);
        this.opts.logger.warn(`dropped an event listener that threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Demultiplexes the three stream modes into the events the browser subscribes to. */
  private onStream(record: RunRecord, mode: string, chunk: unknown): void {
    if (mode === "custom") {
      const event = chunk as ProgressEvent | null;
      if (!event || typeof event !== "object" || typeof event.type !== "string") return;
      const clean = event.type === "log" ? { ...event, line: stripAnsi(event.line) } : event;
      this.emit(record, { type: "progress", data: clean });
      return;
    }

    if (mode === "messages") {
      if (!Array.isArray(chunk)) return;
      const [message, metadata] = chunk as [{ content?: unknown } | undefined, { langgraph_node?: string } | undefined];
      if (metadata?.langgraph_node !== "summarize") return;
      const text = typeof message?.content === "string" ? message.content : "";
      if (text !== "") this.emit(record, { type: "token", data: { text } });
      return;
    }

    if (mode === "updates" && chunk && typeof chunk === "object") {
      // The CLI printer announces the pause from this channel too; the browser log mirrors it.
      if (Object.keys(chunk as Record<string, unknown>).includes("__interrupt__")) {
        this.emit(record, { type: "progress", data: { type: "info", message: "waiting for human review" } });
      }
    }
  }

  private reviewer(record: RunRecord): Reviewer {
    return (request) =>
      new Promise<ReviewAction>((resolve) => {
        record.pending = { request, resolve };
        this.emit(record, { type: "review", data: request });
      });
  }

  /** The whole run, start to finish. Any failure becomes an `error` event rather than an unhandled rejection. */
  private async execute(
    record: RunRecord,
    manifest: BatchManifest,
    config: AppConfig,
    email: string | undefined,
  ): Promise<void> {
    try {
      const recipient = email ?? config.email.to;
      const sinks: Sink[] = [new FileSink()];
      if (recipient) {
        const smtp = config.email.smtpHost
          ? {
              host: config.email.smtpHost,
              port: config.email.smtpPort,
              user: config.email.smtpUser,
              pass: config.email.smtpPass,
              secure: config.email.smtpSecure,
            }
          : undefined;
        sinks.push(new EmailSink({ to: recipient, from: config.email.from, smtp }));
      }

      // Lines logged inside a node ride the graph's custom stream; lines logged outside it
      // land in this sink, so both ends up in the browser log in order.
      const logger = createStreamAwareLogger({
        level: this.opts.logger.level,
        sink: (line, level) => {
          this.opts.logger.raw(line);
          this.emit(record, { type: "progress", data: { type: "log", level, line: stripAnsi(line) } });
        },
      });

      const { context, ledger } = await createPipelineContext({
        config,
        batchId: manifest.batchId,
        batchDir: batchDir(config.outDir, manifest.batchId),
        logger,
        sinks,
      });

      logger.info(
        `batch ${manifest.batchId}: ${manifest.documents.length} document(s) · provider ${context.models.primaryTag} · review browser`,
      );
      logger.info(`seed ${manifest.seed} — pass --seed ${manifest.seed} to reproduce this batch`);

      const outcome = await runBatch({
        manifest,
        config,
        context,
        ledger,
        reviewer: this.reviewer(record),
        callbacks: [new UsageTracker()],
        onStream: (mode, chunk) => this.onStream(record, mode, chunk),
      });

      const evaluation = manifest.groundTruth.length > 0 ? evaluateBatch(manifest, outcome.result) : null;
      record.status = "done";
      this.emit(record, {
        type: "done",
        data: { result: outcome.result, evaluation, checkpoints: outcome.checkpoints },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.opts.logger.error(`run ${record.runId} failed: ${message}`);
      record.status = "error";
      this.emit(record, { type: "error", data: { message } });
    } finally {
      // A run parked on an unanswered review still frees the slot once it settles.
      record.pending = null;
      if (this.activeRunId === record.runId) this.activeRunId = null;
    }
  }
}
