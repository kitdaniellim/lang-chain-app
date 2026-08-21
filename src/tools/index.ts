import type { BaseRetriever } from "@langchain/core/retrievers";
import type { LedgerReader } from "../data/ledger.types.js";
import type { ApprovalPolicy } from "../domain/policy.js";
import type { ToolKit } from "../pipeline/types.js";
import type { PolicyChunkMetadata } from "../rag/policy-retriever.js";
import { createFindDuplicatesTool } from "./find-duplicates.js";
import { createLookupVendorTool } from "./lookup-vendor.js";
import { createRecomputeTotalsTool } from "./recompute-totals.js";
import { createSearchPolicyTool } from "./search-policy.js";

export interface ToolDeps {
  ledger: LedgerReader;
  retriever: BaseRetriever<PolicyChunkMetadata>;
  policy: ApprovalPolicy;
  batchId: string;
}

/** Build the four deterministic tools the investigator agent is given. */
export function createTools(deps: ToolDeps): ToolKit {
  const recomputeTotals = createRecomputeTotalsTool();
  const lookupVendor = createLookupVendorTool();
  const findDuplicates = createFindDuplicatesTool({
    ledger: deps.ledger,
    policy: deps.policy,
    batchId: deps.batchId,
  });
  const searchPolicy = createSearchPolicyTool({ retriever: deps.retriever });

  return {
    recomputeTotals,
    lookupVendor,
    findDuplicates,
    searchPolicy,
    all: [recomputeTotals, lookupVendor, findDuplicates, searchPolicy],
  };
}

export {
  canSearchSimilar,
  checkDates,
  checkLedgerDuplicates,
  checkPolicy,
  checkTotals,
  checkVendor,
  computeTotals,
} from "./checks.js";
export type { TotalsInput, TotalsLineItem, TotalsResult } from "./checks.js";
export { createFindDuplicatesTool, FindDuplicatesInput } from "./find-duplicates.js";
export type { DuplicateSearchResult, FindDuplicatesDeps } from "./find-duplicates.js";
export { createLookupVendorTool, LookupVendorInput } from "./lookup-vendor.js";
export type { VendorLookupResult } from "./lookup-vendor.js";
export { createRecomputeTotalsTool, RecomputeTotalsInput } from "./recompute-totals.js";
export { createSearchPolicyTool, SearchPolicyInput } from "./search-policy.js";
export type { PolicyExcerpt, SearchPolicyResult } from "./search-policy.js";
