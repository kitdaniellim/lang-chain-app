import { describe, expect, it } from "vitest";
import { buildExtractChain, EXTRACT_SYSTEM } from "../../src/chains/extract.js";
import { ScriptedChatModel } from "../../src/llm/fake-model.js";
import { ExtractedInvoiceSchema, type RawInvoiceDocument } from "../../src/domain/schemas.js";
import { SYSTEM_MARKERS } from "../../src/domain/constants.js";
import {
  EMAIL_TEXT,
  FIXTURE_EXTRACTED,
  PLAIN_TEXT,
  TABLE_TEXT,
  TABLE_VENDOR_NAME,
} from "../fixtures/sample-documents.js";

const doc = (format: RawInvoiceDocument["format"], text: string): RawInvoiceDocument => ({
  id: `doc-${format}`,
  filename: `doc-${format}.txt`,
  format,
  text,
});

describe("buildExtractChain", () => {
  it("starts its system prompt with the extract marker", () => {
    expect(EXTRACT_SYSTEM.startsWith(SYSTEM_MARKERS.extract)).toBe(true);
  });

  it.each([
    ["plain", PLAIN_TEXT, FIXTURE_EXTRACTED.vendorName],
    ["email", EMAIL_TEXT, FIXTURE_EXTRACTED.vendorName],
    ["table", TABLE_TEXT, TABLE_VENDOR_NAME],
  ] as const)("extracts a schema-valid invoice from the %s layout", async (format, text, vendorName) => {
    const chain = buildExtractChain(new ScriptedChatModel());
    const result = await chain.invoke({ document: doc(format, text) });

    expect(ExtractedInvoiceSchema.safeParse(result).success).toBe(true);
    const { confidence, warnings, ...core } = result;
    expect(core).toEqual({ ...FIXTURE_EXTRACTED, vendorName });
    expect(confidence).toBeGreaterThanOrEqual(0.8);
    expect(warnings).toEqual([]);
  });

  it("does not treat braces in the document as prompt template variables", async () => {
    const braced = PLAIN_TEXT.replace("Notes: Thank you for your business.", "Notes: {json} {{escaped}} {a:1}");
    const chain = buildExtractChain(new ScriptedChatModel());
    const result = await chain.invoke({ document: doc("plain", braced) });

    expect(result.invoiceNumber).toBe("INV-2026-0417");
    expect(result.total).toBe(216);
  });

  it("returns a low-confidence empty extraction for unreadable text", async () => {
    const chain = buildExtractChain(new ScriptedChatModel());
    const result = await chain.invoke({ document: doc("plain", "nothing useful in here whatsoever") });

    expect(result.confidence).toBeLessThan(0.3);
    expect(result.lineItems).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
