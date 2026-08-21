import type { BaseRetriever } from "@langchain/core/retrievers";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ApprovalPolicy } from "../domain/policy.js";
import type {
  Investigation,
  ReviewAction,
  RiskAssessment,
  ValidationIssue,
} from "../domain/schemas.js";
import type { LedgerReader } from "../data/ledger.types.js";
import type { ModelBundle } from "../llm/types.js";
import type { Logger } from "../observability/logger.js";
import type { PolicyChunkMetadata } from "../rag/policy-retriever.js";
import type { Sink } from "../sinks/types.js";

/** The four deterministic tools, plus the flat list for `bindTools` / `createAgent`. */
export interface ToolKit {
  recomputeTotals: StructuredToolInterface;
  lookupVendor: StructuredToolInterface;
  findDuplicates: StructuredToolInterface;
  searchPolicy: StructuredToolInterface;
  all: StructuredToolInterface[];
}

export type ReviewMode = "interactive" | "approve" | "reject";

/**
 * Runtime dependencies injected into graph nodes via `config.context`
 * (LangGraph's `contextSchema`). Unlike state, context is never checkpointed,
 * so it can hold live objects: models, tools, sinks, loggers.
 */
export interface PipelineContext {
  models: ModelBundle;
  tools: ToolKit;
  ledger: LedgerReader;
  retriever: BaseRetriever<PolicyChunkMetadata>;
  policy: ApprovalPolicy;
  sinks: Sink[];
  logger: Logger;
  batchDir: string;
  batchId: string;
}

/** Emitted through `config.writer` (LangGraph `custom` stream mode). */
export type ProgressEvent =
  | { type: "node_start"; node: string; documentId?: string }
  | { type: "node_end"; node: string; documentId?: string; ms: number }
  | { type: "info"; message: string; documentId?: string }
  | { type: "warn"; message: string; documentId?: string }
  | { type: "decision"; documentId: string; decision: string; reason: string }
  | { type: "review_request"; documentId: string; remaining: number }
  | { type: "delivery"; sink: string; ok: boolean; detail: string }
  // A logger line emitted inside a node, carried on the stream so it stays ordered with the tokens.
  | { type: "log"; level: "debug" | "info" | "warn" | "error" | "raw"; line: string };

/** Payload of the human-review `interrupt()`. */
export interface ReviewRequest {
  documentId: string;
  invoiceNumber: string | null;
  vendorName: string | null;
  total: number | null;
  currency: string | null;
  risk: RiskAssessment;
  issues: ValidationIssue[];
  investigation: Investigation | null;
  policyExcerpts: string[];
  /** How many more invoices wait in the queue after this one. */
  remaining: number;
  /** Set when the previous resume payload was invalid; explains what the reviewer must fix. */
  error?: string;
}

export type Reviewer = (request: ReviewRequest) => Promise<ReviewAction>;
