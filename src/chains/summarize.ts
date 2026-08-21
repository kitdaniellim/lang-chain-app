import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { PROMPT_MARKERS, SYSTEM_MARKERS } from "../domain/constants.js";
import type { BatchStats } from "../domain/schemas.js";
import type { ChainBuilder } from "../llm/types.js";

export interface SummaryChainInput {
  stats: BatchStats;
  highlights: string[];
  /** Currencies present in the batch; the stats sums are currency-blind without them. */
  currencies: string[];
}

/** No braces in this string: it is parsed as an f-string prompt template. */
export const SUMMARY_SYSTEM = `${SYSTEM_MARKERS.summarize}
Write a plain-prose digest of one processing run for the finance team.
Use 3 to 5 sentences covering the volume and value processed, how many were approved or rejected, what still needs review, the most common issue, and the largest spend category.
Quote the numbers you are given; never estimate or extrapolate. Money figures are in the currencies listed under Currencies; if more than one is listed, say so instead of naming a single currency. No bullet points and no headings.`;

/** Batch stats -> prose digest. Streams token by token through the string parser. */
export const buildSummaryChain: ChainBuilder<SummaryChainInput, string> = (model) =>
  RunnableSequence.from<SummaryChainInput, string>([
    RunnableLambda.from((input: SummaryChainInput) => ({ payload: renderPayload(input) })),
    ChatPromptTemplate.fromMessages([
      ["system", SUMMARY_SYSTEM],
      ["human", "{payload}"],
    ]),
    model,
    new StringOutputParser(),
  ]);

function renderPayload(input: SummaryChainInput): string {
  const stats = `${PROMPT_MARKERS.statsOpen}\n${JSON.stringify(input.stats)}\n${PROMPT_MARKERS.statsClose}`;
  const currencies = `${PROMPT_MARKERS.currencies} ${input.currencies.join(", ") || "none recorded"}`;
  const bullets = input.highlights.length > 0 ? input.highlights.map((line) => `- ${line}`).join("\n") : "- none";
  return `${stats}\n${currencies}\n\nHighlights:\n${bullets}`;
}
