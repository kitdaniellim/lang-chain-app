import type { BaseMessage } from "@langchain/core/messages";
import { INVESTIGATOR_TOOL_NAMES, TOOL_NAMES } from "../../domain/constants.js";
import { messageText } from "./messages.js";
import type { ScriptedResponse, ScriptedToolCall } from "./router.js";

const POLICY_QUERY = "approval threshold purchase order unknown vendor duplicate";
const UNKNOWN_TOOL = "unknown_tool";

/** Confidence when no usable tool evidence exists at all. */
const NO_EVIDENCE_CONFIDENCE = 0.25;
const UNVERIFIED_CONFIDENCE = 0.5;
const PARTIAL_CONFIDENCE = 0.7;
const FULL_CONFIDENCE = 0.9;

export interface InvestigateInput {
  messages: BaseMessage[];
  toolNames: string[];
  extractedJson: string | null;
}

interface ToolFinding {
  name: string;
  text: string;
  data: unknown;
  /** Set when the output was not JSON we could read. */
  parseError: string | null;
}

type Recommendation = "approve" | "reject" | "escalate";

/** Tri-state: a check that could not be run is never an all-clear. */
type CheckState = "ok" | "fail" | "unknown";

type DuplicateState = "exact" | "same_number" | "similar" | "none";

/** Why a tool result we did receive could not be used. */
type SourceProblem = "unparsed" | "shape" | null;

/** A check's outcome plus whether the tool answered at all and why not usable. */
interface Resolved<T> {
  value: T | null;
  problem: SourceProblem;
  consulted: boolean;
}

/**
 * Two-turn investigator: turn 1 fans out to every bound investigator tool,
 * turn 2 reads the tool results and writes the findings brief.
 */
export function respondInvestigate(input: InvestigateInput): ScriptedResponse {
  const last = input.messages[input.messages.length - 1];
  if (last?.getType() === "tool") return finalReport(input);
  return firstTurnCalls(input);
}

// ---------------------------------------------------------------------------
// Turn 1 — parallel tool calls
// ---------------------------------------------------------------------------

function firstTurnCalls(input: InvestigateInput): ScriptedResponse {
  const extracted = readExtracted(input.extractedJson);
  const calls: ScriptedToolCall[] = [];

  for (const name of INVESTIGATOR_TOOL_NAMES) {
    if (!input.toolNames.includes(name)) continue;
    calls.push({ name, args: argsFor(name, extracted) });
  }

  if (calls.length === 0) return { kind: "text", text: "No investigation tools are available." };
  return { kind: "tool_calls", toolCalls: calls };
}

function argsFor(name: string, extracted: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case TOOL_NAMES.recomputeTotals:
      return {
        lineItems: extracted["lineItems"] ?? [],
        subtotal: extracted["subtotal"] ?? null,
        taxRate: extracted["taxRate"] ?? null,
        taxAmount: extracted["taxAmount"] ?? null,
        total: extracted["total"] ?? null,
      };
    case TOOL_NAMES.lookupVendor:
      return { name: extracted["vendorName"] ?? null };
    case TOOL_NAMES.findDuplicates:
      return {
        invoiceNumber: extracted["invoiceNumber"] ?? null,
        vendorName: extracted["vendorName"] ?? null,
        total: extracted["total"] ?? null,
        issueDate: extracted["issueDate"] ?? null,
      };
    case TOOL_NAMES.searchPolicy:
      return { query: POLICY_QUERY };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Turn 2 — brief + recommendation
// ---------------------------------------------------------------------------

function finalReport(input: InvestigateInput): ScriptedResponse {
  const findings = collectFindings(input.messages);
  const extracted = readExtracted(input.extractedJson);
  const toolsUsed = [...new Set(findings.map((f) => f.name))].filter((name) => name !== UNKNOWN_TOOL);

  const subject = `invoice ${String(extracted["invoiceNumber"] ?? "(unknown number)")} from ${String(
    extracted["vendorName"] ?? "an unidentified vendor",
  )}`;

  // No attributable tool result means no evidence; never approve on that.
  if (toolsUsed.length === 0) return noEvidenceReport(input, subject, findings.length, toolsUsed);

  const totals = resolve(findings, TOOL_NAMES.recomputeTotals, readTotals);
  const vendor = resolve(findings, TOOL_NAMES.lookupVendor, readVendor);
  const duplicates = resolve(findings, TOOL_NAMES.findDuplicates, readDuplicates);

  const lineSum = totals.value?.lineSum ?? "unknown";
  const total = totals.value?.total ?? "unknown";
  const vendorState = vendor.value ?? "unknown";
  const duplicateState = duplicates.value ?? "unknown";

  const failed =
    lineSum === "fail" ||
    total === "fail" ||
    vendorState === "fail" ||
    duplicateState === "similar" ||
    duplicateState === "same_number";
  const unverified =
    lineSum === "unknown" || total === "unknown" || vendorState === "unknown" || duplicateState === "unknown";

  const recommendation: Recommendation =
    duplicateState === "exact" ? "reject" : failed || unverified ? "escalate" : "approve";

  const sentences = [
    `Reviewed ${subject} using ${toolsUsed.length} tool${toolsUsed.length === 1 ? "" : "s"}.`,
    arithmeticSentence(lineSum, total, totals.consulted),
    vendorSentence(vendorState, vendor.consulted),
    duplicateSentence(duplicateState, duplicates.consulted),
    ...problemSentences([
      { tool: TOOL_NAMES.recomputeTotals, problem: totals.problem },
      { tool: TOOL_NAMES.lookupVendor, problem: vendor.problem },
      { tool: TOOL_NAMES.findDuplicates, problem: duplicates.problem },
    ]),
    `Recommended action: ${recommendation}.`,
  ];

  const confidence = unverified
    ? UNVERIFIED_CONFIDENCE
    : toolsUsed.length >= INVESTIGATOR_TOOL_NAMES.length
      ? FULL_CONFIDENCE
      : PARTIAL_CONFIDENCE;

  return emit(input, sentences.join(" "), recommendation, confidence, toolsUsed);
}

function noEvidenceReport(
  input: InvestigateInput,
  subject: string,
  resultCount: number,
  toolsUsed: string[],
): ScriptedResponse {
  const brief = [
    `Reviewed ${subject} but no usable tool evidence was available.`,
    resultCount === 0
      ? "No tool results were returned."
      : `${resultCount} tool result(s) could not be attributed to a known tool.`,
    "Nothing about the arithmetic, the vendor or possible duplicates could be verified.",
    "Recommended action: escalate.",
  ].join(" ");
  return emit(input, brief, "escalate", NO_EVIDENCE_CONFIDENCE, toolsUsed);
}

/** Answers through the agent's structured-response tool when one is bound, else as prose. */
function emit(
  input: InvestigateInput,
  brief: string,
  recommendation: Recommendation,
  confidence: number,
  toolsUsed: string[],
): ScriptedResponse {
  const reportTool = input.toolNames.find((name) => !INVESTIGATOR_TOOL_NAMES.includes(name));
  if (reportTool) {
    return {
      kind: "tool_calls",
      toolCalls: [{ name: reportTool, args: { brief, recommendation, confidence, toolsUsed } }],
    };
  }
  return { kind: "text", text: brief };
}

// ---------------------------------------------------------------------------
// Prose — every sentence states what was actually established
// ---------------------------------------------------------------------------

function arithmeticSentence(lineSum: CheckState, total: CheckState, consulted: boolean): string {
  if (!consulted) return `Arithmetic was not checked: ${TOOL_NAMES.recomputeTotals} was not consulted.`;
  const parts = [
    lineSum === "fail"
      ? "the line items do not add up to the printed subtotal"
      : lineSum === "unknown"
        ? "the line-item sum could not be verified (missing figures)"
        : "the line items add up to the printed subtotal",
    total === "fail"
      ? "the recomputed total does not match the printed total"
      : total === "unknown"
        ? "the grand total could not be verified (missing figures)"
        : "the recomputed total matches the printed total",
  ];
  return `Arithmetic: ${parts.join("; ")}.`;
}

function vendorSentence(state: CheckState, consulted: boolean): string {
  if (!consulted) return `The vendor was not checked: ${TOOL_NAMES.lookupVendor} was not consulted.`;
  if (state === "fail") return "The vendor is not an approved registry vendor.";
  if (state === "unknown") return "The vendor could not be verified (no usable registry result).";
  return "The vendor resolves against the approved registry.";
}

function duplicateSentence(state: DuplicateState | "unknown", consulted: boolean): string {
  if (!consulted) return `Duplicates were not checked: ${TOOL_NAMES.findDuplicates} was not consulted.`;
  if (state === "exact") return "The same invoice number from this vendor already exists in the ledger.";
  if (state === "same_number") return "The ledger holds this invoice number under a different vendor.";
  if (state === "similar") return "The ledger holds a same-vendor, same-amount invoice inside the duplicate window.";
  if (state === "unknown") return "Duplicate status could not be verified (no usable ledger result).";
  return "No duplicate of this invoice was found in the ledger.";
}

/** One warnings-style sentence per tool whose output we received but could not use. */
function problemSentences(entries: Array<{ tool: string; problem: SourceProblem }>): string[] {
  const unparsed = entries.filter((e) => e.problem === "unparsed").map((e) => e.tool);
  const wrongShape = entries.filter((e) => e.problem === "shape").map((e) => e.tool);
  const sentences: string[] = [];
  if (unparsed.length > 0) sentences.push(`Tool output for ${unparsed.join(", ")} could not be parsed.`);
  if (wrongShape.length > 0) sentences.push(`Tool output for ${wrongShape.join(", ")} did not have the expected shape.`);
  return sentences;
}

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

/** Every tool result in the thread, named from the ToolMessage or its originating tool call. */
function collectFindings(messages: BaseMessage[]): ToolFinding[] {
  const namesByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.getType() !== "ai") continue;
    const calls = (message as { tool_calls?: Array<{ id?: string; name: string }> }).tool_calls ?? [];
    for (const call of calls) {
      if (call.id) namesByCallId.set(call.id, call.name);
    }
  }

  const findings: ToolFinding[] = [];
  for (const message of messages) {
    if (message.getType() !== "tool") continue;
    const callId = (message as { tool_call_id?: string }).tool_call_id;
    const name = message.name ?? (callId ? namesByCallId.get(callId) : undefined) ?? UNKNOWN_TOOL;
    const text = messageText(message);
    const parsed = parseJson(text);
    findings.push({ name, text, data: parsed.value, parseError: parsed.error });
  }
  return findings;
}

/** Runs one tool's reader, recording whether the tool answered and whether the answer was usable. */
function resolve<T>(
  findings: ToolFinding[],
  toolName: string,
  read: (record: Record<string, unknown>) => T | null,
): Resolved<T> {
  const finding = findings.find((f) => f.name === toolName);
  if (!finding) return { value: null, problem: null, consulted: false };
  if (finding.parseError !== null) return { value: null, problem: "unparsed", consulted: true };
  const record = asRecord(finding.data);
  if (!record) return { value: null, problem: "shape", consulted: true };
  const value = read(record);
  return { value, problem: value === null ? "shape" : null, consulted: true };
}

// ---------------------------------------------------------------------------
// Readers for the exact shapes the tools in src/tools produce
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `boolean | null` from the tools, where null means "not checkable"; anything else is off-shape. */
function triState(value: unknown): CheckState | null {
  if (value === true) return "ok";
  if (value === false) return "fail";
  if (value === null) return "unknown";
  return null;
}

/** `recompute_totals` -> `TotalsResult` (`src/tools/checks.ts`). */
function readTotals(record: Record<string, unknown>): { lineSum: CheckState; total: CheckState } | null {
  const lineSum = triState(record["lineSumMatches"]);
  const total = triState(record["totalMatches"]);
  if (lineSum === null || total === null) return null;

  // An error-severity issue is a real mismatch even when the boolean could not be set.
  const hasError =
    Array.isArray(record["issues"]) && record["issues"].some((entry) => asRecord(entry)?.["severity"] === "error");
  return {
    lineSum: hasError && lineSum === "unknown" ? "fail" : lineSum,
    total: hasError && total === "unknown" ? "fail" : total,
  };
}

/** `lookup_vendor` -> `VendorLookupResult` (`src/tools/lookup-vendor.ts`). */
function readVendor(record: Record<string, unknown>): CheckState | null {
  if (record["found"] === false) return "fail";
  if (record["found"] !== true) return null;
  return record["approved"] === false ? "fail" : "ok";
}

/** `find_duplicates` -> `DuplicateSearchResult` (`src/tools/find-duplicates.ts`). */
function readDuplicates(record: Record<string, unknown>): DuplicateState | null {
  const exact = record["exact"];
  const otherVendor = record["sameNumberOtherVendor"];
  const similar = record["similar"];
  if (!Array.isArray(exact) || !Array.isArray(otherVendor) || !Array.isArray(similar)) return null;
  // Only same number *and* same vendor is conclusive; the weaker hits escalate to a human.
  if (exact.length > 0) return "exact";
  if (otherVendor.length > 0) return "same_number";
  return similar.length > 0 ? "similar" : "none";
}

function readExtracted(json: string | null): Record<string, unknown> {
  return asRecord(parseJson(json ?? "").value) ?? {};
}

function parseJson(text: string): { value: unknown; error: string | null } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null, error: "empty output" };
  if (!/^[[{]/.test(trimmed)) return { value: null, error: "output was not JSON" };
  try {
    return { value: JSON.parse(trimmed), error: null };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}
