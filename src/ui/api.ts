import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertBatchId, batchDir, listBatches, readManifest, readResult } from "../data/batch-store.js";
import { JsonLedger } from "../data/ledger.js";
import type { LedgerEntry } from "../data/ledger.types.js";
import { LEDGER_FILENAME } from "../domain/constants.js";
import type { BatchManifest, BatchResult, BatchStats } from "../domain/schemas.js";
import { evaluateBatch, type EvaluationReport } from "../evaluate/evaluate.js";
import { buildBatchGraph } from "../graph/batch.graph.js";
import { buildInvoiceGraph } from "../graph/invoice.graph.js";
import type { Logger } from "../observability/logger.js";
import { HttpError } from "./http.js";

/** One row of the batches table. `processed` is false until a run has written results. */
export interface BatchSummary {
  batchId: string;
  createdAt: string;
  documents: number;
  seed: number;
  defectRate: number;
  processed: boolean;
  provider?: string;
  stats?: BatchStats;
}

export interface BatchDetail {
  manifest: BatchManifest;
  result: BatchResult | null;
  evaluation: EvaluationReport | null;
}

const MANIFEST_FILE = "manifest.json";
const REPORT_FILE = "report.html";

/** A batch id that is not a readable batch directory is a 404, not a crash. */
function requireBatchDir(outDir: string, batchId: string): string {
  try {
    assertBatchId(batchId);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  const dir = batchDir(outDir, batchId);
  if (!existsSync(path.join(dir, MANIFEST_FILE))) throw new HttpError(404, `Batch ${batchId} not found under ${outDir}`);
  return dir;
}

/** Newest first. A batch whose manifest will not parse is logged and skipped, never fatal. */
export async function listBatchSummaries(outDir: string, logger: Logger): Promise<BatchSummary[]> {
  const ids = await listBatches(outDir);
  const summaries: BatchSummary[] = [];

  for (const batchId of ids) {
    try {
      const manifest = await readManifest(outDir, batchId);
      const result = await readResult(outDir, batchId);
      summaries.push({
        batchId,
        createdAt: manifest.createdAt,
        documents: manifest.documents.length,
        seed: manifest.seed,
        defectRate: manifest.defectRate,
        processed: result !== null,
        ...(result ? { provider: result.provider, stats: result.stats } : {}),
      });
    } catch (error) {
      logger.warn(`skipping unreadable batch ${batchId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.batchId.localeCompare(a.batchId));
}

/** Manifest plus results, scored against ground truth when both halves exist. */
export async function readBatchDetail(outDir: string, batchId: string): Promise<BatchDetail> {
  requireBatchDir(outDir, batchId);
  const manifest = await readManifest(outDir, batchId);
  const result = await readResult(outDir, batchId);
  const evaluation = result && manifest.groundTruth.length > 0 ? evaluateBatch(manifest, result) : null;
  return { manifest, result, evaluation };
}

/**
 * The document exactly as the pipeline read it. `raw/<filename>` is the source of truth;
 * a batch directory missing its raw file falls back to the manifest's copy with a warning.
 */
export async function readDocumentText(
  outDir: string,
  batchId: string,
  documentId: string,
  logger: Logger,
): Promise<string> {
  const dir = requireBatchDir(outDir, batchId);
  const manifest = await readManifest(outDir, batchId);
  const document = manifest.documents.find((doc) => doc.id === documentId);
  if (!document) throw new HttpError(404, `Batch ${batchId} has no document ${documentId}`);

  try {
    return await fs.readFile(path.join(dir, "raw", path.basename(document.filename)), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    logger.warn(`raw/${document.filename} is missing; serving the manifest's copy of ${documentId}`);
    return document.text;
  }
}

/** The HTML report the file sink saved, or a 404 when the batch has not been delivered. */
export async function readReportHtml(outDir: string, batchId: string): Promise<string> {
  const dir = requireBatchDir(outDir, batchId);
  try {
    return await fs.readFile(path.join(dir, REPORT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new HttpError(404, `Batch ${batchId} has no ${REPORT_FILE} yet — run it first`);
  }
}

export async function readLedgerRows(outDir: string): Promise<LedgerEntry[]> {
  const ledger = await JsonLedger.load(path.join(outDir, LEDGER_FILENAME));
  return ledger.rows();
}

export interface GraphDiagrams {
  invoice: string;
  batch: string;
}

let diagrams: GraphDiagrams | null = null;

/** Mermaid straight from the compiled graphs; compiled once and cached for the process. */
export async function readGraphDiagrams(): Promise<GraphDiagrams> {
  if (diagrams === null) {
    diagrams = {
      invoice: (await buildInvoiceGraph().getGraphAsync()).drawMermaid(),
      batch: (await buildBatchGraph().getGraphAsync()).drawMermaid(),
    };
  }
  return diagrams;
}
