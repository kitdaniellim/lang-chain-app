import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { ZodType } from "zod";
import { BatchManifestSchema, BatchResultSchema } from "../domain/schemas.js";
import type { BatchManifest, BatchResult } from "../domain/schemas.js";

const MANIFEST_FILE = "manifest.json";
const RAW_DIR = "raw";
const PROCESSED_DIR = "processed";
const RESULTS_FILE = "results.json";

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/** Batch ids become directory names, so anything that could escape `outDir` is rejected. */
const BATCH_ID_RE = /^[A-Za-z0-9._-]+$/;

export function assertBatchId(batchId: string): string {
  if (!BATCH_ID_RE.test(batchId) || batchId === ".." || batchId.includes("..")) {
    throw new Error(`Invalid batch id: "${batchId}" (letters, digits, dot, dash and underscore only, and no "..")`);
  }
  return batchId;
}

/** `<outDir>/<batchId>` — one directory per generated batch. */
export function batchDir(outDir: string, batchId: string): string {
  return path.join(outDir, assertBatchId(batchId));
}

/** Writes `manifest.json` plus one `raw/<document.filename>` per document; returns the batch directory. */
export async function writeBatch(outDir: string, manifest: BatchManifest): Promise<string> {
  const dir = batchDir(outDir, manifest.batchId);
  const rawDir = path.join(dir, RAW_DIR);

  // Re-writing a batch must not leave documents from an earlier run behind.
  await fs.rm(rawDir, { recursive: true, force: true });
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const doc of manifest.documents) {
    // basename keeps a hand-edited manifest from writing outside the raw directory.
    await fs.writeFile(path.join(rawDir, path.basename(doc.filename)), doc.text, "utf8");
  }
  return dir;
}

export async function readManifest(outDir: string, batchId: string): Promise<BatchManifest> {
  const file = path.join(batchDir(outDir, batchId), MANIFEST_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isMissing(err)) throw new Error(`Batch ${batchId} not found under ${outDir}`);
    throw err;
  }
  return parseOrThrow(BatchManifestSchema, raw, `Batch ${batchId} manifest is invalid`);
}

/** Sorted ids of every sub-directory that holds a manifest; empty when `outDir` is absent. */
export async function listBatches(outDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(outDir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }

  const ids: string[] = [];
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    try {
      await fs.access(path.join(outDir, dirent.name, MANIFEST_FILE));
      ids.push(dirent.name);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return ids.sort();
}

/**
 * The batch result written by `FileSink` — the one canonical shape of
 * `processed/results.json`. Null when the batch has not been processed yet.
 */
export async function readResult(outDir: string, batchId: string): Promise<BatchResult | null> {
  const file = path.join(batchDir(outDir, batchId), PROCESSED_DIR, RESULTS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  return parseOrThrow(BatchResultSchema, raw, `Batch ${batchId} results are invalid`);
}

/** Turns a JSON or schema failure into a message naming the batch and the offending fields. */
function parseOrThrow<T>(schema: ZodType<T>, raw: string, context: string): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`${context}: ${details}`);
}
