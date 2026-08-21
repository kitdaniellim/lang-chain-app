/**
 * SHARED FIXTURE — chat models that fail only for a specific kind of call.
 * Lets a test exercise "this node must never throw" contracts one node at a time,
 * instead of the blunt `fakeFailureRate: 1` that kills the first model call in the graph.
 */
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import { TransientModelError } from "../../src/llm/errors.js";
import { ScriptedChatModel, type ScriptedCallOptions, type ScriptedChatModelFields } from "../../src/llm/fake-model.js";
import { messageText } from "../../src/llm/responders/router.js";

export interface CallInfo {
  messages: BaseMessage[];
  /** Every tool name bound to this call, from `bindTools` and from the call options. */
  toolNames: string[];
  /** Concatenated text of every message in the call. */
  text: string;
}

export type FailWhen = (call: CallInfo) => boolean;

/** Fails only when the named tool is bound — e.g. the categorize chain's structured-output tool. */
export function failOnTool(name: string): FailWhen {
  return (call) => call.toolNames.includes(name);
}

/** Fails only when the prompt contains the marker — e.g. the summariser's system prompt. */
export function failOnMarker(marker: string): FailWhen {
  return (call) => call.text.includes(marker);
}

/** Fails only the first `times` matching calls, so a retry can succeed on the next attempt. */
export function failFirst(times: number, when: FailWhen): FailWhen {
  let remaining = times;
  return (call) => {
    if (!when(call) || remaining <= 0) return false;
    remaining -= 1;
    return true;
  };
}

function toolNameOf(tool: unknown): string | null {
  if (typeof tool !== "object" || tool === null) return null;
  const candidate = tool as { name?: unknown; function?: { name?: unknown } };
  if (typeof candidate.function?.name === "string") return candidate.function.name;
  return typeof candidate.name === "string" ? candidate.name : null;
}

/**
 * A `ScriptedChatModel` that throws a retryable error for the calls `failWhen` selects
 * and behaves exactly like the normal fake model for everything else.
 */
export class SelectiveFailureModel extends ScriptedChatModel {
  static lc_name(): string {
    return "SelectiveFailureModel";
  }

  /** Public so `bindTools` can carry it onto the clone the base class builds. */
  failWhen: FailWhen = () => false;

  static create(failWhen: FailWhen, fields: ScriptedChatModelFields = {}): SelectiveFailureModel {
    const model = new SelectiveFailureModel(fields);
    model.failWhen = failWhen;
    return model;
  }

  /** The base clones itself through `this.constructor`, so the predicate has to be re-attached. */
  override bindTools(tools: BindToolsInput[], kwargs?: Partial<ScriptedCallOptions>) {
    const bound = super.bindTools(tools, kwargs);
    const inner = (bound as { bound?: unknown }).bound;
    if (inner instanceof SelectiveFailureModel) inner.failWhen = this.failWhen;
    return bound;
  }

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this.throwIfSelected(messages, options);
    return super._generate(messages, options, runManager);
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.throwIfSelected(messages, options);
    yield* super._streamResponseChunks(messages, options, runManager);
  }

  private throwIfSelected(messages: BaseMessage[], options: this["ParsedCallOptions"]): void {
    const fromOptions = Array.isArray(options.tools) ? options.tools.map(toolNameOf) : [];
    const toolNames = [
      ...new Set([...this.boundTools.map((t) => t.name), ...fromOptions].filter((n): n is string => n !== null)),
    ];
    const call: CallInfo = { messages, toolNames, text: messages.map(messageText).join(" ") };
    if (this.failWhen(call)) throw new TransientModelError(`Simulated failure for ${toolNames.join(",") || "prose"} call`);
  }
}
