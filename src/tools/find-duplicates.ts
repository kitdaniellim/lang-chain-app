import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { LedgerEntry, LedgerReader } from "../data/ledger.types.js";
import { TOOL_NAMES } from "../domain/constants.js";
import type { ApprovalPolicy } from "../domain/policy.js";
import { canSearchSimilar } from "./checks.js";

export const FindDuplicatesInput = z.object({
  invoiceNumber: z.string().nullable().describe("Invoice number to look up, null if absent"),
  vendorName: z.string().nullable().describe("Vendor name for the near-duplicate search"),
  total: z.number().nullable().describe("Invoice total for the near-duplicate search"),
  issueDate: z.string().nullable().describe("Issue date (YYYY-MM-DD) the search window centres on"),
});

export interface DuplicateSearchResult {
  /** Same invoice number *and* same vendor, outside the current batch — a real duplicate payment. */
  exact: LedgerEntry[];
  /** Same invoice number but a different vendor — suspicious, not conclusive. */
  sameNumberOtherVendor: LedgerEntry[];
  /** Same vendor and amount inside the policy's duplicate window. */
  similar: LedgerEntry[];
}

/** Ledger rows are identified by (batchId, documentId) — a document id alone repeats across batches. */
const rowId = (entry: LedgerEntry): string => JSON.stringify([entry.batchId, entry.documentId]);

export interface FindDuplicatesDeps {
  ledger: LedgerReader;
  policy: ApprovalPolicy;
  batchId: string;
}

/** Ledger duplicate search; rows from the current batch are ignored so re-runs are not duplicates. */
export function createFindDuplicatesTool(deps: FindDuplicatesDeps) {
  return tool(
    ({ invoiceNumber, vendorName, total, issueDate }): DuplicateSearchResult => {
      const exact =
        invoiceNumber === null
          ? []
          : deps.ledger.findExact({ invoiceNumber, vendorName, excludeBatchId: deps.batchId });
      const exactIds = new Set(exact.map(rowId));
      const sameNumber = invoiceNumber === null ? [] : deps.ledger.find(invoiceNumber, deps.batchId);
      return {
        exact,
        sameNumberOtherVendor: sameNumber.filter((entry) => !exactIds.has(rowId(entry))),
        similar: canSearchSimilar({ vendorName, total, issueDate })
          ? deps.ledger
              .findSimilar({
                vendorName,
                total,
                issueDate,
                windowDays: deps.policy.duplicateWindowDays,
                excludeBatchId: deps.batchId,
              })
              .filter((entry) => !exactIds.has(rowId(entry)))
          : [],
      };
    },
    {
      name: TOOL_NAMES.findDuplicates,
      description: `Search the payment ledger for invoices already processed. Call this to decide whether an invoice is a duplicate: it returns exact matches (same invoice number AND same vendor), rows reusing the number under a different vendor, and near matches from the same vendor for the same amount within ${deps.policy.duplicateWindowDays} days. Rows from the batch being processed are excluded.`,
      schema: FindDuplicatesInput,
    },
  );
}
