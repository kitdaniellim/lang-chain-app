import Table from "cli-table3";
import pc from "picocolors";
import type { BatchResult, Decision, DeliveryReceipt } from "../domain/schemas.js";
import { currencyLabel, formatAmount, money } from "../report/format.js";
import type { Sink, SinkContext } from "./types.js";
import { receipt } from "./types.js";

const MAX_CELL = 24;

/** Keeps the table one line per invoice on an 80-column terminal. */
function trunc(text: string): string {
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
}

function paintDecision(decision: Decision): string {
  if (decision === "auto_approved" || decision === "approved_by_human") return pc.green(decision);
  if (decision === "auto_rejected" || decision === "rejected_by_human") return pc.red(decision);
  return pc.yellow(decision);
}

function paintRisk(level: string, score: number): string {
  const label = `${level} ${score}`;
  if (level === "high") return pc.red(label);
  if (level === "medium") return pc.yellow(label);
  return pc.dim(label);
}

/** Prints the batch as a terminal table plus a stats line and the LLM summary. */
export class ConsoleSink implements Sink {
  readonly name = "console";

  async deliver(result: BatchResult, ctx: SinkContext): Promise<DeliveryReceipt> {
    try {
      return this.print(result, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error(`console sink failed: ${message}`);
      return receipt(this.name, false, message);
    }
  }

  private print(result: BatchResult, ctx: SinkContext): DeliveryReceipt {
    const table = new Table({
      head: ["#", "Invoice", "Vendor", "Total", "Category", "Risk", "Decision", "Issues"].map((h) => pc.bold(h)),
      style: { head: [], border: [] },
    });

    result.processed.forEach((p, index) => {
      table.push([
        String(index + 1),
        trunc(p.invoiceNumber ?? p.documentId),
        trunc(p.extracted?.vendorName ?? "—"),
        money(p.extracted?.total, p.extracted?.currency),
        trunc(p.categorization?.category ?? "—"),
        paintRisk(p.risk.level, p.risk.score),
        paintDecision(p.decision),
        trunc(p.issues.map((i) => i.code).join(", ") || "—"),
      ]);
    });

    const s = result.stats;
    const label = currencyLabel(result.processed);
    ctx.logger.raw(pc.bold(`\nBatch ${result.batchId} — ${s.total} invoice(s), provider ${result.provider}`));
    ctx.logger.raw(table.toString());
    ctx.logger.raw(
      [
        `${pc.green(`Auto-approved ${s.autoApproved}`)}`,
        `Approved by human ${s.approvedByHuman}`,
        `${pc.red(`Auto-rejected ${s.autoRejected}`)}`,
        `Rejected by human ${s.rejectedByHuman}`,
        `${pc.yellow(`Needs review ${s.needsReview}`)}`,
        `Approved ${label.prefix}${formatAmount(s.approvedAmount)} of ${label.prefix}${formatAmount(s.totalAmount)}${label.note}`,
      ].join(pc.dim(" · ")),
    );
    ctx.logger.raw(`\n${pc.bold("Summary")}\n${result.summary}\n`);

    return receipt(this.name, true, `printed ${result.processed.length} invoice(s)`);
  }
}
