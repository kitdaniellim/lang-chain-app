import { ChatAnthropic } from "@langchain/anthropic";
import { InMemoryCache } from "@langchain/core/caches";
import { RunnableLambda, type Runnable } from "@langchain/core/runnables";
import type { AppConfig } from "../config.js";
import { isRetryableError } from "./errors.js";
import { ScriptedChatModel } from "./fake-model.js";
import type { ChainBuilder, ModelBundle, ProviderTag, Tagged } from "./types.js";

/**
 * Builds the model bundle for the configured provider.
 * The Anthropic client does no retrying of its own — `resilient()` owns that so
 * retries and fallbacks are visible in traces and in the run report.
 */
export function createModels(config: AppConfig): ModelBundle {
  if (config.llmProvider === "anthropic") {
    const primary = new ChatAnthropic({
      model: config.anthropicModel,
      apiKey: config.anthropicApiKey,
      // No maxTokens override: a cap would truncate Opus 5's adaptive thinking and its tool call with it.
      maxRetries: 0,
      cache: new InMemoryCache(),
    });
    return {
      primary,
      primaryTag: `anthropic:${config.anthropicModel}`,
      fallback: new ScriptedChatModel({ cache: new InMemoryCache() }),
      fallbackTag: "fake",
      maxRetries: config.llmMaxRetries,
    };
  }

  return {
    primary: new ScriptedChatModel({
      failureRate: config.fakeFailureRate,
      latencyMs: config.fakeLatencyMs,
      cache: new InMemoryCache(),
    }),
    primaryTag: "fake",
    fallback: null,
    fallbackTag: null,
    maxRetries: config.llmMaxRetries,
  };
}

export interface ResilientOptions {
  runName?: string;
  /** Called once, with the primary's final error, just before the fallback runs. */
  onFallback?: (err: Error) => void;
}

/**
 * Wraps a chain builder in retry + provider fallback and tags the output with
 * whichever provider produced it. The notification happens in a lambda that
 * wraps the *primary* branch, so it fires after retries are exhausted and only
 * when a fallback actually exists.
 */
export function resilient<I, O>(
  models: ModelBundle,
  build: ChainBuilder<I, O>,
  opts: ResilientOptions = {},
): Runnable<I, Tagged<O>> {
  const tagged = (provider: ProviderTag) =>
    RunnableLambda.from((value: O): Tagged<O> => ({ value, provider }));

  const primary = build(models.primary)
    .pipe(tagged(models.primaryTag))
    .withRetry({
      stopAfterAttempt: models.maxRetries,
      // Rethrowing here aborts p-retry, so only transient failures are retried.
      onFailedAttempt: (error: unknown) => {
        if (!isRetryableError(error)) throw error;
      },
    });

  let chain: Runnable<I, Tagged<O>> = primary;

  if (models.fallback && models.fallbackTag) {
    const notify = opts.onFallback ?? defaultOnFallback(models.fallbackTag);
    const notifying = RunnableLambda.from(async (input: I, config): Promise<Tagged<O>> => {
      try {
        return await primary.invoke(input, config);
      } catch (err) {
        notify(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    });
    chain = notifying.withFallbacks([build(models.fallback).pipe(tagged(models.fallbackTag))]);
  }

  return opts.runName ? chain.withConfig({ runName: opts.runName }) : chain;
}

function defaultOnFallback(fallbackTag: ProviderTag): (err: Error) => void {
  return (err) => console.warn(`[llm] primary failed, falling back to ${fallbackTag}: ${err.message}`);
}
