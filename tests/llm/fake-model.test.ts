import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { ScriptedChatModel } from "../../src/llm/fake-model.js";
import { TransientModelError } from "../../src/llm/errors.js";
import { INVESTIGATOR_TOOL_NAMES, PROMPT_MARKERS, SYSTEM_MARKERS, TOOL_NAMES } from "../../src/domain/constants.js";
import {
  CategorizationSchema,
  ExtractedInvoiceSchema,
  GL_ACCOUNTS,
  type BatchStats,
} from "../../src/domain/schemas.js";
import { EMAIL_TEXT, FIXTURE_EXTRACTED, PLAIN_TEXT, TABLE_TEXT } from "../fixtures/sample-documents.js";

const wrapDocument = (text: string): string =>
  `${PROMPT_MARKERS.documentOpen}\n${text}\n${PROMPT_MARKERS.documentClose}`;

const wrapExtracted = (payload: unknown, hint?: string): string =>
  [
    `${PROMPT_MARKERS.extractedOpen}\n${JSON.stringify(payload)}\n${PROMPT_MARKERS.extractedClose}`,
    hint ? `${PROMPT_MARKERS.vendorHint} ${hint}` : "",
  ]
    .filter(Boolean)
    .join("\n");

const STATS: BatchStats = {
  total: 7,
  autoApproved: 4,
  approvedByHuman: 1,
  rejectedByHuman: 1,
  autoRejected: 0,
  needsReview: 1,
  approvedAmount: 12_345.5,
  totalAmount: 20_000,
  byCategory: { CLOUD_HOSTING: 3, SOFTWARE: 2, TRAVEL: 2 },
  issuesByCode: { TOTAL_MISMATCH: 2, MISSING_PO: 1 },
};

const summaryMessages = () => [
  new SystemMessage(`${SYSTEM_MARKERS.summarize} Write a short digest.`),
  new HumanMessage(
    `${PROMPT_MARKERS.statsOpen}\n${JSON.stringify(STATS)}\n${PROMPT_MARKERS.statsClose}\n\nHighlights:\n- INV-1 rejected as duplicate`,
  ),
];

const investigatorTools = INVESTIGATOR_TOOL_NAMES.map((name) => ({
  type: "function" as const,
  function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } },
}));

const reportTool = {
  type: "function" as const,
  function: {
    name: TOOL_NAMES.investigationReport,
    description: "Final structured report",
    parameters: { type: "object", properties: {} },
  },
};

describe("ScriptedChatModel identity", () => {
  it("reports its llm type and lc_name", () => {
    const model = new ScriptedChatModel();
    expect(model._llmType()).toBe("scripted-invoice-model");
    expect(ScriptedChatModel.lc_name()).toBe("ScriptedChatModel");
  });
});

describe("ScriptedChatModel extract responder", () => {
  it.each([
    ["plain", PLAIN_TEXT],
    ["email", EMAIL_TEXT],
  ])("returns the fixture extraction through withStructuredOutput (%s)", async (_name, text) => {
    const model = new ScriptedChatModel();
    const structured = model.withStructuredOutput(ExtractedInvoiceSchema, { name: TOOL_NAMES.extract });
    const result = await structured.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.extract} Copy values exactly.`),
      new HumanMessage(wrapDocument(text)),
    ]);
    const parsed = ExtractedInvoiceSchema.parse(result);
    const { confidence, warnings, ...core } = parsed;
    expect(core).toEqual(FIXTURE_EXTRACTED);
    expect(confidence).toBeGreaterThanOrEqual(0.8);
    expect(warnings).toEqual([]);
  });

  it("emits a well-formed tool call message with usage metadata", async () => {
    const model = new ScriptedChatModel();
    const bound = model.bindTools!([
      {
        type: "function",
        function: { name: TOOL_NAMES.extract, description: "extract", parameters: { type: "object", properties: {} } },
      },
    ]);
    const message = await bound.invoke([new HumanMessage(wrapDocument(TABLE_TEXT))]);
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls![0]!.name).toBe(TOOL_NAMES.extract);
    expect(message.tool_calls![0]!.args["vendorName"]).toBe("ACME CLOUD INC");
    expect(message.usage_metadata!.total_tokens).toBeGreaterThan(0);
    expect(message.response_metadata["provider"]).toBe("fake");
  });
});

describe("ScriptedChatModel categorize responder", () => {
  it("honours the vendor registry hint", async () => {
    const model = new ScriptedChatModel();
    const structured = model.withStructuredOutput(CategorizationSchema, { name: TOOL_NAMES.categorize });
    const result = await structured.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.categorize} Pick one category.`),
      new HumanMessage(
        wrapExtracted({ vendorName: "Acme Cloud Inc", lineItems: ["Unlabelled item"] }, "CLOUD_HOSTING"),
      ),
    ]);
    const parsed = CategorizationSchema.parse(result);
    expect(parsed.category).toBe("CLOUD_HOSTING");
    expect(parsed.glAccount).toBe(GL_ACCOUNTS.CLOUD_HOSTING);
    expect(parsed.confidence).toBeCloseTo(0.9, 5);
  });

  it("falls back to keyword rules without a hint", async () => {
    const model = new ScriptedChatModel();
    const structured = model.withStructuredOutput(CategorizationSchema, { name: TOOL_NAMES.categorize });
    const result = await structured.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.categorize} Pick one category.`),
      new HumanMessage(wrapExtracted({ vendorName: "Nobody Ltd", lineItems: ["Annual license seat", "Support"] })),
    ]);
    const parsed = CategorizationSchema.parse(result);
    expect(parsed.category).toBe("SOFTWARE");
    expect(parsed.glAccount).toBe(GL_ACCOUNTS.SOFTWARE);
    expect(parsed.confidence).toBeCloseTo(0.7, 5);
  });

  it("surfaces an unparsable payload in the rationale and drops the confidence", async () => {
    const model = new ScriptedChatModel();
    const structured = model.withStructuredOutput(CategorizationSchema, { name: TOOL_NAMES.categorize });
    const result = await structured.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.categorize}`),
      new HumanMessage(
        `${PROMPT_MARKERS.extractedOpen}\n{"vendorName": "Broken", "lineItems": [\n${PROMPT_MARKERS.extractedClose}`,
      ),
    ]);
    const parsed = CategorizationSchema.parse(result);
    expect(parsed.confidence).toBeCloseTo(0.3, 5);
    expect(parsed.rationale).toMatch(/could not be parsed/i);
  });

  it("returns OTHER for unmatched descriptions", async () => {
    const model = new ScriptedChatModel();
    const structured = model.withStructuredOutput(CategorizationSchema, { name: TOOL_NAMES.categorize });
    const result = await structured.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.categorize}`),
      new HumanMessage(wrapExtracted({ vendorName: "Nobody Ltd", lineItems: ["zzz qqq"] })),
    ]);
    expect(CategorizationSchema.parse(result).category).toBe("OTHER");
  });
});

describe("ScriptedChatModel investigate responder", () => {
  const extractedPayload = {
    invoiceNumber: "INV-2026-0417",
    vendorName: "Acme Cloud Inc",
    total: 216,
    subtotal: 200,
    taxRate: 0.08,
    taxAmount: 16,
    issueDate: "2026-07-03",
    lineItems: FIXTURE_EXTRACTED.lineItems,
  };

  it("issues one parallel tool call per bound investigator tool on turn 1", async () => {
    const model = new ScriptedChatModel();
    const bound = model.bindTools!([...investigatorTools, reportTool]);
    const message = await bound.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.investigate} Investigate.`),
      new HumanMessage(wrapExtracted(extractedPayload)),
    ]);
    expect(message.tool_calls).toHaveLength(4);
    expect(message.tool_calls!.map((tc) => tc.name)).toEqual([...INVESTIGATOR_TOOL_NAMES]);
    const byName = Object.fromEntries(message.tool_calls!.map((tc) => [tc.name, tc.args]));
    expect(byName[TOOL_NAMES.lookupVendor]).toEqual({ name: "Acme Cloud Inc" });
    expect(byName[TOOL_NAMES.recomputeTotals]).toMatchObject({ subtotal: 200, taxRate: 0.08, total: 216 });
    expect(byName[TOOL_NAMES.findDuplicates]).toMatchObject({ invoiceNumber: "INV-2026-0417", total: 216 });
    expect(byName[TOOL_NAMES.searchPolicy]!["query"]).toContain("approval threshold");
  });

  it("returns a structured report tool call on turn 2 and recommends reject on a ledger duplicate", async () => {
    const model = new ScriptedChatModel();
    const bound = model.bindTools!([...investigatorTools, reportTool]);
    const turn1 = new AIMessage({
      content: "",
      tool_calls: INVESTIGATOR_TOOL_NAMES.map((name, i) => ({
        id: `call-${i}`,
        name,
        args: {},
        type: "tool_call" as const,
      })),
    });
    // Shapes match the real tools in src/tools: TotalsResult, VendorLookupResult, DuplicateSearchResult.
    const toolMessages = [
      new ToolMessage({
        tool_call_id: "call-0",
        name: TOOL_NAMES.recomputeTotals,
        content: JSON.stringify({ computedLineSum: 200, lineSumMatches: true, totalMatches: true, issues: [] }),
      }),
      new ToolMessage({ tool_call_id: "call-1", name: TOOL_NAMES.lookupVendor, content: JSON.stringify({ found: true, approved: true }) }),
      new ToolMessage({
        tool_call_id: "call-2",
        name: TOOL_NAMES.findDuplicates,
        content: JSON.stringify({ exact: [{ documentId: "doc-9", invoiceNumber: "INV-2026-0417" }], sameNumberOtherVendor: [], similar: [] }),
      }),
      new ToolMessage({
        tool_call_id: "call-3",
        name: TOOL_NAMES.searchPolicy,
        content: JSON.stringify({ excerpts: [{ section: "Duplicates", text: "Duplicate invoices must be rejected.", score: 4 }] }),
      }),
    ];

    const message = await bound.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.investigate} Investigate.`),
      new HumanMessage(wrapExtracted(extractedPayload)),
      turn1,
      ...toolMessages,
    ]);

    expect(message.tool_calls).toHaveLength(1);
    const call = message.tool_calls![0]!;
    expect(call.name).toBe(TOOL_NAMES.investigationReport);
    expect(call.args["recommendation"]).toBe("reject");
    expect(String(call.args["brief"]).length).toBeGreaterThan(20);
    expect(call.args["confidence"]).toBeCloseTo(0.9, 5);
    expect(call.args["toolsUsed"]).toEqual([...INVESTIGATOR_TOOL_NAMES]);
  });

  it("recommends approve only when every check came back clean", async () => {
    const model = new ScriptedChatModel();
    const bound = model.bindTools!([...investigatorTools, reportTool]);
    const message = await bound.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.investigate}`),
      new HumanMessage(wrapExtracted(extractedPayload)),
      new AIMessage({
        content: "",
        tool_calls: INVESTIGATOR_TOOL_NAMES.map((name, i) => ({ id: `ok-${i}`, name, args: {}, type: "tool_call" as const })),
      }),
      new ToolMessage({
        tool_call_id: "ok-0",
        name: TOOL_NAMES.recomputeTotals,
        content: JSON.stringify({ lineSumMatches: true, totalMatches: true, issues: [] }),
      }),
      new ToolMessage({ tool_call_id: "ok-1", name: TOOL_NAMES.lookupVendor, content: JSON.stringify({ found: true, approved: true }) }),
      new ToolMessage({ tool_call_id: "ok-2", name: TOOL_NAMES.findDuplicates, content: JSON.stringify({ exact: [], sameNumberOtherVendor: [], similar: [] }) }),
      new ToolMessage({ tool_call_id: "ok-3", name: TOOL_NAMES.searchPolicy, content: JSON.stringify({ excerpts: [] }) }),
    ]);

    const call = message.tool_calls![0]!;
    expect(call.args["recommendation"]).toBe("approve");
    expect(call.args["confidence"]).toBeCloseTo(0.9, 5);
  });

  it("escalates rather than rejects on a near-duplicate and on failed arithmetic", async () => {
    const model = new ScriptedChatModel();
    const bound = model.bindTools!([...investigatorTools, reportTool]);
    const message = await bound.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.investigate}`),
      new HumanMessage(wrapExtracted(extractedPayload)),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "d1", name: TOOL_NAMES.findDuplicates, args: {}, type: "tool_call" },
          { id: "d2", name: TOOL_NAMES.recomputeTotals, args: {}, type: "tool_call" },
        ],
      }),
      new ToolMessage({
        tool_call_id: "d1",
        name: TOOL_NAMES.findDuplicates,
        content: JSON.stringify({ exact: [], sameNumberOtherVendor: [], similar: [{ documentId: "doc-7", total: 216 }] }),
      }),
      new ToolMessage({
        tool_call_id: "d2",
        name: TOOL_NAMES.recomputeTotals,
        content: JSON.stringify({ computedLineSum: 200, lineSumMatches: true, totalMatches: false, issues: [] }),
      }),
    ]);
    expect(message.tool_calls![0]!.args["recommendation"]).toBe("escalate");
  });

  it("escalates when a check reports null (not checkable) instead of claiming it reconciles", async () => {
    const model = new ScriptedChatModel();
    const bound = model.bindTools!([...investigatorTools, reportTool]);
    const message = await bound.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.investigate}`),
      new HumanMessage(wrapExtracted(extractedPayload)),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "e1", name: TOOL_NAMES.recomputeTotals, args: {}, type: "tool_call" },
          { id: "e2", name: TOOL_NAMES.lookupVendor, args: {}, type: "tool_call" },
          { id: "e3", name: TOOL_NAMES.findDuplicates, args: {}, type: "tool_call" },
        ],
      }),
      new ToolMessage({
        tool_call_id: "e1",
        name: TOOL_NAMES.recomputeTotals,
        content: JSON.stringify({
          lineSumMatches: true,
          totalMatches: null,
          issues: [{ code: "MISSING_FIELD", severity: "warning", message: "no amount" }],
        }),
      }),
      new ToolMessage({ tool_call_id: "e2", name: TOOL_NAMES.lookupVendor, content: JSON.stringify({ found: true, approved: true }) }),
      new ToolMessage({ tool_call_id: "e3", name: TOOL_NAMES.findDuplicates, content: JSON.stringify({ exact: [], sameNumberOtherVendor: [], similar: [] }) }),
    ]);

    const call = message.tool_calls![0]!;
    expect(call.args["recommendation"]).toBe("escalate");
    expect(call.args["confidence"]).toBeCloseTo(0.5, 5);
    const brief = String(call.args["brief"]);
    expect(brief).toContain("the grand total could not be verified");
    expect(brief).not.toContain("Arithmetic on the document reconciles");
  });

  it("escalates with no confidence when no tool result can be attributed to a tool", async () => {
    const model = new ScriptedChatModel();
    const bound = model.bindTools!([...investigatorTools, reportTool]);
    const message = await bound.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.investigate}`),
      new HumanMessage(wrapExtracted(extractedPayload)),
      // No AI tool_calls to resolve the id against, and the ToolMessage carries no name.
      new ToolMessage({ tool_call_id: "orphan", content: JSON.stringify({ exact: [], sameNumberOtherVendor: [], similar: [] }) }),
    ]);

    const call = message.tool_calls![0]!;
    expect(call.args["recommendation"]).toBe("escalate");
    expect(call.args["confidence"]).toBeLessThanOrEqual(0.3);
    expect(call.args["toolsUsed"]).toEqual([]);
    expect(String(call.args["brief"])).toContain("no usable tool evidence");
  });

  it("treats unparsable and off-shape tool output as not checkable and says so", async () => {
    const model = new ScriptedChatModel();
    const bound = model.bindTools!([...investigatorTools, reportTool]);
    const message = await bound.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.investigate}`),
      new HumanMessage(wrapExtracted(extractedPayload)),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "p1", name: TOOL_NAMES.recomputeTotals, args: {}, type: "tool_call" },
          { id: "p2", name: TOOL_NAMES.findDuplicates, args: {}, type: "tool_call" },
        ],
      }),
      new ToolMessage({ tool_call_id: "p1", name: TOOL_NAMES.recomputeTotals, content: "{not json at all" }),
      // The old speculative shape: valid JSON, but not what find_duplicates returns.
      new ToolMessage({ tool_call_id: "p2", name: TOOL_NAMES.findDuplicates, content: JSON.stringify({ matches: [{ id: 1 }] }) }),
    ]);

    const call = message.tool_calls![0]!;
    expect(call.args["recommendation"]).toBe("escalate");
    const brief = String(call.args["brief"]);
    expect(brief).toContain(`Tool output for ${TOOL_NAMES.recomputeTotals} could not be parsed.`);
    expect(brief).toContain(`Tool output for ${TOOL_NAMES.findDuplicates} did not have the expected shape.`);
  });

  it("escalates an unknown vendor and answers as plain text when no report tool is bound", async () => {
    const model = new ScriptedChatModel();
    const bound = model.bindTools!(investigatorTools);
    const message = await bound.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.investigate}`),
      new HumanMessage(wrapExtracted(extractedPayload)),
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: TOOL_NAMES.lookupVendor, args: {}, type: "tool_call" }] }),
      new ToolMessage({ tool_call_id: "c1", name: TOOL_NAMES.lookupVendor, content: JSON.stringify({ found: false }) }),
    ]);
    expect(message.tool_calls ?? []).toHaveLength(0);
    expect(typeof message.content).toBe("string");
    expect(String(message.content)).toMatch(/escalate/i);
  });
});

describe("ScriptedChatModel summarize responder", () => {
  it("writes a multi-sentence digest mentioning the batch total", async () => {
    const model = new ScriptedChatModel();
    const message = await model.invoke(summaryMessages());
    const text = String(message.content);
    expect(text).toContain("7");
    expect(text.split(/(?<=\.)\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });

  it("says the statistics were unreadable instead of reporting zeros", async () => {
    const model = new ScriptedChatModel();
    const message = await model.invoke([
      new SystemMessage(`${SYSTEM_MARKERS.summarize}`),
      new HumanMessage(
        `${PROMPT_MARKERS.statsOpen}\n{"total": 7, oops\n${PROMPT_MARKERS.statsClose}\n\nHighlights:\n- INV-1 rejected as duplicate`,
      ),
    ]);
    const text = String(message.content);
    expect(text).toMatch(/could not be read/i);
    expect(text).toContain("INV-1 rejected as duplicate");
    expect(text).not.toMatch(/Processed 0 invoices/);
  });

  it("streams word chunks that reassemble into the invoke() text", async () => {
    const model = new ScriptedChatModel();
    const chunks: string[] = [];
    for await (const chunk of await model.stream(summaryMessages())) {
      chunks.push(String(chunk.content));
    }
    expect(chunks.length).toBeGreaterThan(3);
    const full = await model.invoke(summaryMessages());
    expect(chunks.join("")).toBe(String(full.content));
  });

  it("streams tool calls as tool_call_chunks that collapse into tool_calls", async () => {
    const model = new ScriptedChatModel();
    const bound = model.bindTools!([
      {
        type: "function",
        function: { name: TOOL_NAMES.extract, description: "extract", parameters: { type: "object", properties: {} } },
      },
    ]);
    const chunks = [];
    for await (const chunk of await bound.stream([new HumanMessage(wrapDocument(PLAIN_TEXT))])) {
      chunks.push(chunk);
    }
    const merged = chunks.reduce((acc, chunk) => (acc === null ? chunk : acc.concat(chunk)), null as (typeof chunks)[number] | null);
    expect(merged!.tool_calls).toHaveLength(1);
    expect(merged!.tool_calls![0]!.name).toBe(TOOL_NAMES.extract);
    expect(merged!.tool_calls![0]!.args["invoiceNumber"]).toBe("INV-2026-0417");
  });
});

describe("ScriptedChatModel fault injection and call counting", () => {
  it("always throws a TransientModelError at failureRate 1", async () => {
    const model = new ScriptedChatModel({ failureRate: 1 });
    await expect(model.invoke(summaryMessages())).rejects.toBeInstanceOf(TransientModelError);
  });

  it("is deterministic for a given seed", async () => {
    const outcomes = async (seed: number): Promise<boolean[]> => {
      const model = new ScriptedChatModel({ failureRate: 0.5, seed });
      const results: boolean[] = [];
      for (let i = 0; i < 8; i += 1) {
        try {
          await model.invoke(summaryMessages());
          results.push(true);
        } catch {
          results.push(false);
        }
      }
      return results;
    };
    expect(await outcomes(7)).toEqual(await outcomes(7));
    expect(await outcomes(7)).not.toEqual(await outcomes(99));
  });

  it("counts every generate/stream call, including through bindTools", async () => {
    const model = new ScriptedChatModel();
    expect(model.calls).toBe(0);
    await model.invoke(summaryMessages());
    expect(model.calls).toBe(1);
    const structured = model.withStructuredOutput(ExtractedInvoiceSchema, { name: TOOL_NAMES.extract });
    await structured.invoke([new HumanMessage(wrapDocument(PLAIN_TEXT))]);
    expect(model.calls).toBe(2);
    for await (const _chunk of await model.stream(summaryMessages())) {
      // drain
    }
    expect(model.calls).toBe(3);
  });

  it("fails the same documents whatever order they are processed in", async () => {
    const documents = ["doc-001", "doc-002", "doc-003"];
    const failuresFor = async (order: string[]): Promise<string[]> => {
      const model = new ScriptedChatModel({ failureRate: 0.5, seed: 1 });
      const failed: string[] = [];
      for (const id of order) {
        try {
          await model.invoke([new HumanMessage(`Summarise invoice ${id}`)]);
        } catch {
          failed.push(id);
        }
      }
      return failed.sort();
    };

    const forwards = await failuresFor(documents);
    const backwards = await failuresFor([...documents].reverse());

    // Mixed outcome, so the comparison is not vacuous.
    expect(forwards.length).toBeGreaterThan(0);
    expect(forwards.length).toBeLessThan(documents.length);
    expect(backwards).toEqual(forwards);
  });

  it("counts a call even when fault injection fires", async () => {
    const model = new ScriptedChatModel({ failureRate: 1 });
    await expect(model.invoke(summaryMessages())).rejects.toThrow();
    expect(model.calls).toBe(1);
  });
});
