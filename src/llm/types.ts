import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Runnable } from "@langchain/core/runnables";

/** Stamped onto every LLM-derived output so the report shows who produced it. */
export type ProviderTag = "fake" | `anthropic:${string}`;

/**
 * What the model factory hands to the rest of the app.
 *
 * `primary` is the configured provider; `fallback` (if any) is the deterministic fake model
 * used by `resilient()` when the primary keeps failing. Chains are built per model because
 * `withRetry()` / `withFallbacks()` return generic Runnables that no longer expose
 * `withStructuredOutput` / `bindTools` — so resilience wraps the *chain*, not the model.
 */
export interface ModelBundle {
  primary: BaseChatModel;
  primaryTag: ProviderTag;
  fallback: BaseChatModel | null;
  fallbackTag: ProviderTag | null;
  maxRetries: number;
}

/** Output of a resilient chain: the value plus which provider actually produced it. */
export interface Tagged<T> {
  value: T;
  provider: ProviderTag;
}

export type ChainBuilder<I, O> = (model: BaseChatModel) => Runnable<I, O>;
