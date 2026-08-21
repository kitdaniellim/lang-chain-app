import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MONEY_TOLERANCE } from "../domain/constants.js";
import { DecisionSchema } from "../domain/schemas.js";
import { normalizeVendorName } from "../domain/vendors.js";
import type { ExactQuery, LedgerEntry, LedgerStore, SimilarQuery } from "./ledger.types.js";

/** On-disk shape of one ledger row; mirrors the LedgerEntry interface. */
export const LedgerEntrySchema = z.object({
  invoiceNumber: z.string(),
  vendorName: z.string().nullable(),
  total: z.number().nullable(),
  currency: z.string().nullable(),
  issueDate: z.string().nullable(),
  documentId: z.string(),
  batchId: z.string(),
  decision: DecisionSchema,
  processedAt: z.string(),
});

const LedgerFileSchema = z.array(LedgerEntrySchema);

/** First few zod issues, formatted for the corrupt-ledger error message. */
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

const DAY_MS = 86_400_000;

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/** Names and numbers are compared trimmed and case-insensitively. */
const key = (value: string): string => value.trim().toLowerCase();

/** Identity of a ledger row: one row per document per batch. */
const rowKey = (entry: LedgerEntry): string => JSON.stringify([entry.batchId, entry.documentId]);

/** Whole days between two ISO dates, or null when either is unparseable. */
function daysApart(a: string, b: string): number | null {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return null;
  return Math.abs(left - right) / DAY_MS;
}

/** File-backed payment ledger: a JSON array of entries, rewritten atomically on save. */
export class JsonLedger implements LedgerStore {
  private constructor(
    private readonly filePath: string,
    private readonly entries: LedgerEntry[],
  ) {}

  /** A missing file is an empty ledger; unreadable or invalid content is an error, never a silent reset. */
  static async load(filePath: string): Promise<JsonLedger> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (isMissing(err)) return new JsonLedger(filePath, []);
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Ledger file ${filePath} is corrupt: ${(err as Error).message}`);
    }

    const result = LedgerFileSchema.safeParse(parsed);
    if (!result.success) throw new Error(`Ledger file ${filePath} is corrupt: ${summarizeIssues(result.error)}`);
    return new JsonLedger(filePath, result.data);
  }

  find(invoiceNumber: string, excludeBatchId?: string): LedgerEntry[] {
    const needle = key(invoiceNumber);
    return this.entries.filter((e) => key(e.invoiceNumber) === needle && e.batchId !== excludeBatchId);
  }

  /** Number-only hits narrowed to the same vendor; a null vendor matches only rows with a null vendor. */
  findExact(query: ExactQuery): LedgerEntry[] {
    const vendor = query.vendorName === null ? null : normalizeVendorName(query.vendorName);
    return this.find(query.invoiceNumber, query.excludeBatchId).filter((e) =>
      e.vendorName === null ? vendor === null : vendor !== null && normalizeVendorName(e.vendorName) === vendor,
    );
  }

  findSimilar(query: SimilarQuery): LedgerEntry[] {
    const { vendorName, total, issueDate, windowDays, excludeBatchId } = query;
    if (vendorName === null || total === null) return [];
    const vendor = key(vendorName);

    return this.entries.filter((e) => {
      if (e.batchId === excludeBatchId) return false;
      if (e.vendorName === null || e.total === null) return false;
      if (key(e.vendorName) !== vendor) return false;
      if (Math.abs(e.total - total) > MONEY_TOLERANCE) return false;
      // A row without an issue date can never be windowed, so it never counts as similar.
      if (e.issueDate === null) return false;
      if (issueDate === null) return true;
      const gap = daysApart(issueDate, e.issueDate);
      return gap !== null && gap <= windowDays;
    });
  }

  size(): number {
    return this.entries.length;
  }

  /** A copy of every row, in insertion order — for read-only consumers like the dashboard. */
  rows(): LedgerEntry[] {
    return [...this.entries];
  }

  /**
   * Upsert keyed on (batchId, documentId): re-running a batch replaces its own rows
   * instead of appending a second copy of every invoice.
   */
  append(entries: LedgerEntry[]): void {
    const positions = new Map(this.entries.map((e, index) => [rowKey(e), index]));
    for (const entry of entries) {
      const at = positions.get(rowKey(entry));
      if (at === undefined) {
        positions.set(rowKey(entry), this.entries.length);
        this.entries.push(entry);
      } else {
        this.entries[at] = entry;
      }
    }
  }

  /** Writes to `<file>.tmp` first so a crash mid-write cannot truncate the ledger. */
  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.entries, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.filePath);
  }
}
