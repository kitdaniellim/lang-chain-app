/**
 * Names and markers shared between the prompts, the tools, and the fake model.
 * The fake model routes on these, so they live in one place.
 */
export const TOOL_NAMES = {
  extract: "extract_invoice",
  categorize: "categorize_invoice",
  recomputeTotals: "recompute_totals",
  lookupVendor: "lookup_vendor",
  findDuplicates: "find_duplicates",
  searchPolicy: "search_policy",
  investigationReport: "investigation_report",
} as const;
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/** Tools the investigator agent is given (in this order). */
export const INVESTIGATOR_TOOL_NAMES: readonly string[] = [
  TOOL_NAMES.recomputeTotals,
  TOOL_NAMES.lookupVendor,
  TOOL_NAMES.findDuplicates,
  TOOL_NAMES.searchPolicy,
];

/** Delimiters used inside human messages so both Claude and the fake model can find the payload. */
export const PROMPT_MARKERS = {
  documentOpen: "<invoice_document>",
  documentClose: "</invoice_document>",
  extractedOpen: "<extracted_invoice>",
  extractedClose: "</extracted_invoice>",
  statsOpen: "<batch_stats>",
  statsClose: "</batch_stats>",
  currencies: "Currencies:",
  vendorHint: "Vendor registry hint:",
} as const;

/** First sentence of each system prompt. The fake model uses these to pick a responder. */
export const SYSTEM_MARKERS = {
  extract: "You are an accounts-payable extraction engine.",
  categorize: "You are an accounts-payable categorization assistant.",
  investigate: "You are an accounts-payable compliance investigator.",
  summarize: "You are an accounts-payable operations analyst.",
} as const;

/** Cents-level tolerance when comparing money that was printed with 2 decimals. */
export const MONEY_TOLERANCE = 0.011;

export const LEDGER_FILENAME = "ledger.json";
