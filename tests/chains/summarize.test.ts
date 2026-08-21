import { describe, expect, it } from "vitest";
import { buildSummaryChain, SUMMARY_SYSTEM } from "../../src/chains/summarize.js";
import { ScriptedChatModel } from "../../src/llm/fake-model.js";
import { SYSTEM_MARKERS } from "../../src/domain/constants.js";
import type { BatchStats } from "../../src/domain/schemas.js";

const STATS: BatchStats = {
  total: 12,
  autoApproved: 7,
  approvedByHuman: 2,
  rejectedByHuman: 1,
  autoRejected: 1,
  needsReview: 1,
  approvedAmount: 18_400.25,
  totalAmount: 31_250.75,
  byCategory: { CLOUD_HOSTING: 5, SOFTWARE: 4, TRAVEL: 3 },
  issuesByCode: { TOTAL_MISMATCH: 3, MISSING_PO: 2 },
};

const HIGHLIGHTS = ["INV-2026-0417 was rejected as a duplicate", "Two invoices exceeded the CFO threshold"];
const CURRENCIES = ["USD"];

describe("buildSummaryChain", () => {
  it("starts its system prompt with the summarize marker", () => {
    expect(SUMMARY_SYSTEM.startsWith(SYSTEM_MARKERS.summarize)).toBe(true);
  });

  it("produces non-empty prose that mentions the batch total", async () => {
    const chain = buildSummaryChain(new ScriptedChatModel());
    const summary = await chain.invoke({ stats: STATS, highlights: HIGHLIGHTS, currencies: CURRENCIES });

    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(40);
    expect(summary).toContain("12");
    expect(summary).toContain("CLOUD_HOSTING");
  });

  it("streams the summary in multiple chunks that reassemble into the invoke() text", async () => {
    const chain = buildSummaryChain(new ScriptedChatModel());
    const chunks: string[] = [];
    for await (const chunk of await chain.stream({ stats: STATS, highlights: HIGHLIGHTS, currencies: CURRENCIES })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(3);
    const joined = chunks.join("");
    const invoked = await buildSummaryChain(new ScriptedChatModel()).invoke({
      stats: STATS,
      highlights: HIGHLIGHTS,
      currencies: CURRENCIES,
    });
    expect(joined).toBe(invoked);
  });

  it("handles an empty highlight list", async () => {
    const chain = buildSummaryChain(new ScriptedChatModel());
    const summary = await chain.invoke({ stats: STATS, highlights: [], currencies: CURRENCIES });
    expect(summary.length).toBeGreaterThan(40);
  });
});
