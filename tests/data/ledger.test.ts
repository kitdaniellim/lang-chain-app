import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonLedger } from "../../src/data/ledger.js";
import { LEDGER_FILENAME } from "../../src/domain/constants.js";
import type { LedgerEntry } from "../../src/data/ledger.types.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lcd-ledger-"));
  file = path.join(dir, LEDGER_FILENAME);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  invoiceNumber: "INV-2026-0417",
  vendorName: "Acme Cloud Inc",
  total: 216,
  currency: "USD",
  issueDate: "2026-07-03",
  documentId: "doc-001",
  batchId: "batch-a",
  decision: "auto_approved",
  processedAt: "2026-08-20T00:00:00.000Z",
  ...over,
});

describe("JsonLedger — persistence", () => {
  it("loads an empty ledger when the file does not exist", async () => {
    const ledger = await JsonLedger.load(file);
    expect(ledger.size()).toBe(0);
    expect(ledger.find("INV-2026-0417")).toEqual([]);
  });

  it("upserts on (batchId, documentId) so a re-run does not duplicate rows", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry(), entry({ documentId: "doc-002", invoiceNumber: "INV-2026-0500" })]);

    // Same batch, same documents, new decision: the rows are replaced, not doubled.
    ledger.append([
      entry({ decision: "auto_rejected", processedAt: "2026-08-21T00:00:00.000Z" }),
      entry({ documentId: "doc-002", invoiceNumber: "INV-2026-0500" }),
    ]);
    expect(ledger.size()).toBe(2);
    expect(ledger.find("INV-2026-0417")[0]!.decision).toBe("auto_rejected");
    expect(ledger.find("INV-2026-0417")[0]!.processedAt).toBe("2026-08-21T00:00:00.000Z");

    // A different batch replaying the same document is a genuine second row.
    ledger.append([entry({ batchId: "batch-b" })]);
    expect(ledger.size()).toBe(3);
    expect(ledger.find("INV-2026-0417")).toHaveLength(2);
  });

  it("round-trips appended entries through save/load", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry(), entry({ invoiceNumber: "INV-2026-0500", documentId: "doc-002" })]);
    expect(ledger.size()).toBe(2);
    await ledger.save();

    const reloaded = await JsonLedger.load(file);
    expect(reloaded.size()).toBe(2);
    expect(reloaded.find("INV-2026-0500")).toEqual([entry({ invoiceNumber: "INV-2026-0500", documentId: "doc-002" })]);
  });

  it("writes atomically and leaves no temp file behind", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry()]);
    await ledger.save();

    expect(await fs.readdir(dir)).toEqual([LEDGER_FILENAME]);
    expect(Array.isArray(JSON.parse(await fs.readFile(file, "utf8")))).toBe(true);
  });

  it("creates the parent directory when saving", async () => {
    const nested = path.join(dir, "a", "b", LEDGER_FILENAME);
    const ledger = await JsonLedger.load(nested);
    ledger.append([entry()]);
    await ledger.save();
    expect((await JsonLedger.load(nested)).size()).toBe(1);
  });
});

describe("JsonLedger — corrupt files", () => {
  it("rejects a file that is not JSON", async () => {
    await fs.writeFile(file, "not json at all", "utf8");
    await expect(JsonLedger.load(file)).rejects.toThrow(/is corrupt/);
  });

  it("rejects JSON that is not an array of entries", async () => {
    await fs.writeFile(file, JSON.stringify({ entries: [] }), "utf8");
    await expect(JsonLedger.load(file)).rejects.toThrow(/is corrupt/);
  });

  it("rejects a row with a bad field and names the field", async () => {
    await fs.writeFile(file, JSON.stringify([{ ...entry(), total: "216" }]), "utf8");
    await expect(JsonLedger.load(file)).rejects.toThrow(/is corrupt: 0\.total/);
  });

  it("rejects a row with an unknown decision", async () => {
    await fs.writeFile(file, JSON.stringify([{ ...entry(), decision: "maybe" }]), "utf8");
    await expect(JsonLedger.load(file)).rejects.toThrow(/is corrupt/);
  });
});

describe("JsonLedger — find", () => {
  it("returns invoice-number matches and honours excludeBatchId", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([
      entry(),
      entry({ documentId: "doc-009", batchId: "batch-b" }),
      entry({ invoiceNumber: "INV-2026-9999", documentId: "doc-010" }),
    ]);

    expect(ledger.find("INV-2026-0417")).toHaveLength(2);
    expect(ledger.find("INV-2026-0417", "batch-b")).toHaveLength(1);
    expect(ledger.find("INV-2026-0417", "batch-b")[0]!.batchId).toBe("batch-a");
    expect(ledger.find("inv-2026-0417")).toHaveLength(2);
    expect(ledger.find("inv-2026-0417", "batch-b")).toHaveLength(1);
    expect(ledger.find("INV-2026-0000")).toEqual([]);
  });

  it("ignores surrounding whitespace and letter case", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry()]);
    expect(ledger.find("  inv-2026-0417 ")).toHaveLength(1);
  });
});

describe("JsonLedger — findSimilar", () => {
  const query = {
    vendorName: "acme cloud inc",
    total: 216,
    issueDate: "2026-07-10",
    windowDays: 90,
  };

  it("matches the same vendor and total inside the window", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry()]);
    expect(ledger.findSimilar(query)).toHaveLength(1);
  });

  it("tolerates cent-level differences in the total but nothing larger", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry({ total: 216.01 }), entry({ total: 216.5, documentId: "doc-003" })]);
    const matches = ledger.findSimilar(query);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.total).toBe(216.01);
  });

  it("respects the day window", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry({ issueDate: "2026-01-01" })]);
    expect(ledger.findSimilar({ ...query, windowDays: 30 })).toEqual([]);
    expect(ledger.findSimilar({ ...query, windowDays: 400 })).toHaveLength(1);
  });

  it("skips rows without an issue date when the query has one", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry({ issueDate: null })]);
    expect(ledger.findSimilar(query)).toEqual([]);
  });

  it("never returns undated rows, even when the query has no date", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry({ issueDate: null }), entry({ documentId: "doc-007" })]);
    const matches = ledger.findSimilar({ ...query, issueDate: null });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.documentId).toBe("doc-007");
  });

  it("returns nothing when the vendor or total is unknown on either side", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry(), entry({ vendorName: null, documentId: "doc-004" }), entry({ total: null, documentId: "doc-005" })]);
    expect(ledger.findSimilar({ ...query, vendorName: null })).toEqual([]);
    expect(ledger.findSimilar({ ...query, total: null })).toEqual([]);
    expect(ledger.findSimilar({ ...query, vendorName: "Other Vendor" })).toEqual([]);
    expect(ledger.findSimilar(query)).toHaveLength(1);
  });

  it("excludes rows from excludeBatchId", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry(), entry({ batchId: "batch-b", documentId: "doc-006" })]);
    expect(ledger.findSimilar({ ...query, excludeBatchId: "batch-a" })).toHaveLength(1);
    expect(ledger.findSimilar({ ...query, excludeBatchId: "batch-a" })[0]!.batchId).toBe("batch-b");
  });
});

describe("JsonLedger — findExact", () => {
  it("matches only rows with the same number AND the same vendor", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([
      entry(),
      entry({ vendorName: "Northwind Software LLC", documentId: "doc-002" }),
      entry({ invoiceNumber: "INV-2026-9999", documentId: "doc-003" }),
    ]);

    const hits = ledger.findExact({ invoiceNumber: "INV-2026-0417", vendorName: "Acme Cloud Inc" });
    expect(hits.map((e) => e.documentId)).toEqual(["doc-001"]);
    expect(ledger.find("INV-2026-0417")).toHaveLength(2);
  });

  it("normalises the vendor on both sides (case, punctuation, legal suffix)", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry()]);
    expect(ledger.findExact({ invoiceNumber: "  inv-2026-0417 ", vendorName: "ACME CLOUD, INCORPORATED" })).toHaveLength(1);
    expect(ledger.findExact({ invoiceNumber: "INV-2026-0417", vendorName: "Acme Cloud" })).toHaveLength(1);
  });

  it("treats a null vendor as matching only rows whose vendor is also null", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry(), entry({ vendorName: null, documentId: "doc-002" })]);

    const nullSide = ledger.findExact({ invoiceNumber: "INV-2026-0417", vendorName: null });
    expect(nullSide.map((e) => e.documentId)).toEqual(["doc-002"]);
    expect(ledger.findExact({ invoiceNumber: "INV-2026-0417", vendorName: "Acme Cloud Inc" }).map((e) => e.documentId)).toEqual([
      "doc-001",
    ]);
  });

  it("honours excludeBatchId", async () => {
    const ledger = await JsonLedger.load(file);
    ledger.append([entry(), entry({ batchId: "batch-b" })]);
    const query = { invoiceNumber: "INV-2026-0417", vendorName: "Acme Cloud Inc" };
    expect(ledger.findExact(query)).toHaveLength(2);
    expect(ledger.findExact({ ...query, excludeBatchId: "batch-b" }).map((e) => e.batchId)).toEqual(["batch-a"]);
  });
});
