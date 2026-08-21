import { z } from "zod";

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  "SOFTWARE",
  "CLOUD_HOSTING",
  "OFFICE_SUPPLIES",
  "PROFESSIONAL_SERVICES",
  "TRAVEL",
  "MARKETING",
  "UTILITIES",
  "EQUIPMENT",
  "OTHER",
] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

/** General-ledger account per category (what finance books the expense to). */
export const GL_ACCOUNTS: Record<Category, string> = {
  SOFTWARE: "6100",
  CLOUD_HOSTING: "6110",
  OFFICE_SUPPLIES: "6200",
  PROFESSIONAL_SERVICES: "6300",
  TRAVEL: "6400",
  MARKETING: "6500",
  UTILITIES: "6600",
  EQUIPMENT: "1500",
  OTHER: "6900",
};

export const CURRENCIES = ["USD", "EUR", "GBP", "PHP"] as const;
export const CurrencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof CurrencySchema>;

/** Defects the generator can inject into an otherwise-valid invoice. */
export const DEFECT_CODES = [
  "MATH_MISMATCH",
  "LINE_SUM_MISMATCH",
  "DUE_BEFORE_ISSUE",
  "MISSING_DUE_DATE",
  "DUPLICATE_NUMBER",
  "UNKNOWN_VENDOR",
  "OVER_THRESHOLD",
  "MISSING_PO",
  "FOREIGN_CURRENCY",
] as const;
export const DefectCodeSchema = z.enum(DEFECT_CODES);
export type DefectCode = z.infer<typeof DefectCodeSchema>;

export const DOCUMENT_FORMATS = ["plain", "email", "table"] as const;
export const DocumentFormatSchema = z.enum(DOCUMENT_FORMATS);
export type DocumentFormat = z.infer<typeof DocumentFormatSchema>;

// ---------------------------------------------------------------------------
// Ground truth (what the generator knows; never shown to the pipeline)
// ---------------------------------------------------------------------------

export const LineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  amount: z.number().nonnegative(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const InvoiceSchema = z.object({
  id: z.string(),
  invoiceNumber: z.string(),
  vendor: z.object({
    name: z.string(),
    email: z.string(),
    address: z.string(),
  }),
  /** ISO date YYYY-MM-DD */
  issueDate: z.string(),
  /** ISO date YYYY-MM-DD, null when the document omits it */
  dueDate: z.string().nullable(),
  currency: CurrencySchema,
  lineItems: z.array(LineItemSchema).min(1),
  subtotal: z.number(),
  /** 0..1 */
  taxRate: z.number(),
  taxAmount: z.number(),
  total: z.number(),
  poNumber: z.string().nullable(),
  notes: z.string().nullable(),
  defects: z.array(DefectCodeSchema),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

/** The unstructured document the pipeline receives. */
export const RawInvoiceDocumentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  format: DocumentFormatSchema,
  text: z.string().min(1),
});
export type RawInvoiceDocument = z.infer<typeof RawInvoiceDocumentSchema>;

export const BatchManifestSchema = z.object({
  batchId: z.string(),
  createdAt: z.string(),
  seed: z.number(),
  defectRate: z.number(),
  documents: z.array(RawInvoiceDocumentSchema),
  groundTruth: z.array(InvoiceSchema),
});
export type BatchManifest = z.infer<typeof BatchManifestSchema>;

// ---------------------------------------------------------------------------
// LLM outputs (structured output schemas — descriptions are sent to the model)
// ---------------------------------------------------------------------------

export const ExtractedLineItemSchema = z.object({
  description: z.string().describe("Line item description exactly as written"),
  quantity: z.number().nullable().describe("Quantity, null if absent"),
  unitPrice: z.number().nullable().describe("Unit price, null if absent"),
  amount: z.number().nullable().describe("Line amount as printed, null if absent"),
});
export type ExtractedLineItem = z.infer<typeof ExtractedLineItemSchema>;

export const ExtractedInvoiceSchema = z.object({
  invoiceNumber: z.string().nullable().describe("Invoice number / reference exactly as printed"),
  vendorName: z.string().nullable().describe("Issuing vendor's company name"),
  vendorEmail: z.string().nullable().describe("Vendor contact email if present"),
  issueDate: z.string().nullable().describe("Invoice/issue date normalised to YYYY-MM-DD"),
  dueDate: z.string().nullable().describe("Due date normalised to YYYY-MM-DD, null if absent"),
  currency: z.string().nullable().describe("ISO 4217 currency code, e.g. USD"),
  lineItems: z.array(ExtractedLineItemSchema).describe("All line items in document order"),
  subtotal: z.number().nullable().describe("Subtotal as printed — copy, never recompute"),
  taxRate: z.number().nullable().describe("Tax rate as a fraction (8% -> 0.08), null if absent"),
  taxAmount: z.number().nullable().describe("Tax amount as printed"),
  total: z.number().nullable().describe("Grand total / amount due as printed — copy, never recompute"),
  poNumber: z.string().nullable().describe("Purchase order reference, null if absent"),
  confidence: z.number().min(0).max(1).describe("Overall extraction confidence 0..1"),
  warnings: z.array(z.string()).describe("Anything ambiguous or unreadable in the document"),
});
export type ExtractedInvoice = z.infer<typeof ExtractedInvoiceSchema>;

export const CategorizationSchema = z.object({
  category: CategorySchema.describe("Expense category"),
  glAccount: z.string().describe("General-ledger account code for the category"),
  confidence: z.number().min(0).max(1),
  rationale: z.string().describe("One sentence explaining the choice"),
});
export type Categorization = z.infer<typeof CategorizationSchema>;

export const InvestigationSchema = z.object({
  brief: z.string().describe("2-5 sentence findings brief for the human reviewer"),
  recommendation: z.enum(["approve", "reject", "escalate"]),
  confidence: z.number().min(0).max(1),
  toolsUsed: z.array(z.string()).describe("Names of the tools consulted"),
});
export type Investigation = z.infer<typeof InvestigationSchema>;

// ---------------------------------------------------------------------------
// Deterministic validation / risk / decisions
// ---------------------------------------------------------------------------

export const ISSUE_CODES = [
  "EXTRACTION_FAILED",
  "MISSING_FIELD",
  "TOTAL_MISMATCH",
  "LINE_SUM_MISMATCH",
  "DUE_BEFORE_ISSUE",
  "MISSING_DUE_DATE",
  "UNKNOWN_VENDOR",
  "DUPLICATE_IN_LEDGER",
  "DUPLICATE_IN_BATCH",
  "OVER_REVIEW_THRESHOLD",
  "OVER_CFO_THRESHOLD",
  "MISSING_PO",
  "FOREIGN_CURRENCY",
  "LOW_CONFIDENCE",
] as const;
export const IssueCodeSchema = z.enum(ISSUE_CODES);
export type IssueCode = z.infer<typeof IssueCodeSchema>;

export const IssueSeveritySchema = z.enum(["error", "warning"]);
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export const ValidationIssueSchema = z.object({
  code: IssueCodeSchema,
  severity: IssueSeveritySchema,
  message: z.string(),
  field: z.string().optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RiskAssessmentSchema = z.object({
  score: z.number().min(0).max(100),
  level: RiskLevelSchema,
  reasons: z.array(z.string()),
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const DECISIONS = [
  "auto_approved",
  "approved_by_human",
  "rejected_by_human",
  "auto_rejected",
  "needs_review",
] as const;
export const DecisionSchema = z.enum(DECISIONS);
export type Decision = z.infer<typeof DecisionSchema>;

/** Payload a human (or the auto-reviewer) sends back to resume an interrupt. */
export const ReviewActionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().default(""),
});
export type ReviewAction = z.infer<typeof ReviewActionSchema>;

// ---------------------------------------------------------------------------
// Pipeline outputs
// ---------------------------------------------------------------------------

export const ProcessedInvoiceSchema = z.object({
  documentId: z.string(),
  invoiceNumber: z.string().nullable(),
  extracted: ExtractedInvoiceSchema.nullable(),
  issues: z.array(ValidationIssueSchema),
  categorization: CategorizationSchema.nullable(),
  risk: RiskAssessmentSchema,
  investigation: InvestigationSchema.nullable(),
  decision: DecisionSchema,
  decidedBy: z.enum(["system", "human"]),
  reviewerNote: z.string().nullable(),
  /** "fake" | "anthropic:<model>" — which provider produced the LLM outputs */
  provider: z.string(),
  /** node name -> milliseconds */
  timings: z.record(z.string(), z.number()),
});
export type ProcessedInvoice = z.infer<typeof ProcessedInvoiceSchema>;

export const BatchStatsSchema = z.object({
  total: z.number(),
  autoApproved: z.number(),
  approvedByHuman: z.number(),
  rejectedByHuman: z.number(),
  autoRejected: z.number(),
  needsReview: z.number(),
  /** Sum of extracted totals for approved invoices (USD-equivalent is NOT computed; mixed currencies are summed as printed) */
  approvedAmount: z.number(),
  totalAmount: z.number(),
  byCategory: z.record(z.string(), z.number()),
  issuesByCode: z.record(z.string(), z.number()),
});
export type BatchStats = z.infer<typeof BatchStatsSchema>;

export const DeliveryReceiptSchema = z.object({
  sink: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  at: z.string(),
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

export const BatchResultSchema = z.object({
  batchId: z.string(),
  threadId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  provider: z.string(),
  processed: z.array(ProcessedInvoiceSchema),
  stats: BatchStatsSchema,
  summary: z.string(),
  deliveries: z.array(DeliveryReceiptSchema),
});
export type BatchResult = z.infer<typeof BatchResultSchema>;
