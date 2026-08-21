import { AIMessage } from "@langchain/core/messages";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { UsageTracker } from "../../src/observability/usage-tracker.js";

const serialized = (name: string): Serialized =>
  ({ lc: 1, type: "not_implemented", id: ["langchain", "chat_models", name] }) as Serialized;

function resultWithUsageMetadata(input: number, output: number): LLMResult {
  const message = new AIMessage({
    content: "ok",
    usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
  });
  return { generations: [[{ text: "ok", message }]] } as unknown as LLMResult;
}

function resultWithTokenUsage(prompt: number, completion: number): LLMResult {
  return {
    generations: [[{ text: "ok" }]],
    llmOutput: { tokenUsage: { promptTokens: prompt, completionTokens: completion } },
  } as unknown as LLMResult;
}

describe("UsageTracker", () => {
  it("is a named callback handler", () => {
    expect(new UsageTracker().name).toBe("usage-tracker");
  });

  it("records tokens from usage_metadata and prices a known model", async () => {
    const tracker = new UsageTracker();
    await tracker.handleChatModelStart(
      serialized("ChatAnthropic"),
      [[]],
      "run-1",
      undefined,
      { invocation_params: { model: "claude-opus-5" } },
      [],
      {},
      "extract",
    );
    await tracker.handleLLMEnd(resultWithUsageMetadata(1000, 200), "run-1");

    const summary = tracker.summary();
    expect(summary.llmCalls).toBe(1);
    expect(summary.llmErrors).toBe(0);
    expect(summary.inputTokens).toBe(1000);
    expect(summary.outputTokens).toBe(200);
    expect(summary.byModel["claude-opus-5"]).toEqual({ calls: 1, inputTokens: 1000, outputTokens: 200 });
    // 1000/1e6*5 + 200/1e6*25
    expect(summary.estimatedCostUsd).toBeCloseTo(0.01, 6);
    expect(summary.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("costs nothing for the fake model and sums tokens across runs", async () => {
    const tracker = new UsageTracker();
    for (const runId of ["run-a", "run-b"]) {
      await tracker.handleChatModelStart(
        serialized("FakeInvoiceModel"),
        [[]],
        runId,
        undefined,
        { invocation_params: { model: "scripted-invoice-model" } },
      );
      await tracker.handleLLMEnd(resultWithUsageMetadata(10, 5), runId);
    }

    const summary = tracker.summary();
    expect(summary.llmCalls).toBe(2);
    expect(summary.inputTokens).toBe(20);
    expect(summary.outputTokens).toBe(10);
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.byModel["scripted-invoice-model"]).toEqual({ calls: 2, inputTokens: 20, outputTokens: 10 });
  });

  it("reads llmOutput.tokenUsage and falls back to the serialized id for the model name", async () => {
    const tracker = new UsageTracker();
    await tracker.handleLLMStart(serialized("SomeModel"), ["prompt"], "run-2");
    await tracker.handleLLMEnd(resultWithTokenUsage(7, 3), "run-2");

    const summary = tracker.summary();
    expect(summary.inputTokens).toBe(7);
    expect(summary.outputTokens).toBe(3);
    expect(Object.keys(summary.byModel)).toEqual(["SomeModel"]);
  });

  it("uses 'unknown' when neither invocation params nor an id are available", async () => {
    const tracker = new UsageTracker();
    await tracker.handleChatModelStart({ lc: 1, type: "not_implemented", id: [] } as Serialized, [[]], "run-3");
    await tracker.handleLLMEnd(resultWithUsageMetadata(1, 1), "run-3");
    expect(Object.keys(tracker.summary().byModel)).toEqual(["unknown"]);
  });

  it("marks errored runs and still counts the call", async () => {
    const tracker = new UsageTracker();
    await tracker.handleChatModelStart(serialized("ChatAnthropic"), [[]], "run-4", undefined, {
      invocation_params: { model: "claude-opus-5" },
    });
    await tracker.handleLLMError(new Error("overloaded"), "run-4");

    const summary = tracker.summary();
    expect(summary.llmCalls).toBe(1);
    expect(summary.llmErrors).toBe(1);
    expect(summary.inputTokens).toBe(0);
  });

  it("counts tool runs by name", async () => {
    const tracker = new UsageTracker();
    await tracker.handleToolStart(serialized("recompute_totals"), "{}", "tool-1");
    await tracker.handleToolEnd("done", "tool-1");
    await tracker.handleToolStart(serialized("lookup_vendor"), "{}", "tool-2", undefined, [], {}, "lookup_vendor");
    await tracker.handleToolError(new Error("boom"), "tool-2");

    expect(tracker.summary().toolCalls).toBe(2);
    expect(tracker.renderSummary()).toContain("lookup_vendor");
  });

  it("renders a table with a row per model, a totals row and the tool count", async () => {
    const tracker = new UsageTracker();
    await tracker.handleChatModelStart(serialized("ChatAnthropic"), [[]], "run-5", undefined, {
      invocation_params: { model: "claude-opus-5" },
    });
    await tracker.handleLLMEnd(resultWithUsageMetadata(1000, 200), "run-5");

    const table = tracker.renderSummary();
    expect(table).toContain("claude-opus-5");
    expect(table).toContain("TOTAL");
    expect(table).toContain("tool call");
  });

  it("ignores end/error callbacks for runs it never saw", async () => {
    const tracker = new UsageTracker();
    await tracker.handleLLMEnd(resultWithUsageMetadata(5, 5), "ghost");
    await tracker.handleToolEnd("x", "ghost");
    expect(tracker.summary()).toMatchObject({ llmCalls: 0, toolCalls: 0, inputTokens: 0 });
  });
});
