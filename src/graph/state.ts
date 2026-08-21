import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import {
  CategorizationSchema,
  DecisionSchema,
  DeliveryReceiptSchema,
  ExtractedInvoiceSchema,
  InvestigationSchema,
  ProcessedInvoiceSchema,
  RawInvoiceDocumentSchema,
  RiskAssessmentSchema,
  BatchStatsSchema,
  ValidationIssueSchema,
  type ProcessedInvoice,
} from "../domain/schemas.js";

const concat = <T>(current: T[], incoming: T[]): T[] => [...current, ...incoming];

/**
 * Per-invoice subgraph state.
 * `issues` and `timings` use reducers because `validate` and `categorize` run as
 * parallel branches and both contribute; plain fields are last-value-wins.
 */
export const InvoiceState = new StateSchema({
  document: RawInvoiceDocumentSchema,
  extracted: ExtractedInvoiceSchema.nullable().default(null),
  provider: z.string().default("none"),
  issues: new ReducedValue(z.array(ValidationIssueSchema).default(() => []), { reducer: concat }),
  categorization: CategorizationSchema.nullable().default(null),
  risk: RiskAssessmentSchema.nullable().default(null),
  policyExcerpts: z.array(z.string()).default(() => []),
  investigation: InvestigationSchema.nullable().default(null),
  decision: DecisionSchema.default("needs_review"),
  timings: new ReducedValue(z.record(z.string(), z.number()).default(() => ({})), {
    reducer: (current: Record<string, number>, incoming: Record<string, number>) => ({ ...current, ...incoming }),
  }),
});
export type InvoiceStateType = typeof InvoiceState.State;
export type InvoiceUpdate = typeof InvoiceState.Update;

/** Upsert by documentId: fan-in appends, human review replaces. */
export function upsertResults(current: ProcessedInvoice[], incoming: ProcessedInvoice[]): ProcessedInvoice[] {
  const byId = new Map(current.map((r) => [r.documentId, r]));
  for (const r of incoming) byId.set(r.documentId, r);
  return [...byId.values()].sort((a, b) => a.documentId.localeCompare(b.documentId));
}

/** Batch (parent) graph state. */
export const BatchState = new StateSchema({
  batchId: z.string(),
  documents: z.array(RawInvoiceDocumentSchema).default(() => []),
  results: new ReducedValue(z.array(ProcessedInvoiceSchema).default(() => []), { reducer: upsertResults }),
  reviewQueue: z.array(z.string()).default(() => []),
  stats: BatchStatsSchema.nullable().default(null),
  summary: z.string().default(""),
  deliveries: new ReducedValue(z.array(DeliveryReceiptSchema).default(() => []), { reducer: concat }),
  startedAt: z.string().default(""),
  finishedAt: z.string().default(""),
});
export type BatchStateType = typeof BatchState.State;
export type BatchUpdate = typeof BatchState.Update;

/** Input accepted by the `process_invoice` node when targeted by `Send`. */
export const ProcessInvoiceInput = new StateSchema({
  document: RawInvoiceDocumentSchema,
});
