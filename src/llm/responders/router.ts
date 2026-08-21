import type { BaseMessage } from "@langchain/core/messages";
import { INVESTIGATOR_TOOL_NAMES, PROMPT_MARKERS, TOOL_NAMES } from "../../domain/constants.js";
import { respondCategorize } from "./categorize.js";
import { respondExtract } from "./extract.js";
import { respondInvestigate } from "./investigate.js";
import { lastHumanText, sectionBetween } from "./messages.js";
import { respondSummarize } from "./summarize.js";

export { lastHumanText, messageText, sectionBetween } from "./messages.js";

/** What a responder hands back to the model: either prose or a set of tool calls. */
export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type ScriptedResponse =
  | { kind: "text"; text: string }
  | { kind: "tool_calls"; toolCalls: ScriptedToolCall[] };

function vendorHint(text: string): string | null {
  const marker = PROMPT_MARKERS.vendorHint;
  const index = text.indexOf(marker);
  if (index < 0) return null;
  const line = text.slice(index + marker.length).split("\n")[0] ?? "";
  const hint = line.trim();
  return hint === "" ? null : hint;
}

/**
 * Picks the responder from the bound tool names, in a fixed precedence order.
 * Falls through to the summariser when nothing tool-shaped is bound.
 */
export function routeScriptedResponse(messages: BaseMessage[], toolNames: string[]): ScriptedResponse {
  const human = lastHumanText(messages);

  if (toolNames.includes(TOOL_NAMES.extract)) {
    const document = sectionBetween(human, PROMPT_MARKERS.documentOpen, PROMPT_MARKERS.documentClose);
    return respondExtract(document ?? human);
  }

  if (toolNames.includes(TOOL_NAMES.categorize)) {
    const payload = sectionBetween(human, PROMPT_MARKERS.extractedOpen, PROMPT_MARKERS.extractedClose);
    return respondCategorize(payload, vendorHint(human));
  }

  if (toolNames.some((name) => INVESTIGATOR_TOOL_NAMES.includes(name))) {
    const payload = sectionBetween(human, PROMPT_MARKERS.extractedOpen, PROMPT_MARKERS.extractedClose);
    return respondInvestigate({ messages, toolNames, extractedJson: payload });
  }

  const stats = sectionBetween(human, PROMPT_MARKERS.statsOpen, PROMPT_MARKERS.statsClose);
  return respondSummarize(stats, human);
}
