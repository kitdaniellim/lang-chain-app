import Table from "cli-table3";
import type {
  BatchManifest,
  BatchResult,
  DefectCode,
  ExtractedInvoice,
  Invoice,
  IssueCode,
  ProcessedInvoice,
} from "../domain/schemas.js";

export interface FieldScore {
  correct: number;
  total: number;
  accuracy: number;
}

export interface DefectScore {
  code: string;
  injected: number;
  caught: number;
  recall: number;
}

export interface DocumentEvaluation {
  documentId: string;
  defects: string[];
  caughtIssues: string[];
  decision: string;
}

export interface EvaluationReport {
  fields: Record<string, FieldScore>;
  overallFieldAccuracy: number;
  defects: DefectScore[];
  overallDefectRecall: number;
  perDocument: DocumentEvaluation[];
}

/** Which pipeline issue codes count as having caught each injected defect. */
export const DEFECT_ISSUE_MAP: Record<DefectCode, IssueCode[]> = {
  MATH_MISMATCH: ["TOTAL_MISMATCH"],
  LINE_SUM_MISMATCH: ["LINE_SUM_MISMATCH"],
  DUE_BEFORE_ISSUE: ["DUE_BEFORE_ISSUE"],
  MISSING_DUE_DATE: ["MISSING_DUE_DATE"],
  DUPLICATE_NUMBER: ["DUPLICATE_IN_BATCH", "DUPLICATE_IN_LEDGER"],
  UNKNOWN_VENDOR: ["UNKNOWN_VENDOR"],
  OVER_THRESHOLD: ["OVER_REVIEW_THRESHOLD", "OVER_CFO_THRESHOLD"],
  MISSING_PO: ["MISSING_PO"],
  FOREIGN_CURRENCY: ["FOREIGN_CURRENCY"],
};

const MONEY_EPSILON = 0.01;

/** Field name -> the ground-truth value and the extracted value to compare. */
const FIELD_READERS: Record<
  string,
  { truth: (i: Invoice) => unknown; extracted: (e: ExtractedInvoice) => unknown }
> = {
  invoiceNumber: { truth: (i) => i.invoiceNumber, extracted: (e) => e.invoiceNumber },
  vendorName: { truth: (i) => i.vendor.name, extracted: (e) => e.vendorName },
  vendorEmail: { truth: (i) => i.vendor.email, extracted: (e) => e.vendorEmail },
  issueDate: { truth: (i) => i.issueDate, extracted: (e) => e.issueDate },
  dueDate: { truth: (i) => i.dueDate, extracted: (e) => e.dueDate },
  currency: { truth: (i) => i.currency, extracted: (e) => e.currency },
  subtotal: { truth: (i) => i.subtotal, extracted: (e) => e.subtotal },
  taxAmount: { truth: (i) => i.taxAmount, extracted: (e) => e.taxAmount },
  total: { truth: (i) => i.total, extracted: (e) => e.total },
  poNumber: { truth: (i) => i.poNumber, extracted: (e) => e.poNumber },
  lineItems: { truth: (i) => i.lineItems.length, extracted: (e) => e.lineItems.length },
};

/** Strings compare trimmed + lower-cased, numbers within a cent, null only matches null. */
function matches(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;
  if (typeof expected === "number" && typeof actual === "number") {
    return Math.abs(expected - actual) <= MONEY_EPSILON;
  }
  return String(expected).trim().toLowerCase() === String(actual).trim().toLowerCase();
}

/** Vacuously perfect when there was nothing to get right; the counts are always rendered alongside. */
function ratio(correct: number, total: number): number {
  return total === 0 ? 1 : correct / total;
}

/** Scores the processed batch against the generator's ground truth. */
export function evaluateBatch(manifest: BatchManifest, result: Pick<BatchResult, "processed">): EvaluationReport {
  const processedById = new Map<string, ProcessedInvoice>(result.processed.map((p) => [p.documentId, p]));

  const fields: Record<string, FieldScore> = {};
  for (const name of Object.keys(FIELD_READERS)) fields[name] = { correct: 0, total: 0, accuracy: 0 };

  const defectTally = new Map<string, { injected: number; caught: number }>();
  const perDocument: DocumentEvaluation[] = [];

  for (const invoice of manifest.groundTruth) {
    const processed = processedById.get(invoice.id);
    const extracted = processed?.extracted ?? null;

    for (const [name, reader] of Object.entries(FIELD_READERS)) {
      const score = fields[name]!;
      score.total += 1;
      if (extracted && matches(reader.truth(invoice), reader.extracted(extracted))) score.correct += 1;
    }

    const raisedCodes = processed?.issues.map((i) => i.code) ?? [];
    for (const defect of invoice.defects) {
      const tally = defectTally.get(defect) ?? { injected: 0, caught: 0 };
      tally.injected += 1;
      if (DEFECT_ISSUE_MAP[defect].some((code) => raisedCodes.includes(code))) tally.caught += 1;
      defectTally.set(defect, tally);
    }

    perDocument.push({
      documentId: invoice.id,
      defects: [...invoice.defects],
      caughtIssues: raisedCodes,
      decision: processed?.decision ?? "missing",
    });
  }

  let correct = 0;
  let total = 0;
  for (const score of Object.values(fields)) {
    score.accuracy = ratio(score.correct, score.total);
    correct += score.correct;
    total += score.total;
  }

  const defects: DefectScore[] = [...defectTally.entries()].map(([code, tally]) => ({
    code,
    injected: tally.injected,
    caught: tally.caught,
    recall: ratio(tally.caught, tally.injected),
  }));
  const injected = defects.reduce((sum, d) => sum + d.injected, 0);
  const caught = defects.reduce((sum, d) => sum + d.caught, 0);

  return {
    fields,
    overallFieldAccuracy: ratio(correct, total),
    defects,
    overallDefectRecall: ratio(caught, injected),
    perDocument,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Two tables (fields, defects) plus the two headline numbers. */
export function renderEvaluation(report: EvaluationReport): string {
  const fieldTable = new Table({
    head: ["Field", "Correct", "Total", "Accuracy"],
    style: { head: [], border: [] },
    colAligns: ["left", "right", "right", "right"],
  });
  for (const [name, score] of Object.entries(report.fields)) {
    fieldTable.push([name, String(score.correct), String(score.total), pct(score.accuracy)]);
  }

  const defectTable = new Table({
    head: ["Defect", "Injected", "Caught", "Recall"],
    style: { head: [], border: [] },
    colAligns: ["left", "right", "right", "right"],
  });
  if (report.defects.length === 0) {
    defectTable.push(["(none injected)", "0", "0", "—"]);
  }
  for (const defect of report.defects) {
    defectTable.push([defect.code, String(defect.injected), String(defect.caught), pct(defect.recall)]);
  }

  const missed = report.perDocument.filter((d) =>
    d.defects.some((code) => !DEFECT_ISSUE_MAP[code as DefectCode]?.some((issue) => d.caughtIssues.includes(issue))),
  );
  const missedLine = missed.length
    ? `Documents with a missed defect: ${missed.map((d) => d.documentId).join(", ")}`
    : "No injected defect was missed.";

  return [
    "Extraction fields",
    fieldTable.toString(),
    "",
    "Injected defects",
    defectTable.toString(),
    "",
    `Field accuracy: ${pct(report.overallFieldAccuracy)}`,
    `Defect recall: ${pct(report.overallDefectRecall)}`,
    missedLine,
  ].join("\n");
}
