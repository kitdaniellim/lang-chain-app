import type { BatchResult } from "../domain/schemas.js";
import { currencyLabel, formatAmount, formatDuration, money, needsAttention } from "./format.js";

/** Pipes and newlines would break the table, so neutralise them inside cells. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Markdown twin of the HTML report, written to `report.md`. */
export function renderMarkdownReport(result: BatchResult): string {
  const { stats } = result;
  const label = currencyLabel(result.processed);
  const lines: string[] = [];

  lines.push(`# Invoice batch ${result.batchId}`, "");
  lines.push(
    `Provider \`${result.provider}\` · thread \`${result.threadId}\` · ${result.startedAt} → ${result.finishedAt} (${formatDuration(result.startedAt, result.finishedAt)})`,
    "",
  );

  lines.push("## Stats", "");
  lines.push(`- Invoices: **${stats.total}**`);
  lines.push(`- Auto-approved: **${stats.autoApproved}** · Approved by human: **${stats.approvedByHuman}**`);
  lines.push(`- Auto-rejected: **${stats.autoRejected}** · Rejected by human: **${stats.rejectedByHuman}**`);
  lines.push(`- Needs review: **${stats.needsReview}**`);
  lines.push(
    `- Approved amount: **${label.prefix}${formatAmount(stats.approvedAmount)}** ` +
      `of **${label.prefix}${formatAmount(stats.totalAmount)}**${label.note}`,
  );
  const categories = Object.entries(stats.byCategory);
  if (categories.length > 0) lines.push(`- Categories: ${categories.map(([k, v]) => `${k} (${v})`).join(", ")}`);
  const issueCounts = Object.entries(stats.issuesByCode);
  if (issueCounts.length > 0) lines.push(`- Issues: ${issueCounts.map(([k, v]) => `${k} (${v})`).join(", ")}`);
  lines.push("");

  lines.push("## Invoices", "");
  lines.push("| Document | Invoice | Vendor | Total | Category | Risk | Decision | Issues |");
  lines.push("| --- | --- | --- | ---: | --- | --- | --- | --- |");
  for (const p of result.processed) {
    lines.push(
      `| ${cell(p.documentId)} | ${cell(p.invoiceNumber ?? "")} | ${cell(p.extracted?.vendorName ?? "")} ` +
        `| ${cell(money(p.extracted?.total, p.extracted?.currency))} | ${cell(p.categorization?.category ?? "")} ` +
        `| ${cell(`${p.risk.level} (${p.risk.score})`)} | ${cell(p.decision)} | ${cell(p.issues.map((i) => i.code).join(", "))} |`,
    );
  }
  lines.push("");

  lines.push("## Summary", "", result.summary, "");

  const flagged = result.processed.filter(needsAttention);
  lines.push(`## Flagged invoices (${flagged.length})`, "");
  if (flagged.length === 0) lines.push("No invoices were flagged.", "");
  for (const p of flagged) {
    lines.push(
      `### ${p.invoiceNumber ?? p.documentId} — ${p.extracted?.vendorName ?? "unknown vendor"} (${p.decision})`,
      "",
    );
    for (const issue of p.issues) lines.push(`- **${issue.code}** (${issue.severity}) — ${issue.message}`);
    if (p.investigation) lines.push("", `_Investigation (${p.investigation.recommendation}):_ ${p.investigation.brief}`);
    if (p.reviewerNote) lines.push("", `_Reviewer note:_ ${p.reviewerNote}`);
    lines.push("");
  }

  if (result.deliveries.length > 0) {
    lines.push("## Deliveries", "");
    for (const d of result.deliveries) lines.push(`- ${d.ok ? "ok" : "FAILED"} **${d.sink}** — ${d.detail}`);
    lines.push("");
  }

  return lines.join("\n");
}
