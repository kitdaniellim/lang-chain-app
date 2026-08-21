import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import Table from "cli-table3";
import { estimateCostUsd } from "../llm/pricing.js";

export interface LlmRunRecord {
  runId: string;
  model: string;
  runName?: string;
  startedAt: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export interface ToolRunRecord {
  runId: string;
  name: string;
  startedAt: number;
  ms: number;
  error?: string;
}

export interface ModelUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  llmCalls: number;
  llmErrors: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalMs: number;
  estimatedCostUsd: number;
  byModel: Record<string, ModelUsage>;
}

function lastId(serialized: Serialized | undefined): string | undefined {
  const id = serialized?.id;
  return Array.isArray(id) && id.length > 0 ? String(id.at(-1)) : undefined;
}

/** `invocation_params.model` is what every chat model reports; the serialized id is the fallback. */
function modelName(llm: Serialized, extraParams?: Record<string, unknown>): string {
  const invocation = extraParams?.invocation_params as Record<string, unknown> | undefined;
  if (typeof invocation?.model === "string" && invocation.model !== "") return invocation.model;
  return lastId(llm) ?? "unknown";
}

/** Providers report tokens either in `llmOutput.tokenUsage` or on the message's `usage_metadata`. */
function readTokens(output: LLMResult): { input: number; output: number } {
  const tokenUsage = output.llmOutput?.tokenUsage as
    | { promptTokens?: number; completionTokens?: number }
    | undefined;
  if (typeof tokenUsage?.promptTokens === "number" || typeof tokenUsage?.completionTokens === "number") {
    return { input: tokenUsage.promptTokens ?? 0, output: tokenUsage.completionTokens ?? 0 };
  }

  const generation = output.generations?.[0]?.[0] as
    | { message?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } } }
    | undefined;
  const usage = generation?.message?.usage_metadata;
  if (usage) return { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 };

  return { input: 0, output: 0 };
}

/** Collects per-run LLM and tool telemetry so the CLI can print what the batch cost. */
export class UsageTracker extends BaseCallbackHandler {
  name = "usage-tracker";

  private readonly llm = new Map<string, LlmRunRecord>();
  private readonly tools = new Map<string, ToolRunRecord>();

  llmRuns(): LlmRunRecord[] {
    return [...this.llm.values()];
  }

  toolRuns(): ToolRunRecord[] {
    return [...this.tools.values()];
  }

  override async handleChatModelStart(
    llm: Serialized,
    _messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.startRun(llm, runId, extraParams, runName);
  }

  // Some models emit handleLLMStart instead of handleChatModelStart.
  override async handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.startRun(llm, runId, extraParams, runName);
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const run = this.llm.get(runId);
    if (!run) return;
    const tokens = readTokens(output);
    run.ms = Date.now() - run.startedAt;
    run.inputTokens = tokens.input;
    run.outputTokens = tokens.output;
  }

  override async handleLLMError(error: Error, runId: string): Promise<void> {
    const run = this.llm.get(runId);
    if (!run) return;
    run.ms = Date.now() - run.startedAt;
    run.error = error.message;
  }

  override async handleToolStart(
    tool: Serialized,
    _input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.tools.set(runId, {
      runId,
      name: runName ?? lastId(tool) ?? "unknown",
      startedAt: Date.now(),
      ms: 0,
    });
  }

  override async handleToolEnd(_output: unknown, runId: string): Promise<void> {
    const run = this.tools.get(runId);
    if (run) run.ms = Date.now() - run.startedAt;
  }

  override async handleToolError(error: Error, runId: string): Promise<void> {
    const run = this.tools.get(runId);
    if (!run) return;
    run.ms = Date.now() - run.startedAt;
    run.error = error.message;
  }

  private startRun(llm: Serialized, runId: string, extraParams?: Record<string, unknown>, runName?: string): void {
    this.llm.set(runId, {
      runId,
      model: modelName(llm, extraParams),
      runName,
      startedAt: Date.now(),
      ms: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  summary(): UsageSummary {
    const byModel: Record<string, ModelUsage> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let totalMs = 0;
    let llmErrors = 0;

    for (const run of this.llm.values()) {
      const bucket = (byModel[run.model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
      bucket.calls += 1;
      bucket.inputTokens += run.inputTokens;
      bucket.outputTokens += run.outputTokens;
      inputTokens += run.inputTokens;
      outputTokens += run.outputTokens;
      totalMs += run.ms;
      if (run.error) llmErrors += 1;
    }

    const estimatedCostUsd = Object.entries(byModel).reduce(
      (sum, [model, usage]) => sum + estimateCostUsd(model, usage.inputTokens, usage.outputTokens),
      0,
    );

    return {
      llmCalls: this.llm.size,
      llmErrors,
      toolCalls: this.tools.size,
      inputTokens,
      outputTokens,
      totalMs,
      estimatedCostUsd,
      byModel,
    };
  }

  /** One compact table: a row per model, a totals row, then the tool-call tally. */
  renderSummary(): string {
    const s = this.summary();
    const table = new Table({
      head: ["Model", "Calls", "In", "Out", "Cost USD"],
      style: { head: [], border: [] },
      colAligns: ["left", "right", "right", "right", "right"],
    });

    for (const [model, usage] of Object.entries(s.byModel)) {
      table.push([
        model,
        String(usage.calls),
        String(usage.inputTokens),
        String(usage.outputTokens),
        estimateCostUsd(model, usage.inputTokens, usage.outputTokens).toFixed(4),
      ]);
    }
    table.push(["TOTAL", String(s.llmCalls), String(s.inputTokens), String(s.outputTokens), s.estimatedCostUsd.toFixed(4)]);

    const toolNames = [...new Set(this.toolRuns().map((t) => t.name))].join(", ");
    const footer = [
      `${s.toolCalls} tool call(s)${toolNames ? `: ${toolNames}` : ""}`,
      `${s.llmErrors} LLM error(s)`,
      `${s.totalMs} ms in models`,
    ].join(" · ");

    return `${table.toString()}\n${footer}`;
  }
}
