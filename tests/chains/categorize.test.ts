import { describe, expect, it } from "vitest";
import { AIMessageChunk } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { buildCategorizeChain, CATEGORIZE_SYSTEM } from "../../src/chains/categorize.js";
import { ScriptedChatModel } from "../../src/llm/fake-model.js";
import { SYSTEM_MARKERS, TOOL_NAMES } from "../../src/domain/constants.js";
import { CategorizationSchema, GL_ACCOUNTS, type ExtractedInvoice } from "../../src/domain/schemas.js";
import { FIXTURE_EXTRACTED } from "../fixtures/sample-documents.js";

const extracted: ExtractedInvoice = { ...FIXTURE_EXTRACTED, confidence: 0.92, warnings: [] };

/** Stands in for a model that invents a GL code the chain must overwrite. */
class HallucinatingModel extends ScriptedChatModel {
  override async _generate(): Promise<ChatResult> {
    const message = new AIMessageChunk({
      content: "",
      tool_calls: [
        {
          id: "call_bogus",
          name: TOOL_NAMES.categorize,
          args: { category: "TRAVEL", glAccount: "9999", confidence: 0.4, rationale: "a guess" },
          type: "tool_call",
        },
      ],
    });
    return { generations: [{ message, text: "" }] };
  }
}

describe("buildCategorizeChain", () => {
  it("starts its system prompt with the categorize marker", () => {
    expect(CATEGORIZE_SYSTEM.startsWith(SYSTEM_MARKERS.categorize)).toBe(true);
  });

  it("uses the vendor registry hint when one is supplied", async () => {
    const chain = buildCategorizeChain(new ScriptedChatModel());
    const result = await chain.invoke({ extracted, vendorHint: "CLOUD_HOSTING" });

    expect(CategorizationSchema.safeParse(result).success).toBe(true);
    expect(result.category).toBe("CLOUD_HOSTING");
    expect(result.glAccount).toBe(GL_ACCOUNTS.CLOUD_HOSTING);
    expect(result.glAccount).toBe("6110");
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it("falls back to line-item wording when there is no hint", async () => {
    const chain = buildCategorizeChain(new ScriptedChatModel());
    const softwareInvoice: ExtractedInvoice = {
      ...extracted,
      vendorName: "Nobody Ltd",
      lineItems: [{ description: "Annual software license", quantity: 1, unitPrice: 500, amount: 500 }],
    };
    const result = await chain.invoke({ extracted: softwareInvoice, vendorHint: null });

    expect(result.category).toBe("SOFTWARE");
    expect(result.glAccount).toBe(GL_ACCOUNTS.SOFTWARE);
  });

  it("overwrites a hallucinated GL account with the mapping for the chosen category", async () => {
    const chain = buildCategorizeChain(new HallucinatingModel());
    const result = await chain.invoke({ extracted, vendorHint: null });

    expect(result.category).toBe("TRAVEL");
    expect(result.glAccount).toBe(GL_ACCOUNTS.TRAVEL);
  });

  it("survives braces inside line-item descriptions", async () => {
    const chain = buildCategorizeChain(new ScriptedChatModel());
    const braced: ExtractedInvoice = {
      ...extracted,
      lineItems: [{ description: "Config {env} for {tenant}", quantity: 1, unitPrice: 1, amount: 1 }],
    };
    const result = await chain.invoke({ extracted: braced, vendorHint: null });

    expect(CategorizationSchema.safeParse(result).success).toBe(true);
  });
});
