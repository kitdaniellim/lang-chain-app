import readline from "node:readline/promises";
import pc from "picocolors";
import type { ReviewAction } from "../domain/schemas.js";
import type { Logger } from "../observability/logger.js";
import { autoReviewer } from "../pipeline/run-batch.js";
import type { ReviewMode, ReviewRequest, Reviewer } from "../pipeline/types.js";
import { money } from "../report/format.js";

export { autoReviewer };

/** A reviewer that may hold an open stdin handle. `close()` is a no-op for the automatic ones. */
export type ClosableReviewer = Reviewer & { close(): void };

const PROMPT = `${pc.bold("decision")} [approve|reject] (optional note after a space) > `;

/** Everything the human needs to judge one invoice, in the order they need it. */
export function renderReviewRequest(request: ReviewRequest): string {
  const lines = [
    pc.bold(`\n── review ${request.documentId} — ${request.remaining} more in the queue ──`),
    // The graph re-asks after an unusable answer; say why rather than repeating the prompt silently.
    ...(request.error ? [pc.yellow(`⚠ Previous answer rejected: ${request.error}`)] : []),
    `invoice   ${request.invoiceNumber ?? pc.dim("(none)")}`,
    `vendor    ${request.vendorName ?? pc.dim("(none)")}`,
    `total     ${money(request.total, request.currency)}`,
    `risk      ${paintRisk(request.risk.level)} ${request.risk.score}`,
  ];

  for (const reason of request.risk.reasons) lines.push(`  ${pc.yellow("•")} ${reason}`);

  if (request.investigation) {
    const inv = request.investigation;
    lines.push(
      `${pc.bold("investigator")} recommends ${paintRecommendation(inv.recommendation)} (confidence ${inv.confidence.toFixed(2)})`,
      `  ${inv.brief}`,
    );
    if (inv.toolsUsed.length > 0) lines.push(pc.dim(`  tools: ${inv.toolsUsed.join(", ")}`));
  }

  for (const excerpt of request.policyExcerpts) lines.push(pc.dim(`  policy: ${excerpt}`));
  return lines.join("\n");
}

function paintRisk(level: string): string {
  if (level === "high") return pc.red(level);
  return level === "medium" ? pc.yellow(level) : pc.green(level);
}

function paintRecommendation(recommendation: string): string {
  if (recommendation === "approve") return pc.green(recommendation);
  return recommendation === "reject" ? pc.red(recommendation) : pc.yellow(recommendation);
}

/** `approve`/`reject`, optionally followed by a free-text note. Anything else is null. */
export function parseReviewAnswer(answer: string): ReviewAction | null {
  const [word = "", ...rest] = answer.trim().split(/\s+/);
  const action = word.toLowerCase();
  if (action !== "approve" && action !== "reject") return null;
  return { action, note: rest.join(" ") };
}

/** Prompts on stdin for every paused invoice and re-prompts until the answer parses. */
const ABORTED_MESSAGE =
  "Review aborted by user (Ctrl-C); the interrupt stays pending — resume with " +
  "`resume <threadId> --checkpointer sqlite` (if sqlite was used)";
const STDIN_CLOSED_MESSAGE = "stdin closed before a review decision was given";

export function interactiveReviewer(logger: Logger): ClosableReviewer {
  let rl: readline.Interface | null = null;
  let aborted: Promise<never> | null = null;

  const open = (): readline.Interface => {
    if (rl !== null) return rl;
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl-C or a closed stdin must reject the pending question, never hang the run.
    // Whichever fires first wins; a settled promise ignores the other.
    aborted = new Promise<never>((_, reject) => {
      input.once("SIGINT", () => {
        reject(new Error(ABORTED_MESSAGE));
        input.close();
      });
      input.once("close", () => reject(new Error(STDIN_CLOSED_MESSAGE)));
    });
    aborted.catch(() => {});
    rl = input;
    return input;
  };

  const reviewer = async (request: ReviewRequest): Promise<ReviewAction> => {
    const input = open();
    logger.raw(renderReviewRequest(request));
    for (;;) {
      const answer = await Promise.race([input.question(PROMPT), aborted!]);
      const parsed = parseReviewAnswer(answer);
      if (parsed !== null) return parsed;
      logger.raw(pc.yellow(`  "${answer.trim()}" is not a decision — type "approve" or "reject wrong PO number".`));
    }
  };

  return Object.assign(reviewer, {
    close: (): void => {
      rl?.close();
      rl = null;
      aborted = null;
    },
  });
}

/** `interactive` prompts; `approve`/`reject` answer every pause the same way. */
export function resolveReviewer(mode: ReviewMode, logger: Logger): ClosableReviewer {
  if (mode === "interactive") return interactiveReviewer(logger);
  return Object.assign(autoReviewer(mode), { close: (): void => {} });
}

/** Prompting is only possible on a terminal; a piped/CI run approves instead of hanging. */
export function defaultReviewMode(): ReviewMode {
  return process.stdin.isTTY ? "interactive" : "approve";
}
