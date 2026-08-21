import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { PROMPT_MARKERS, SYSTEM_MARKERS, TOOL_NAMES } from "../domain/constants.js";
import { ExtractedInvoiceSchema, type ExtractedInvoice, type RawInvoiceDocument } from "../domain/schemas.js";
import type { ChainBuilder } from "../llm/types.js";

export interface ExtractChainInput {
  document: RawInvoiceDocument;
}

/** No braces in this string: it is parsed as an f-string prompt template. */
export const EXTRACT_SYSTEM = `${SYSTEM_MARKERS.extract}
Read the invoice document between the markers and return one structured extraction.
Rules:
- Copy every value exactly as printed. Never recompute a subtotal, tax amount or total, even when the arithmetic looks wrong; downstream validation depends on seeing the original figures.
- Use null for any field the document does not contain. Never invent an invoice number, PO number or date.
- Normalise every date to YYYY-MM-DD.
- Express the tax rate as a fraction, so 8% becomes 0.08.
- List line items in document order, keeping their descriptions verbatim.
- Rate your own confidence from 0 to 1 and record anything ambiguous or unreadable in warnings.`;

/**
 * Document -> structured extraction. The document text travels as a template
 * *variable*, never as template text, so braces inside an invoice are inert.
 */
export const buildExtractChain: ChainBuilder<ExtractChainInput, ExtractedInvoice> = (model) =>
  RunnableSequence.from<ExtractChainInput, ExtractedInvoice>([
    RunnableLambda.from((input: ExtractChainInput) => ({
      payload: `${PROMPT_MARKERS.documentOpen}\n${input.document.text}\n${PROMPT_MARKERS.documentClose}`,
    })),
    ChatPromptTemplate.fromMessages([
      ["system", EXTRACT_SYSTEM],
      ["human", "{payload}"],
    ]),
    model.withStructuredOutput(ExtractedInvoiceSchema, { name: TOOL_NAMES.extract }),
    RunnableLambda.from((raw: unknown) => ExtractedInvoiceSchema.parse(raw)),
  ]);
