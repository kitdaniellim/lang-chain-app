import { END, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { buildInvestigator, type Investigator } from "../agents/investigator.js";
import { buildCategorizeChain } from "../chains/categorize.js";
import { buildExtractChain } from "../chains/extract.js";
import type { Decision, IssueCode, RiskAssessment, ValidationIssue } from "../domain/schemas.js";
import { findVendor } from "../domain/vendors.js";
import { isRetryableError } from "../llm/errors.js";
import { resilient } from "../llm/factory.js";
import { PipelineContextSchema } from "../pipeline/context.js";
import type { PipelineContext } from "../pipeline/types.js";
import { checkDates, checkLedgerDuplicates, checkPolicy, checkTotals, checkVendor } from "../tools/checks.js";
import { emitProgress, timed } from "./instrument.js";
import { InvoiceState, type InvoiceStateType, type InvoiceUpdate } from "./state.js";

/** Risk weights. Errors block payment; warnings only raise the score. */
const ERROR_WEIGHT = 35;
const WARNING_WEIGHT = 12;
const UNKNOWN_VENDOR_BONUS = 20;
const THRESHOLD_BONUS = 25;
const MAX_SCORE = 100;
const MEDIUM_FROM = 25;
const HIGH_FROM = 60;

/** Handbook passages attached to a flagged invoice for the human reviewer. */
const POLICY_EXCERPT_LIMIT = 2;

const THRESHOLD_CODES = new Set<IssueCode>(["OVER_REVIEW_THRESHOLD", "OVER_CFO_THRESHOLD"]);

/** Two warnings on one invoice are never "low risk", whatever the individual weights add up to. */
const WARNINGS_FOR_MEDIUM = 2;

/**
 * Issues the handbook says a human must see, whatever their severity or score.
 * The reason text names the rule so the reviewer sees why the invoice was held.
 */
const REVIEW_RULES: Partial<Record<IssueCode, string>> = {
  DUPLICATE_IN_LEDGER: "Policy (Duplicates): an invoice matching the payment ledger must be reviewed before payment",
  MISSING_PO: "Policy (Purchase orders): an invoice over the PO threshold without a PO must be held for review",
  OVER_REVIEW_THRESHOLD: "Policy (Approval thresholds): invoices at or above the review threshold require manager review",
  OVER_CFO_THRESHOLD: "Policy (Approval thresholds): invoices at or above the CFO threshold must be escalated for sign-off",
  UNKNOWN_VENDOR: "Policy (Vendors): invoices from vendors outside the approved registry always require human review",
};

export const REVIEW_CODES: readonly IssueCode[] = Object.keys(REVIEW_RULES) as IssueCode[];

/** The review-gated codes actually present, de-duplicated and in REVIEW_CODES order. */
function reviewCodesIn(issues: ValidationIssue[]): IssueCode[] {
  const present = new Set(issues.map((i) => i.code));
  return REVIEW_CODES.filter((code) => present.has(code));
}

/**
 * `createAgent` compiles a graph, so build one per context rather than one per invoice.
 * Keyed on the context itself because the agent closes over its models and logger too.
 */
const investigators = new WeakMap<PipelineContext, Investigator>();

function investigatorFor(ctx: PipelineContext): Investigator {
  const existing = investigators.get(ctx);
  if (existing) return existing;
  const built = buildInvestigator(ctx.models, ctx.tools, ctx.logger);
  investigators.set(ctx, built);
  return built;
}

/**
 * Deterministic risk score from the issues found so far. A review-gated policy code, or
 * two warnings of any kind, floors the score at `MEDIUM_FROM` so the level can never
 * read "low" for something the handbook says a human must see.
 */
export function scoreRisk(issues: ValidationIssue[]): RiskAssessment {
  let score = issues.reduce((sum, i) => sum + (i.severity === "error" ? ERROR_WEIGHT : WARNING_WEIGHT), 0);
  if (issues.some((i) => i.code === "UNKNOWN_VENDOR")) score += UNKNOWN_VENDOR_BONUS;
  if (issues.some((i) => THRESHOLD_CODES.has(i.code))) score += THRESHOLD_BONUS;

  const gated = reviewCodesIn(issues);
  const warnings = issues.filter((i) => i.severity === "warning").length;
  if (gated.length > 0 || warnings >= WARNINGS_FOR_MEDIUM) score = Math.max(score, MEDIUM_FROM);

  score = Math.min(MAX_SCORE, score);
  const level = score < MEDIUM_FROM ? "low" : score < HIGH_FROM ? "medium" : "high";
  const reasons = [...issues.map((i) => i.message), ...gated.map((code) => REVIEW_RULES[code]!)];
  return { score, level, reasons };
}

/**
 * Only an error-severity ledger duplicate (same number *and* same vendor) blocks payment.
 * Every `REVIEW_CODES` issue goes to a human whatever the score says, so a near-duplicate
 * or a missing PO can never slip through auto-approval; anything else follows the risk level.
 */
export function routeAfterRisk(state: InvoiceStateType): "auto_reject" | "investigate" | "auto_approve" {
  if (state.extracted === null) return "auto_reject";
  if (state.issues.some((i) => i.code === "DUPLICATE_IN_LEDGER" && i.severity === "error")) return "auto_reject";
  if (reviewCodesIn(state.issues).length > 0) return "investigate";
  return (state.risk?.level ?? "high") === "low" ? "auto_approve" : "investigate";
}

type Config = LangGraphRunnableConfig<PipelineContext>;

/** Document -> structured extraction. A total failure is a typed issue, never a throw. */
async function extractNode(state: InvoiceStateType, config: Config): Promise<InvoiceUpdate> {
  const ctx = config.context!;
  return timed("extract", state.document.id, config, async (): Promise<InvoiceUpdate> => {
    try {
      const tagged = await resilient(ctx.models, buildExtractChain, { runName: "extract" }).invoke(
        { document: state.document },
        config,
      );
      return { extracted: tagged.value, provider: tagged.provider };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`extraction failed for ${state.document.id}: ${message}`);
      emitProgress(config, { type: "warn", message: `extraction failed: ${message}`, documentId: state.document.id });
      return {
        extracted: null,
        issues: [{ code: "EXTRACTION_FAILED", severity: "error", message: `Extraction failed: ${message}` }],
        decision: "auto_rejected",
      };
    }
  });
}

/** Arithmetic, dates, vendor registry and ledger duplicates — all deterministic. */
async function validateNode(state: InvoiceStateType, config: Config): Promise<InvoiceUpdate> {
  const ctx = config.context!;
  return timed("validate", state.document.id, config, (): InvoiceUpdate => {
    const extracted = state.extracted;
    if (extracted === null) return {};
    return {
      issues: [
        ...checkTotals(extracted),
        ...checkDates(extracted),
        ...checkVendor(extracted).issues,
        ...checkLedgerDuplicates(extracted, ctx.ledger, ctx.batchId, ctx.policy),
      ],
    };
  });
}

/** Extraction -> expense category, seeded with the registry's default category for the vendor. */
async function categorizeNode(state: InvoiceStateType, config: Config): Promise<InvoiceUpdate> {
  const ctx = config.context!;
  return timed("categorize", state.document.id, config, async (): Promise<InvoiceUpdate> => {
    const extracted = state.extracted;
    if (extracted === null) return {};
    const vendorHint = findVendor(extracted.vendorName)?.vendor.defaultCategory ?? null;
    try {
      const tagged = await resilient(ctx.models, buildCategorizeChain, { runName: "categorize" }).invoke(
        { extracted, vendorHint },
        config,
      );
      return { categorization: tagged.value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`categorization failed for ${state.document.id}: ${message}`);
      return {
        categorization: null,
        issues: [
          { code: "MISSING_FIELD", severity: "warning", message: `category unavailable: ${message}`, field: "category" },
        ],
      };
    }
  });
}

/** Applies the approval policy, scores the risk and pulls the matching handbook passages. */
async function assessRiskNode(state: InvoiceStateType, config: Config): Promise<InvoiceUpdate> {
  const ctx = config.context!;
  return timed("assess_risk", state.document.id, config, async (): Promise<InvoiceUpdate> => {
    const extracted = state.extracted;
    if (extracted === null) return {};
    const policyIssues = checkPolicy(extracted, state.categorization?.category ?? null, ctx.policy);
    const issues = [...state.issues, ...policyIssues];
    return {
      issues: policyIssues,
      risk: scoreRisk(issues),
      policyExcerpts: await lookupPolicyExcerpts(ctx, issues),
    };
  });
}

/** Top handbook passages for the issue codes raised; zero-score padding is dropped. */
export async function lookupPolicyExcerpts(ctx: PipelineContext, issues: ValidationIssue[]): Promise<string[]> {
  const codes = [...new Set(issues.map((i) => i.code))];
  if (codes.length === 0) return [];
  const docs = await ctx.retriever.invoke(codes.join(" "));
  return docs
    .filter((doc) => doc.metadata.score > 0)
    .slice(0, POLICY_EXCERPT_LIMIT)
    .map((doc) => doc.pageContent);
}

/** Tool-calling agent that explains the flagged issues to the reviewer. */
async function investigateNode(state: InvoiceStateType, config: Config): Promise<InvoiceUpdate> {
  const ctx = config.context!;
  return timed("investigate", state.document.id, config, async (): Promise<InvoiceUpdate> => {
    if (state.extracted === null || state.risk === null) return {};
    const investigation = await investigatorFor(ctx).investigate(state.extracted, state.issues, state.risk, config);
    return { investigation };
  });
}

/** Why the invoice ended where it did, for the progress stream. */
function decisionReason(state: InvoiceStateType, decision: Decision): string {
  if (decision === "auto_approved") return "no blocking issues";
  const blocking = state.issues.find((i) => i.severity === "error") ?? state.issues[0];
  if (blocking) return blocking.message;
  return `risk score ${state.risk?.score ?? MAX_SCORE}`;
}

/** Terminal node factory: stamps the decision and announces it on the progress stream. */
function decisionNode(node: string, decision: Decision) {
  return async (state: InvoiceStateType, config: Config): Promise<InvoiceUpdate> =>
    timed(node, state.document.id, config, (): InvoiceUpdate => {
      emitProgress(config, {
        type: "decision",
        documentId: state.document.id,
        decision,
        reason: decisionReason(state, decision),
      });
      return { decision };
    });
}

/**
 * Per-invoice subgraph: extract, then validate and categorise in parallel, then score
 * the risk and route to auto-approval, auto-rejection or an investigated human review.
 */
export function buildInvoiceGraph() {
  return new StateGraph(InvoiceState, PipelineContextSchema)
    .addNode("extract", extractNode, {
      // Declared to demonstrate LangGraph node retry policies; unreachable in practice because
      // resilient() retries inside the node and the catch converts failures to EXTRACTION_FAILED.
      retryPolicy: { maxAttempts: 3, retryOn: isRetryableError, logWarning: false },
    })
    .addNode("validate", validateNode)
    .addNode("categorize", categorizeNode)
    .addNode("assess_risk", assessRiskNode)
    .addNode("investigate", investigateNode)
    .addNode("flag_for_review", decisionNode("flag_for_review", "needs_review"))
    .addNode("auto_approve", decisionNode("auto_approve", "auto_approved"))
    .addNode("auto_reject", decisionNode("auto_reject", "auto_rejected"))
    .addEdge(START, "extract")
    .addEdge("extract", "validate")
    .addEdge("extract", "categorize")
    .addEdge("validate", "assess_risk")
    .addEdge("categorize", "assess_risk")
    .addConditionalEdges("assess_risk", routeAfterRisk, ["investigate", "auto_approve", "auto_reject"])
    .addEdge("investigate", "flag_for_review")
    .addEdge("flag_for_review", END)
    .addEdge("auto_approve", END)
    .addEdge("auto_reject", END)
    .compile();
}
