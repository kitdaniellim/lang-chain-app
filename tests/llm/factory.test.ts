import { describe, expect, it, vi } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createModels, resilient } from "../../src/llm/factory.js";
import { ScriptedChatModel } from "../../src/llm/fake-model.js";
import { loadConfig } from "../../src/config.js";
import type { ChainBuilder, ModelBundle } from "../../src/llm/types.js";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

/** Minimal chain: one model call, returns the message text. */
const echoChain: ChainBuilder<{ text: string }, string> = (model: BaseChatModel) =>
  RunnableLambda.from(async (input: { text: string }) => {
    const message = await model.invoke([new HumanMessage(input.text)]);
    return String(message.content);
  });

function bundle(primary: BaseChatModel, fallback: BaseChatModel | null, maxRetries: number): ModelBundle {
  return {
    primary,
    primaryTag: "anthropic:test-model",
    fallback,
    fallbackTag: fallback ? "fake" : null,
    maxRetries,
  };
}

describe("createModels", () => {
  it("returns a scripted primary with no fallback for the fake provider", () => {
    const config = loadConfig({ llmProvider: "fake", fakeFailureRate: 0.25, fakeLatencyMs: 5 }, EMPTY_ENV);
    const models = createModels(config);

    expect(models.primary).toBeInstanceOf(ScriptedChatModel);
    expect((models.primary as ScriptedChatModel).failureRate).toBe(0.25);
    expect((models.primary as ScriptedChatModel).latencyMs).toBe(5);
    expect(models.primaryTag).toBe("fake");
    expect(models.fallback).toBeNull();
    expect(models.fallbackTag).toBeNull();
    expect(models.maxRetries).toBe(config.llmMaxRetries);
    expect(models.primary.cache).toBeDefined();
  });

  it("returns a ChatAnthropic primary with a scripted fallback for the anthropic provider", () => {
    const config = loadConfig(
      { llmProvider: "anthropic", anthropicApiKey: "sk-ant-test-key", anthropicModel: "claude-opus-5" },
      EMPTY_ENV,
    );
    const models = createModels(config);

    expect(models.primary).toBeInstanceOf(ChatAnthropic);
    expect(models.primaryTag).toBe("anthropic:claude-opus-5");
    expect(models.fallback).toBeInstanceOf(ScriptedChatModel);
    expect(models.fallbackTag).toBe("fake");
    expect(models.primary.cache).toBeDefined();
    expect(models.fallback!.cache).toBeDefined();
  });
});

describe("resilient", () => {
  it("tags the output with the provider that produced it", async () => {
    const models = bundle(new ScriptedChatModel(), null, 2);
    const chain = resilient(models, echoChain);
    const result = await chain.invoke({ text: "hello" });

    expect(result.provider).toBe("anthropic:test-model");
    expect(typeof result.value).toBe("string");
    expect(result.value.length).toBeGreaterThan(0);
  });

  it("falls back to the scripted model and notifies when the primary keeps failing", async () => {
    const primary = new ScriptedChatModel({ failureRate: 1 });
    const fallback = new ScriptedChatModel();
    const onFallback = vi.fn();
    const chain = resilient(bundle(primary, fallback, 1), echoChain, { onFallback, runName: "echo" });

    const result = await chain.invoke({ text: "hello" });

    expect(result.provider).toBe("fake");
    expect(result.value.length).toBeGreaterThan(0);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(fallback.calls).toBe(1);
  });

  it("retries transient failures and succeeds within maxRetries", async () => {
    // seed 21 at failureRate 0.5 fails twice, then succeeds on the third attempt of the same prompt.
    const primary = new ScriptedChatModel({ failureRate: 0.5, seed: 21 });
    const chain = resilient(bundle(primary, null, 3), echoChain);

    const result = await chain.invoke({ text: "hello" });

    expect(result.provider).toBe("anthropic:test-model");
    expect(primary.calls).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let attempts = 0;
    const failing: ChainBuilder<{ text: string }, string> = () =>
      RunnableLambda.from(() => {
        attempts += 1;
        throw new Error("bad request: schema invalid");
      });
    const chain = resilient(bundle(new ScriptedChatModel(), null, 3), failing);

    await expect(chain.invoke({ text: "hello" })).rejects.toThrow(/bad request/);
    expect(attempts).toBe(1);
  });

  it("propagates the failure when there is no fallback left", async () => {
    const primary = new ScriptedChatModel({ failureRate: 1 });
    const chain = resilient(bundle(primary, null, 2), echoChain);

    await expect(chain.invoke({ text: "hello" })).rejects.toThrow(/transient/i);
    expect(primary.calls).toBe(2);
  });
});
