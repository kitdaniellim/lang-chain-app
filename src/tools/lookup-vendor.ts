import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { TOOL_NAMES } from "../domain/constants.js";
import type { Category } from "../domain/schemas.js";
import { findVendor } from "../domain/vendors.js";

export const LookupVendorInput = z.object({
  name: z.string().describe("Vendor name exactly as it appears on the invoice"),
});

export interface VendorLookupResult {
  found: boolean;
  vendorId?: string;
  canonicalName?: string;
  approved?: boolean;
  defaultCategory?: Category;
  /** Whether the registry hit came from the vendor's name or one of its aliases. */
  matchedOn?: "name" | "alias";
  /** 1 = exact normalised match, lower = fuzzy. */
  score?: number;
}

/** Registry lookup: normalises legal suffixes and aliases before matching. */
export function createLookupVendorTool() {
  return tool(
    ({ name }): VendorLookupResult => {
      const match = findVendor(name);
      if (!match) return { found: false };
      return {
        found: true,
        vendorId: match.vendor.id,
        canonicalName: match.vendor.name,
        approved: match.vendor.approved,
        defaultCategory: match.vendor.defaultCategory,
        matchedOn: match.matchedOn,
        score: match.score,
      };
    },
    {
      name: TOOL_NAMES.lookupVendor,
      description:
        "Look a vendor name up in the approved vendor registry, tolerating case, punctuation, legal suffixes (Inc, LLC, Ltd) and known trading aliases. Call this before treating a vendor as unknown; it returns the registry id, canonical name, approval status and default expense category.",
      schema: LookupVendorInput,
    },
  );
}
