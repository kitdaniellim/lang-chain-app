import { faker } from "@faker-js/faker";
import { DEFAULT_POLICY } from "../domain/policy.js";
import { DEFECT_CODES, DOCUMENT_FORMATS } from "../domain/schemas.js";
import type {
  BatchManifest,
  Category,
  DefectCode,
  DocumentFormat,
  Invoice,
  LineItem,
  RawInvoiceDocument,
} from "../domain/schemas.js";
import { VENDORS } from "../domain/vendors.js";
import {
  DEFECT_APPLY_ORDER,
  addDays,
  applyDefect,
  defectsConflict,
  round2,
  withRecomputedTotals,
} from "./defects.js";
import { renderDocument } from "./renderers.js";
import { createRng } from "./rng.js";
import type { Rng } from "./rng.js";

export interface GenerateOptions {
  count: number;
  seed: number;
  /** Probability that an invoice gets one (sometimes two) injected defects. */
  defectRate: number;
  batchId?: string;
  /** Reference "today"; defaults to a fixed date so batches are reproducible. */
  now?: Date;
}

const DEFAULT_NOW = "2026-08-20T00:00:00Z";
const PAYMENT_TERM_DAYS = 30;
const TAX_RATES = [0, 0.05, 0.08, 0.12] as const;
const SECOND_DEFECT_CHANCE = 0.25;

/** Line-item wording per expense category; the vendor's default category picks the pool. */
const DESCRIPTIONS: Record<Category, readonly string[]> = {
  CLOUD_HOSTING: [
    "Compute hours (c5.large)",
    "Object storage 2 TB",
    "Managed database - small",
    "Load balancer hours",
    "Outbound data transfer",
  ],
  SOFTWARE: [
    "Team license - 10 seats",
    "Annual subscription renewal",
    "Developer seats add-on",
    "Priority support plan",
    "API usage tier",
  ],
  OFFICE_SUPPLIES: [
    "Copy paper A4 (box)",
    "Toner cartridge black",
    "Whiteboard markers (pack)",
    "Desk organiser set",
    "Sticky notes (bundle)",
  ],
  PROFESSIONAL_SERVICES: [
    "Consulting hours - senior",
    "Legal retainer - monthly",
    "Contract review",
    "Onboarding workshop",
    "Advisory call block",
  ],
  TRAVEL: ["Flight SFO-JFK economy", "Hotel 3 nights", "Airport transfer", "Rail pass - regional", "Per diem allowance"],
  MARKETING: [
    "Campaign management - July",
    "Display ads - 50k impressions",
    "Creative retainer",
    "Landing page design",
    "Email newsletter build",
  ],
  UTILITIES: [
    "Electricity - July usage",
    "Water service",
    "Waste collection",
    "Natural gas supply",
    "Business internet line",
  ],
  EQUIPMENT: ["Laptop 14in 32GB", "Monitor 27in 4K", "Docking station", "Ergonomic chair", "Conference room camera"],
  OTHER: [
    "Facilities cleaning - monthly",
    "Landscaping service",
    "Security patrol hours",
    "Pest control visit",
    "Window cleaning",
  ],
};

const NOTES = [
  "Thank you for your business.",
  "Payment terms: net 30.",
  "Please reference the PO number on remittance.",
  "Contact billing with any questions.",
] as const;

/** "batch-20260820-000000-42" — deterministic for a given `now` + seed. */
function defaultBatchId(now: Date, seed: number): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `batch-${stamp}-${seed}`;
}

/** Yields formats from a reshuffled deck so every batch of three sees all three formats. */
function formatCycle(rng: Rng): () => DocumentFormat {
  let deck: DocumentFormat[] = [];
  return () => {
    if (deck.length === 0) deck = rng.shuffle(DOCUMENT_FORMATS);
    return deck.pop() as DocumentFormat;
  };
}

function makeLineItems(category: Category, rng: Rng): LineItem[] {
  const pool = DESCRIPTIONS[category];
  const descriptions = rng.shuffle(pool).slice(0, rng.int(1, Math.min(5, pool.length)));
  // Target subtotal stays well under the review threshold; weights split it across the lines.
  const targetSubtotal = rng.int(15_000, 400_000) / 100;
  const weights = descriptions.map(() => rng.int(1, 10));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  return descriptions.map((description, i) => {
    const share = (targetSubtotal * (weights[i] ?? 1)) / totalWeight;
    const quantity = rng.int(1, 12);
    const unitPrice = Math.max(round2(share / quantity), 0.01);
    return { description, quantity, unitPrice, amount: round2(quantity * unitPrice) };
  });
}

function makeInvoice(id: string, index: number, numberBase: number, rng: Rng, now: Date): Invoice {
  const vendor = rng.pick(VENDORS);
  const issueDate = addDays(now.toISOString().slice(0, 10), -rng.int(1, 60));
  const lineItems = makeLineItems(vendor.defaultCategory, rng);

  return withRecomputedTotals(
    {
      id,
      // Per-batch base plus a 7-wide slot per index: unique inside the batch, unlikely to collide across batches.
      invoiceNumber: `INV-2026-${String(numberBase + index * 7 + rng.int(0, 6)).padStart(4, "0")}`,
      vendor: { name: vendor.name, email: `billing@${vendor.emailDomain}`, address: vendor.address },
      issueDate,
      dueDate: addDays(issueDate, PAYMENT_TERM_DAYS),
      currency: "USD",
      lineItems,
      subtotal: 0,
      taxRate: rng.pick(TAX_RATES),
      taxAmount: 0,
      total: 0,
      poNumber: `PO-${rng.int(10_000, 99_999)}`,
      notes: rng.chance(0.6) ? rng.pick(NOTES) : null,
      defects: [],
    },
    lineItems,
  );
}

/**
 * Round-robin draw: the chosen code moves to the back of the ring while rejected ones
 * stay at the front, so a code that could not apply yet is retried on the next invoice.
 */
function drawDefect(ring: DefectCode[], reject: (code: DefectCode) => boolean): DefectCode | null {
  const passes = ring.length;
  const skipped: DefectCode[] = [];
  let chosen: DefectCode | null = null;

  for (let i = 0; i < passes; i++) {
    const code = ring.shift();
    if (code === undefined) break;
    if (reject(code)) {
      skipped.push(code);
      continue;
    }
    ring.push(code);
    chosen = code;
    break;
  }

  ring.unshift(...skipped);
  return chosen;
}

function injectDefects(invoice: Invoice, earlier: Invoice[], rng: Rng, ring: DefectCode[]): Invoice {
  const unusable = (code: DefectCode): boolean => code === "DUPLICATE_NUMBER" && earlier.length === 0;

  const first = drawDefect(ring, unusable);
  if (first === null) return invoice;

  const chosen: DefectCode[] = [first];
  if (rng.chance(SECOND_DEFECT_CHANCE)) {
    const second = drawDefect(ring, (code) => unusable(code) || defectsConflict(first, code));
    if (second !== null) chosen.push(second);
  }

  const ctx = { earlier, policy: DEFAULT_POLICY };
  return DEFECT_APPLY_ORDER.filter((code) => chosen.includes(code)).reduce(
    (acc, code) => applyDefect(acc, code, rng, ctx),
    invoice,
  );
}

/** Builds a reproducible batch: ground-truth invoices plus their rendered documents. */
export function generateBatch(opts: GenerateOptions): BatchManifest {
  const now = opts.now ?? new Date(DEFAULT_NOW);
  const rng = createRng(opts.seed);
  faker.seed(opts.seed);

  // Seeded so two batches from different seeds do not reuse each other's invoice numbers.
  const numberBase = 1_000 + rng.int(0, 80_000);

  const nextFormat = formatCycle(rng);
  const ring = rng.shuffle(DEFECT_CODES);
  // One invoice is always left clean so a defect-heavy batch still shows the happy path.
  const cleanIndex = opts.count >= 2 ? rng.int(0, opts.count - 1) : -1;

  const groundTruth: Invoice[] = [];
  const documents: RawInvoiceDocument[] = [];

  for (let i = 0; i < opts.count; i++) {
    const id = `doc-${String(i + 1).padStart(3, "0")}`;
    const base = makeInvoice(id, i, numberBase, rng, now);
    const wantsDefect = rng.chance(opts.defectRate);
    const invoice = wantsDefect && i !== cleanIndex ? injectDefects(base, groundTruth, rng, ring) : base;
    const format = nextFormat();

    groundTruth.push(invoice);
    documents.push({ id, filename: `${id}.${format}.txt`, format, text: renderDocument(invoice, format) });
  }

  return {
    batchId: opts.batchId ?? defaultBatchId(now, opts.seed),
    createdAt: now.toISOString(),
    seed: opts.seed,
    defectRate: opts.defectRate,
    documents,
    groundTruth,
  };
}
