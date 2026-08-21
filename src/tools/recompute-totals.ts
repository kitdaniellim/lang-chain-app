import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { TOOL_NAMES } from "../domain/constants.js";
import { computeTotals, type TotalsResult } from "./checks.js";

const LineItemInput = z.object({
  quantity: z.number().nullable().describe("Quantity as printed, null if absent"),
  unitPrice: z.number().nullable().describe("Unit price as printed, null if absent"),
  amount: z.number().nullable().describe("Line amount as printed, null if absent"),
});

export const RecomputeTotalsInput = z.object({
  lineItems: z.array(LineItemInput).describe("Every line item exactly as printed on the invoice"),
  subtotal: z.number().nullable().describe("Subtotal as printed, null if absent"),
  taxRate: z.number().nullable().describe("Tax rate as a fraction (8% -> 0.08), null if absent"),
  taxAmount: z.number().nullable().describe("Tax amount as printed, null if absent"),
  total: z.number().nullable().describe("Grand total as printed, null if absent"),
});

/** Arithmetic verification: never trust the printed subtotal or total, re-derive them. */
export function createRecomputeTotalsTool() {
  return tool(
    (input): TotalsResult => computeTotals(input),
    {
      name: TOOL_NAMES.recomputeTotals,
      description:
        "Re-add an invoice's line items and re-derive its tax and grand total, then compare them with the printed figures. Call this whenever you need to confirm or dispute the arithmetic on an invoice; it returns the computed values, whether each printed figure matches, and any arithmetic issues found.",
      schema: RecomputeTotalsInput,
    },
  );
}
