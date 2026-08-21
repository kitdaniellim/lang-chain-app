import type { Decision } from "../domain/schemas.js";

/** One row in the payment ledger (what has been processed before). */
export interface LedgerEntry {
  invoiceNumber: string;
  vendorName: string | null;
  total: number | null;
  currency: string | null;
  issueDate: string | null;
  documentId: string;
  batchId: string;
  decision: Decision;
  processedAt: string;
}

/** Identity of one already-processed invoice: same number *and* same vendor. */
export interface ExactQuery {
  invoiceNumber: string;
  /** null matches only ledger rows whose vendor is also null. */
  vendorName: string | null;
  excludeBatchId?: string;
}

export interface SimilarQuery {
  vendorName: string | null;
  total: number | null;
  issueDate: string | null;
  windowDays: number;
  excludeBatchId?: string;
}

/** Read side used by tools/nodes. */
export interface LedgerReader {
  /** Case-insensitive, whitespace-trimmed invoice-number matches, optionally ignoring rows from the given batch (re-runs are not duplicates). */
  find(invoiceNumber: string, excludeBatchId?: string): LedgerEntry[];
  /** Same normalised invoice number *and* the same normalised vendor — a real duplicate payment. */
  findExact(query: ExactQuery): LedgerEntry[];
  /** Same vendor + same total within `windowDays` of `issueDate`. */
  findSimilar(query: SimilarQuery): LedgerEntry[];
  size(): number;
}

/** Write side used once per batch, after all decisions are final. */
export interface LedgerStore extends LedgerReader {
  append(entries: LedgerEntry[]): void;
  save(): Promise<void>;
}
