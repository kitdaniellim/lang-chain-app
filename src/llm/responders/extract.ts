import { TOOL_NAMES } from "../../domain/constants.js";
import { parseInvoiceText } from "../text-parser.js";
import type { ScriptedResponse } from "./router.js";

/** Runs the heuristic parser and returns it as an `extract_invoice` tool call. */
export function respondExtract(documentText: string): ScriptedResponse {
  const extracted = parseInvoiceText(documentText);
  return {
    kind: "tool_calls",
    toolCalls: [{ name: TOOL_NAMES.extract, args: extracted as unknown as Record<string, unknown> }],
  };
}
