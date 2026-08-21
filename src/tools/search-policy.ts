import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { TOOL_NAMES } from "../domain/constants.js";
import type { BaseRetriever } from "@langchain/core/retrievers";
import type { PolicyChunkMetadata } from "../rag/policy-retriever.js";

export const SearchPolicyInput = z.object({
  query: z.string().describe("What to look up, e.g. 'purchase order required' or 'unknown vendor'"),
});

export interface PolicyExcerpt {
  /** The handbook section the excerpt came from. */
  section: string;
  text: string;
  /** BM25 relevance; higher is a closer match. */
  score: number;
}

export interface SearchPolicyResult {
  excerpts: PolicyExcerpt[];
}

/** RAG over the approval handbook, so quoted rules match the enforced numbers. */
export function createSearchPolicyTool(deps: { retriever: BaseRetriever<PolicyChunkMetadata> }) {
  return tool(
    async ({ query }): Promise<SearchPolicyResult> => {
      const docs = await deps.retriever.invoke(query);
      // The retriever always returns its top k; drop the zero-score padding so the
      // model never quotes a passage that did not actually match the query.
      return {
        excerpts: docs
          .filter((doc) => doc.metadata.score > 0)
          .map((doc) => ({
            section: doc.metadata.section,
            text: doc.pageContent,
            score: doc.metadata.score,
          })),
      };
    },
    {
      name: TOOL_NAMES.searchPolicy,
      description:
        "Search the accounts-payable approval handbook and return the most relevant passages with their section headings. Call this to quote the exact rule behind a decision — thresholds, purchase-order requirements, vendor rules, duplicate handling or data-quality rules — instead of relying on memory.",
      schema: SearchPolicyInput,
    },
  );
}
