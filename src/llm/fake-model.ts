import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, type BaseMessage, type ToolCall } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { TransientModelError } from "./errors.js";
import { messageText, routeScriptedResponse, type ScriptedResponse } from "./responders/router.js";

export interface ScriptedCallOptions extends BaseChatModelCallOptions {
  tools?: BindToolsInput[];
}

export interface ScriptedChatModelFields extends BaseChatModelParams {
  /** 0..1 probability that a call throws a `TransientModelError` before responding. */
  failureRate?: number;
  /** Artificial per-call latency in milliseconds. */
  latencyMs?: number;
  /** Seed for the fault-injection RNG, so failure sequences are reproducible. */
  seed?: number;
}

interface NormalisedTool {
  name: string;
  description: string;
}

/**
 * Deterministic rule-based chat model: no network, no API key, but a real
 * `BaseChatModel` so `withStructuredOutput`, `bindTools`, caching and streaming
 * all exercise the genuine LangChain code paths.
 */
export class ScriptedChatModel extends BaseChatModel<ScriptedCallOptions> {
  static lc_name(): string {
    return "ScriptedChatModel";
  }

  lc_namespace = ["lang_chain_demo", "llm", "scripted"];

  readonly failureRate: number;
  readonly latencyMs: number;
  readonly seed: number;
  /** Tools bound through `bindTools`, normalised to `{ name, description }`. */
  boundTools: NormalisedTool[] = [];

  private counter = { value: 0 };
  /** Attempts seen per prompt, shared with bound clones so retries of one prompt differ. */
  private attempts = new Map<number, number>();

  constructor(fields: ScriptedChatModelFields = {}) {
    super(fields);
    this.failureRate = fields.failureRate ?? 0;
    this.latencyMs = fields.latencyMs ?? 0;
    this.seed = fields.seed ?? 1;
  }

  /** Number of `_generate` / `_streamResponseChunks` invocations, shared with bound clones. */
  get calls(): number {
    return this.counter.value;
  }

  _llmType(): string {
    return "scripted-invoice-model";
  }

  _combineLLMOutput(): Record<string, unknown> {
    return { provider: "fake" };
  }

  /** Follows core's convention: a new instance carrying the merged tools, plus `withConfig({ tools })`. */
  bindTools(tools: BindToolsInput[], kwargs?: Partial<ScriptedCallOptions>) {
    // Construct through `this.constructor` so subclasses keep their own responders.
    const Ctor = this.constructor as new (fields: ScriptedChatModelFields) => ScriptedChatModel;
    const next = new Ctor({
      failureRate: this.failureRate,
      latencyMs: this.latencyMs,
      seed: this.seed,
      cache: this.cache,
    });
    next.counter = this.counter;
    next.attempts = this.attempts;
    next.boundTools = [...this.boundTools, ...normaliseTools(tools)];
    return next.withConfig({ tools, ...(kwargs ?? {}) } as Partial<ScriptedCallOptions>);
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const callNumber = await this.beginCall(messages);
    const response = routeScriptedResponse(messages, this.toolNames(options));
    const usage = usageMetadata(messages, response);
    const text = response.kind === "text" ? response.text : "";

    // AIMessageChunk, not AIMessage: core's default withStructuredOutput parser rejects
    // anything that is not a chunk, and every 1.x provider returns chunks from _generate.
    const message =
      response.kind === "text"
        ? new AIMessageChunk({ content: text, usage_metadata: usage, response_metadata: { provider: "fake" } })
        : new AIMessageChunk({
            content: "",
            tool_calls: toToolCalls(response, callNumber),
            usage_metadata: usage,
            response_metadata: { provider: "fake" },
          });

    return { generations: [{ message, text }], llmOutput: { provider: "fake" } };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const callNumber = await this.beginCall(messages);
    const response = routeScriptedResponse(messages, this.toolNames(options));
    const usage = usageMetadata(messages, response);

    if (response.kind === "tool_calls") {
      const chunk = new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: "",
          tool_call_chunks: toToolCalls(response, callNumber).map((call, index) => ({
            type: "tool_call_chunk" as const,
            id: call.id,
            name: call.name,
            args: JSON.stringify(call.args),
            index,
          })),
          usage_metadata: usage,
          response_metadata: { provider: "fake" },
        }),
        text: "",
      });
      if (options.signal?.aborted) return;
      yield chunk;
      await runManager?.handleLLMNewToken("", undefined, undefined, undefined, undefined, { chunk });
      return;
    }

    const pieces = splitIntoWords(response.text);
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index]!;
      const chunk = new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: piece,
          usage_metadata: index === pieces.length - 1 ? usage : undefined,
          response_metadata: index === 0 ? { provider: "fake" } : {},
        }),
        text: piece,
      });
      if (options.signal?.aborted) break;
      yield chunk;
      await runManager?.handleLLMNewToken(piece, undefined, undefined, undefined, undefined, { chunk });
    }
  }

  /**
   * Counts the call, then injects the seeded failure and the artificial latency.
   * The failure draw is seeded on (prompt, attempt), never on call order, so a parallel
   * fan-out fails the same documents whatever order the scheduler runs them in.
   */
  private async beginCall(messages: BaseMessage[]): Promise<number> {
    this.counter.value += 1;
    const callNumber = this.counter.value;

    if (this.failureRate > 0) {
      const promptKey = fnv1a(messages.map(messageText).join("\n"));
      const attempt = (this.attempts.get(promptKey) ?? 0) + 1;
      this.attempts.set(promptKey, attempt);
      if (mulberry32(this.seed ^ promptKey ^ attempt)() < this.failureRate) throw new TransientModelError();
    }

    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    return callNumber;
  }

  /** Union of the tools bound to this instance and any passed through call options. */
  private toolNames(options: this["ParsedCallOptions"]): string[] {
    const fromOptions = Array.isArray(options.tools) ? normaliseTools(options.tools) : [];
    return [...new Set([...this.boundTools, ...fromOptions].map((tool) => tool.name))];
  }
}

/** Accepts OpenAI function dicts, Anthropic tool dicts and StructuredTool-like objects. */
function normaliseTools(tools: BindToolsInput[]): NormalisedTool[] {
  const normalised: NormalisedTool[] = [];
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const candidate = tool as {
      name?: unknown;
      description?: unknown;
      function?: { name?: unknown; description?: unknown };
    };
    const openai = candidate.function;
    const name = typeof openai?.name === "string" ? openai.name : typeof candidate.name === "string" ? candidate.name : null;
    if (!name) continue;
    const description =
      typeof openai?.description === "string"
        ? openai.description
        : typeof candidate.description === "string"
          ? candidate.description
          : "";
    normalised.push({ name, description });
  }
  return normalised;
}

function toToolCalls(response: ScriptedResponse, callNumber: number): ToolCall[] {
  if (response.kind !== "tool_calls") return [];
  return response.toolCalls.map((call, index) => ({
    id: `call_${callNumber}_${index}`,
    name: call.name,
    args: call.args,
    type: "tool_call" as const,
  }));
}

/** Splits on spaces, keeping the trailing space on every chunk so a join is lossless. */
function splitIntoWords(text: string): string[] {
  if (text === "") return [];
  const parts = text.split(" ");
  const pieces = parts.map((part, index) => (index < parts.length - 1 ? `${part} ` : part));
  return pieces[pieces.length - 1] === "" ? pieces.slice(0, -1) : pieces;
}

function usageMetadata(
  messages: BaseMessage[],
  response: ScriptedResponse,
): { input_tokens: number; output_tokens: number; total_tokens: number } {
  const input = approxTokens(messages.map(messageText).join("\n"));
  const outputText = response.kind === "text" ? response.text : JSON.stringify(response.toolCalls);
  const output = approxTokens(outputText);
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** 32-bit FNV-1a of the prompt text, so the fault seed depends on what was asked, not on when. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small, fast, seedable PRNG so fault-injection sequences repeat exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
