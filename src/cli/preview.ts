import Table from "cli-table3";
import pc from "picocolors";
import type { BatchManifest } from "../domain/schemas.js";
import { money } from "../report/format.js";

const FIRST_LINE_MAX = 44;
const VENDOR_MAX = 26;

function trunc(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** First non-empty line of a document, collapsed to one terminal line. */
function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return trunc(line.trim(), FIRST_LINE_MAX);
}

/** The documents exactly as the pipeline will see them — text only, no ground truth. */
export function renderDocumentTable(manifest: BatchManifest): string {
  const table = new Table({
    head: ["#", "id", "format", "chars", "first line"].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
    colAligns: ["right", "left", "left", "right", "left"],
  });

  manifest.documents.forEach((doc, index) => {
    table.push([String(index + 1), doc.id, doc.format, String(doc.text.length), firstLine(doc.text)]);
  });

  const header = pc.bold(`\nRaw documents — batch ${manifest.batchId} (${manifest.documents.length} document(s))`);
  return `${header}\n${table.toString()}`;
}

/** What the generator injected. The pipeline never sees this; it is what `evaluate` scores against. */
export function renderGroundTruthTable(manifest: BatchManifest): string {
  const table = new Table({
    head: ["id", "invoice #", "vendor", "total", "currency", "defects"].map((h) => pc.bold(h)),
    style: { head: [], border: [] },
    colAligns: ["left", "left", "left", "right", "left", "left"],
  });

  for (const invoice of manifest.groundTruth) {
    table.push([
      invoice.id,
      invoice.invoiceNumber,
      trunc(invoice.vendor.name, VENDOR_MAX),
      money(invoice.total),
      invoice.currency,
      invoice.defects.length > 0 ? pc.yellow(invoice.defects.join(", ")) : pc.dim("clean"),
    ]);
  }

  const header = pc.bold(`\nGround truth ${pc.dim("(truth — never shown to the pipeline)")}`);
  return `${header}\n${table.toString()}`;
}

/** Full text of one document, for `preview --show <docId>`. */
export function renderDocumentText(manifest: BatchManifest, documentId: string): string {
  const doc = manifest.documents.find((d) => d.id === documentId || d.filename === documentId);
  if (doc === undefined) {
    const known = manifest.documents.map((d) => d.id).join(", ");
    throw new Error(`Document ${documentId} is not in batch ${manifest.batchId}. Known ids: ${known}`);
  }
  return `${pc.bold(`\n${doc.filename} (${doc.format}, ${doc.text.length} chars)`)}\n${pc.dim("-".repeat(64))}\n${doc.text}`;
}
