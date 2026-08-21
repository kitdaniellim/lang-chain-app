import type { BatchResult, Decision, ProcessedInvoice } from "../domain/schemas.js";
import { batchAmount, currencyLabel, formatDuration, money, needsAttention } from "./format.js";

/** Escapes every user/LLM-derived string; the report is emailed, so no raw markup may survive. */
function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const DECISION_STYLE: Record<Decision, string> = {
  auto_approved: "background:#e6f4ea;color:#137333",
  approved_by_human: "background:#e6f4ea;color:#137333",
  rejected_by_human: "background:#fce8e6;color:#c5221f",
  auto_rejected: "background:#fce8e6;color:#c5221f",
  needs_review: "background:#fef7e0;color:#8a5a00",
};

const RISK_COLOR: Record<string, string> = { low: "#137333", medium: "#8a5a00", high: "#c5221f" };

const TABLE = 'style="border-collapse:collapse;width:100%;font-size:13px"';
const TH = 'style="text-align:left;padding:6px 8px;border-bottom:2px solid #d0d7de;background:#f6f8fa"';
const TD = 'style="padding:6px 8px;border-bottom:1px solid #e6e8eb;vertical-align:top"';

function riskColor(level: string): string {
  return RISK_COLOR[level] ?? "#57606a";
}

/** Email-safe HTML report: inline styles only, no scripts, no external assets. */
export function renderHtmlReport(result: BatchResult): string {
  const { stats } = result;
  const label = currencyLabel(result.processed);

  const statCells = [
    ["Invoices", String(stats.total)],
    ["Auto-approved", String(stats.autoApproved)],
    ["Approved by human", String(stats.approvedByHuman)],
    ["Rejected by human", String(stats.rejectedByHuman)],
    ["Auto-rejected", String(stats.autoRejected)],
    ["Needs review", String(stats.needsReview)],
    ["Approved amount", batchAmount(stats.approvedAmount, label)],
    ["Total amount", batchAmount(stats.totalAmount, label)],
  ]
    .map(
      ([title, value]) =>
        `<td ${TD}><div style="font-size:11px;color:#57606a;text-transform:uppercase">${esc(title)}</div>` +
        `<div style="font-size:18px;font-weight:600">${esc(value)}</div></td>`,
    )
    .join("");

  const rows = result.processed
    .map((p, index) => {
      const issues = p.issues.map((i) => i.code).join(", ");
      return (
        "<tr>" +
        `<td ${TD}>${index + 1}</td>` +
        `<td ${TD}>${esc(p.invoiceNumber ?? p.documentId)}</td>` +
        `<td ${TD}>${esc(p.extracted?.vendorName ?? "")}</td>` +
        `<td ${TD} align="right">${esc(money(p.extracted?.total, p.extracted?.currency))}</td>` +
        `<td ${TD}>${esc(p.categorization?.category ?? "")}</td>` +
        `<td ${TD}><span style="color:${riskColor(p.risk.level)}">${esc(p.risk.level)} (${esc(p.risk.score)})</span></td>` +
        `<td ${TD}><span style="${DECISION_STYLE[p.decision]};padding:2px 6px;border-radius:3px">${esc(p.decision)}</span></td>` +
        `<td ${TD}>${esc(issues)}</td>` +
        "</tr>"
      );
    })
    .join("");

  const flagged = result.processed.filter(needsAttention);
  const flaggedHtml = flagged.length
    ? flagged.map(renderBrief).join("")
    : '<p style="color:#57606a">No invoices were flagged.</p>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice batch ${esc(result.batchId)}</title></head>
<body style="margin:0;padding:20px;background:#ffffff;color:#1f2328;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<div style="max-width:860px;margin:0 auto">
<h1 style="margin:0 0 4px;font-size:20px">Invoice batch ${esc(result.batchId)}</h1>
<p style="margin:0 0 16px;color:#57606a;font-size:12px">Provider ${esc(result.provider)} &middot; thread ${esc(result.threadId)} &middot; ${esc(result.startedAt)} &rarr; ${esc(result.finishedAt)} (${esc(formatDuration(result.startedAt, result.finishedAt))})</p>
<table ${TABLE}><tr>${statCells}</tr></table>
<h2 style="margin:20px 0 6px;font-size:15px">Invoices</h2>
<table ${TABLE}><thead><tr><th ${TH}>#</th><th ${TH}>Invoice</th><th ${TH}>Vendor</th><th ${TH} align="right">Total</th><th ${TH}>Category</th><th ${TH}>Risk</th><th ${TH}>Decision</th><th ${TH}>Issues</th></tr></thead><tbody>${rows}</tbody></table>
<h2 style="margin:20px 0 6px;font-size:15px">Summary</h2>
<p style="margin:0 0 16px;line-height:1.5">${esc(result.summary)}</p>
<h2 style="margin:20px 0 6px;font-size:15px">Flagged invoices (${flagged.length})</h2>
${flaggedHtml}
</div></body></html>`;
}

/** One card per flagged invoice: issue list, investigation brief, reviewer note. */
function renderBrief(p: ProcessedInvoice): string {
  const issues = p.issues
    .map((i) => `<li><strong>${esc(i.code)}</strong> (${esc(i.severity)}) &mdash; ${esc(i.message)}</li>`)
    .join("");
  const reasons = p.risk.reasons.length
    ? `<p style="margin:6px 0;color:#57606a;font-size:12px">Risk: ${esc(p.risk.reasons.join("; "))}</p>`
    : "";
  const investigation = p.investigation
    ? `<p style="margin:6px 0"><em>Investigation (${esc(p.investigation.recommendation)}):</em> ${esc(p.investigation.brief)}</p>`
    : "";
  const note = p.reviewerNote ? `<p style="margin:6px 0"><em>Reviewer note:</em> ${esc(p.reviewerNote)}</p>` : "";
  return (
    `<div style="border:1px solid #e6e8eb;border-left:4px solid ${riskColor(p.risk.level)};padding:10px 12px;margin:0 0 10px">` +
    `<div style="font-weight:600">${esc(p.invoiceNumber ?? p.documentId)} &mdash; ${esc(p.extracted?.vendorName ?? "unknown vendor")} ` +
    `<span style="${DECISION_STYLE[p.decision]};padding:1px 5px;border-radius:3px;font-weight:400">${esc(p.decision)}</span></div>` +
    `<ul style="margin:6px 0 0;padding-left:18px">${issues}</ul>${reasons}${investigation}${note}` +
    "</div>"
  );
}
