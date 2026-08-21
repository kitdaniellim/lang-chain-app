import { ChatPromptTemplate, FewShotChatMessagePromptTemplate } from "@langchain/core/prompts";
import type { BaseMessagePromptTemplate } from "@langchain/core/prompts";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { PROMPT_MARKERS, SYSTEM_MARKERS, TOOL_NAMES } from "../domain/constants.js";
import { CategorizationSchema, GL_ACCOUNTS, type Categorization, type ExtractedInvoice } from "../domain/schemas.js";
import type { ChainBuilder } from "../llm/types.js";

export interface CategorizeChainInput {
  extracted: ExtractedInvoice;
  vendorHint: string | null;
}

/** No braces in this string: it is parsed as an f-string prompt template. */
export const CATEGORIZE_SYSTEM = `${SYSTEM_MARKERS.categorize}
Choose exactly one expense category for the invoice described between the markers.
Weigh the line-item wording first and the vendor name second. When a vendor registry hint is present, prefer it unless the line items clearly contradict it.
Answer with the category, your confidence from 0 to 1, and a one-sentence rationale.`;

/** vendor + line descriptions -> category. */
const EXAMPLES = [
  { input: "Acme Cloud Inc | Compute hours (c5.large); Object storage 2 TB", output: "CLOUD_HOSTING" },
  { input: "Northwind Software LLC | Annual license renewal; 25 additional seats", output: "SOFTWARE" },
  { input: "Paperclip Office Supply Co | A4 paper 20 reams; Toner cartridges", output: "OFFICE_SUPPLIES" },
  { input: "Summit Legal Advisors | Contract review retainer; Advisory hours", output: "PROFESSIONAL_SERVICES" },
  { input: "SkyLane Travel Partners | Return flight LAX-JFK; Hotel 3 nights", output: "TRAVEL" },
];

const fewShotExamples = new FewShotChatMessagePromptTemplate({
  examples: EXAMPLES,
  examplePrompt: ChatPromptTemplate.fromMessages([
    ["human", "{input}"],
    ["ai", "{output}"],
  ]),
  inputVariables: [],
});

/**
 * Extraction -> category. The final lambda overwrites `glAccount` from the
 * category mapping, because a model may invent a plausible-looking code.
 */
export const buildCategorizeChain: ChainBuilder<CategorizeChainInput, Categorization> = (model) =>
  RunnableSequence.from<CategorizeChainInput, Categorization>([
    RunnableLambda.from((input: CategorizeChainInput) => ({ payload: renderPayload(input) })),
    ChatPromptTemplate.fromMessages([
      ["system", CATEGORIZE_SYSTEM],
      // fromMessages duck-types on formatMessages at runtime, but its types omit BaseChatPromptTemplate.
      fewShotExamples as unknown as BaseMessagePromptTemplate,
      ["human", "{payload}"],
    ]),
    model.withStructuredOutput(CategorizationSchema, { name: TOOL_NAMES.categorize }),
    RunnableLambda.from((raw: unknown) => {
      const parsed = CategorizationSchema.parse(raw);
      return { ...parsed, glAccount: GL_ACCOUNTS[parsed.category] };
    }),
  ]);

function renderPayload(input: CategorizeChainInput): string {
  const compact = {
    vendorName: input.extracted.vendorName,
    lineItems: input.extracted.lineItems.map((item) => item.description),
  };
  const block = `${PROMPT_MARKERS.extractedOpen}\n${JSON.stringify(compact)}\n${PROMPT_MARKERS.extractedClose}`;
  return input.vendorHint ? `${block}\n${PROMPT_MARKERS.vendorHint} ${input.vendorHint}` : block;
}
