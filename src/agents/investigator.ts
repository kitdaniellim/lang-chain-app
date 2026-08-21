import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ClientTool } from "@langchain/core/tools";
import { createAgent, modelRetryMiddleware, toolCallLimitMiddleware, toolStrategy } from "langchain";
import { PROMPT_MARKERS, SYSTEM_MARKERS, TOOL_NAMES } from "../domain/constants.js";
import {
  InvestigationSchema,
  type ExtractedInvoice,
  type Investigation,
  type RiskAssessment,
  type ValidationIssue,
} from "../domain/schemas.js";
import { isRetryableError } from "../llm/errors.js";
import type { ModelBundle } from "../llm/types.js";
import type { Logger } from "../observability/logger.js";
import type { ToolKit } from "../pipeline/types.js";

/** Tool calls one investigation may make before the agent is forced to conclude. */
const TOOL_CALL_LIMIT = 8;

/** The structured-response tool is named from the schema title, so traces show `investigation_report`. */
const InvestigationReportSchema = InvestigationSchema.meta({
  title: TOOL_NAMES.investigationReport,
  description: "Findings brief and recommendation for the human reviewer.",
});

export const INVESTIGATOR_SYSTEM = `${SYSTEM_MARKERS.investigate}
A deterministic validator has already flagged the invoice below; your job is to explain what is actually wrong and what the reviewer should do.
Rules:
- Verify every claim with a tool. Recompute the arithmetic, resolve the vendor against the registry, search the ledger for duplicates and quote the approval handbook.
- Never approve on missing evidence. If a check could not be run, say so and escalate.
- Finish by calling ${TOOL_NAMES.investigationReport} with a 2-5 sentence brief, a recommendation of approve, reject or escalate, your confidence from 0 to 1, and the tools you consulted.`;

export interface Investigator {
  investigate(
    extracted: ExtractedInvoice,
    issues: ValidationIssue[],
    risk: RiskAssessment,
    config?: RunnableConfig,
  ): Promise<Investigation>;
}

/** Returned when the agent itself fails; an unexplained invoice is never an approval. */
function unavailable(reason: string): Investigation {
  return { brief: `Investigation unavailable: ${reason}`, recommendation: "escalate", confidence: 0, toolsUsed: [] };
}

/**
 * Tool-calling investigator built with `createAgent`. The model gets the raw primary
 * (createAgent binds the tools itself) plus retry and tool-call-limit middleware.
 */
export function buildInvestigator(models: ModelBundle, tools: ToolKit, logger?: Logger): Investigator {
  const agent = createAgent({
    model: models.primary,
    tools: tools.all as unknown as ClientTool[],
    systemPrompt: INVESTIGATOR_SYSTEM,
    middleware: [
      toolCallLimitMiddleware({ threadLimit: TOOL_CALL_LIMIT, exitBehavior: "end" }),
      modelRetryMiddleware({ maxRetries: models.maxRetries, retryOn: isRetryableError, onFailure: "error" }),
    ],
    responseFormat: toolStrategy(InvestigationReportSchema),
  });

  return {
    async investigate(extracted, issues, risk, config): Promise<Investigation> {
      try {
        const result = await agent.invoke({ messages: [new HumanMessage(renderBrief(extracted, issues, risk))] }, config);
        const parsed = InvestigationSchema.safeParse(result.structuredResponse);
        if (!parsed.success) {
          const detail = parsed.error.issues.map((i) => i.message).join("; ");
          logger?.warn(`investigator returned an unusable report: ${detail}`);
          return unavailable(`the report did not match the expected shape (${detail})`);
        }
        return parsed.data;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn(`investigator agent failed: ${message}`);
        return unavailable(message);
      }
    },
  };
}

/** The extraction travels inside the shared markers so the tools and the fake model can find it. */
function renderBrief(extracted: ExtractedInvoice, issues: ValidationIssue[], risk: RiskAssessment): string {
  const flagged =
    issues.length > 0
      ? issues.map((issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}`).join("\n")
      : "- none";
  return [
    `${PROMPT_MARKERS.extractedOpen}\n${JSON.stringify(extracted)}\n${PROMPT_MARKERS.extractedClose}`,
    `Risk score ${risk.score} (${risk.level}).`,
    `Flagged issues:\n${flagged}`,
    "Investigate the flagged issues with the tools, then file your report.",
  ].join("\n\n");
}
