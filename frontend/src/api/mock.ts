// Offline fixtures + canned responses so the UI can be built without the backend.
// Enabled by VITE_USE_MOCK=true; the default is off.

import type {
  BulkCreateResponse,
  ChatResponse,
  HealthResponse,
  IngestPreview,
  IngestSource,
  Invoice,
  InvoiceDraft,
  InvoiceOut,
  InvoicePage,
  InvoiceQuery,
  SkippedInvoice,
} from "./types";

export const MOCK_INVOICES: InvoiceOut[] = [
  {
    id: 6,
    invoice_number: "NW-2026-0431",
    vendor_name: "Northwind Supply Co.",
    vendor_email: "billing@northwind-supply.example",
    invoice_date: "2026-08-12",
    due_date: "2026-09-11",
    currency: "USD",
    line_items: [
      { description: "Warehouse racking, 3 m bay", quantity: 4, unit_price: 610.0, amount: 2440.0 },
      { description: "Installation labour", quantity: 12, unit_price: 85.0, amount: 1020.0 },
    ],
    subtotal: 3460.0,
    tax: 276.8,
    total: 3736.8,
    po_number: "PO-88213",
    status: "pending",
    needs_review: false,
    review_notes: [],
    source: "extracted",
    created_at: "2026-08-12T09:14:00Z",
  },
  {
    id: 5,
    invoice_number: "VPW-9932",
    vendor_name: "Vantage Print Werks",
    vendor_email: null,
    invoice_date: "2026-06-30",
    due_date: "2026-06-15",
    currency: "EUR",
    line_items: [
      { description: "Trade-show banners (A0)", quantity: 6, unit_price: 74.5, amount: 447.0 },
      { description: "Rush finishing surcharge", quantity: 1, unit_price: 120.0, amount: 120.0 },
    ],
    subtotal: 600.0,
    tax: 114.0,
    total: 714.0,
    po_number: null,
    status: "overdue",
    needs_review: true,
    review_notes: [
      "Line items sum to 567.00 but the subtotal reads 600.00.",
      "Due date 2026-06-15 is before the invoice date 2026-06-30.",
    ],
    source: "uploaded",
    created_at: "2026-06-30T16:02:00Z",
  },
  {
    id: 4,
    invoice_number: "ORN-4417",
    vendor_name: "Orion Cloud Services",
    vendor_email: "ar@orioncloud.example",
    invoice_date: "2026-07-01",
    due_date: "2026-07-31",
    currency: "USD",
    line_items: [
      { description: "Compute, reserved instances (July)", quantity: 1, unit_price: 1840.0, amount: 1840.0 },
      { description: "Object storage, 4.2 TB", quantity: 4.2, unit_price: 23.0, amount: 96.6 },
      { description: "Egress overage", quantity: 1, unit_price: 63.4, amount: 63.4 },
    ],
    subtotal: 2000.0,
    tax: 160.0,
    total: 2160.0,
    po_number: "PO-77104",
    status: "paid",
    needs_review: false,
    review_notes: [],
    source: "seed",
    created_at: "2026-07-01T11:30:00Z",
  },
  {
    id: 3,
    invoice_number: "CL-0088",
    vendor_name: "Cedar & Locke Design",
    vendor_email: "hello@cedarlocke.example",
    invoice_date: "2026-07-18",
    due_date: "2026-09-01",
    currency: "EUR",
    line_items: [{ description: "Brand refresh, phase 2", quantity: 1, unit_price: 4200.0, amount: 4200.0 }],
    subtotal: 4200.0,
    tax: 798.0,
    total: 4998.0,
    po_number: null,
    status: "pending",
    needs_review: false,
    review_notes: [],
    source: "seed",
    created_at: "2026-07-18T08:45:00Z",
  },
  {
    id: 2,
    invoice_number: "HPM-2026-114",
    vendor_name: "Halcyon Paper Mill",
    vendor_email: "accounts@halcyonpaper.example",
    invoice_date: "2026-05-04",
    due_date: "2026-06-03",
    currency: "USD",
    line_items: [
      { description: "Recycled stock, 120 gsm (reams)", quantity: 40, unit_price: 11.25, amount: 450.0 },
      { description: "Freight", quantity: 1, unit_price: 95.0, amount: 95.0 },
    ],
    subtotal: 545.0,
    tax: 43.6,
    total: 588.6,
    po_number: "PO-55019",
    status: "overdue",
    needs_review: false,
    review_notes: [],
    source: "seed",
    created_at: "2026-05-04T13:20:00Z",
  },
  {
    id: 1,
    invoice_number: "BH-31007",
    vendor_name: "Blue Harbor Logistics",
    vendor_email: "invoices@blueharbor.example",
    invoice_date: "2026-04-22",
    due_date: "2026-05-22",
    currency: "USD",
    line_items: [
      { description: "Container drayage, port to DC", quantity: 3, unit_price: 410.0, amount: 1230.0 },
      { description: "Chassis rental (days)", quantity: 9, unit_price: 42.0, amount: 378.0 },
      { description: "Fuel surcharge", quantity: 1, unit_price: 92.0, amount: 92.0 },
    ],
    subtotal: 1700.0,
    tax: 0,
    total: 1700.0,
    po_number: null,
    status: "paid",
    needs_review: false,
    review_notes: [],
    source: "seed-fallback",
    created_at: "2026-04-22T07:05:00Z",
  },
];

export const MOCK_HEALTH: HealthResponse = {
  ok: true,
  database: "sqlite",
  llm_configured: true,
  model: "claude-sonnet-5",
};

const MOCK_EXTRACTED_INVOICE: Invoice = {
  invoice_number: "ACME-2026-0042",
  vendor_name: "Acme Fabrication Ltd.",
  vendor_email: "billing@acmefab.example",
  invoice_date: "2026-08-19",
  due_date: "2026-09-18",
  currency: "USD",
  line_items: [
    { description: "CNC bracket, aluminium 6061", quantity: 25, unit_price: 18.4, amount: 460.0 },
    { description: "Powder coating", quantity: 25, unit_price: 3.6, amount: 90.0 },
    { description: "Tooling setup", quantity: 1, unit_price: 150.0, amount: 150.0 },
  ],
  subtotal: 700.0,
  tax: 56.0,
  total: 756.0,
  po_number: "PO-90210",
  status: "pending",
};

const MOCK_RAW_TEXT = `INVOICE ACME-2026-0042
Acme Fabrication Ltd. / billing@acmefab.example
Date: 2026-08-19   Due: 2026-09-18   PO: PO-90210

25 x CNC bracket, aluminium 6061 @ 18.40   460.00
25 x Powder coating @ 3.60                  90.00
 1 x Tooling setup @ 150.00                150.00

Subtotal 700.00   Tax 56.00   Total due USD 756.00`;

/** A .pdf/.txt/.md upload: Claude extracts exactly one invoice and returns the source text. */
export const MOCK_INGEST_EXTRACTED: IngestPreview = {
  filename: "acme-2026-0042.txt",
  kind: "extracted",
  model: "claude-sonnet-5",
  mapping: null,
  mapping_source: null,
  invoices: [
    {
      invoice: MOCK_EXTRACTED_INVOICE,
      needs_review: false,
      review_notes: [],
      import_notes: [],
      source_rows: [],
    },
  ],
  unmapped_columns: [],
  warnings: [],
  raw_text: MOCK_RAW_TEXT,
};

/** A line-item-granularity ledger export: two grouped invoices, one single-row invoice. */
export const MOCK_INGEST_IMPORTED: IngestPreview = {
  filename: "ledger-export-aug.csv",
  kind: "imported",
  mapping: {
    granularity: "line_item",
    invoice_number: "Inv No",
    vendor_name: "Supplier",
    vendor_email: null,
    invoice_date: "Bill Date",
    due_date: "Pay By",
    currency: null,
    currency_default: "GBP",
    status: "State",
    subtotal: null,
    tax: "Tax",
    total: "Amount Due",
    po_number: null,
    line_item_description: "Item",
    line_item_quantity: "Qty",
    line_item_unit_price: "Unit",
    line_item_amount: "Line Total",
    line_items_json: null,
    date_format: "DMY",
    status_values: { Settled: "paid", Open: "pending", "Past due": "overdue" },
    notes: [
      "No currency column: the amounts use £ and every supplier is UK-based, so GBP is assumed.",
      "Dates read as day/month/year, so 04/08/2026 is 4 August 2026, not 8 April.",
    ],
  },
  mapping_source: "claude",
  model: "claude-sonnet-5",
  raw_text: null,
  unmapped_columns: ["Cost Centre"],
  warnings: [
    "Row 8 has no value in “Inv No” and was skipped.",
    "“State” holds free text such as “Awaiting payment”; values were matched case-insensitively.",
  ],
  invoices: [
    {
      invoice: {
        invoice_number: "MTL-4820",
        vendor_name: "Meridian Timber Ltd",
        vendor_email: null,
        invoice_date: "2026-08-04",
        due_date: "2026-09-03",
        currency: "GBP",
        line_items: [
          { description: "Oak boarding, 22 mm (m²)", quantity: 48, unit_price: 31.5, amount: 1512.0 },
          { description: "Softwood battens (m)", quantity: 120, unit_price: 2.85, amount: 342.0 },
          { description: "Delivery, 2 pallets", quantity: 1, unit_price: 65.0, amount: 65.0 },
        ],
        subtotal: 1919.0,
        tax: 383.8,
        total: 2302.8,
        po_number: null,
        status: "pending",
      },
      needs_review: false,
      review_notes: [],
      import_notes: [
        "Subtotal derived as total − tax (the file has no subtotal column).",
        "Currency GBP applied from the mapping default.",
      ],
      source_rows: [2, 3, 4],
    },
    {
      invoice: {
        invoice_number: "KF-2026-118",
        vendor_name: "Kestrel Facilities",
        vendor_email: null,
        invoice_date: "2026-07-31",
        due_date: "2026-06-30",
        currency: "GBP",
        line_items: [
          { description: "Monthly cleaning contract", quantity: 1, unit_price: 940.0, amount: 940.0 },
          { description: "Consumables restock", quantity: 1, unit_price: 128.4, amount: 128.4 },
        ],
        subtotal: 1168.4,
        tax: 213.68,
        total: 1382.08,
        po_number: null,
        status: "overdue",
      },
      needs_review: true,
      review_notes: [
        "Line items sum to 1068.40 but the subtotal reads 1168.40.",
        "Due date 2026-06-30 is before the invoice date 2026-07-31.",
      ],
      import_notes: [
        "Subtotal derived as total − tax (the file has no subtotal column).",
        "“Awaiting payment” mapped to status overdue because the due date has passed.",
      ],
      source_rows: [5, 6],
    },
    {
      invoice: {
        invoice_number: "WC-0912",
        vendor_name: "Wren & Co Stationery",
        vendor_email: null,
        invoice_date: "2026-08-06",
        due_date: "2026-09-05",
        currency: "GBP",
        line_items: [
          { description: "Copier paper, A4 (boxes)", quantity: 12, unit_price: 24.5, amount: 294.0 },
        ],
        subtotal: 294.0,
        tax: 58.8,
        total: 352.8,
        po_number: null,
        status: "paid",
      },
      needs_review: false,
      review_notes: [],
      import_notes: ["“Settled” mapped to status paid."],
      source_rows: [7],
    },
  ],
};

const MOCK_CHAT: ChatResponse = {
  answer:
    "Across the six invoices, Cedar & Locke Design is the largest spend at EUR 4,998.00, followed by Northwind Supply Co. at USD 3,736.80 and Orion Cloud Services at USD 2,160.00.",
  sql_query_used:
    "SELECT vendor_name, currency, SUM(total) AS spend\nFROM invoices\nGROUP BY vendor_name, currency\nORDER BY spend DESC\nLIMIT 50",
};

let nextId = 100;

/** Small delay so loading states are visible while working offline. */
function delay<T>(value: T, ms = 320): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const IMPORT_SUFFIXES = [".csv", ".json", ".xlsx"];

/** Same match as the backend: vendor, invoice number, email or PO, case-insensitive. */
function matchesSearch(row: InvoiceOut, needle: string): boolean {
  const haystack = [row.vendor_name, row.invoice_number, row.vendor_email, row.po_number];
  return haystack.some((value) => (value ?? "").toLowerCase().includes(needle));
}

function sortValue(row: InvoiceOut, field: NonNullable<InvoiceQuery["sort"]>): string | number {
  if (field === "total") return row.total;
  if (field === "vendor_name") return row.vendor_name.toLowerCase();
  return row[field] ?? "";
}

/** Filters, sorts and slices the fixtures the way GET /invoices does server-side. */
function paginate(query: InvoiceQuery): InvoicePage {
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 25;
  const needle = (query.q ?? "").trim().toLowerCase();

  const matches = MOCK_INVOICES.filter((row) => {
    if (needle && !matchesSearch(row, needle)) return false;
    if (query.status && row.status !== query.status) return false;
    if (query.needs_review !== undefined && row.needs_review !== query.needs_review) return false;
    if (query.source && row.source !== query.source) return false;
    return true;
  });

  const field = query.sort ?? "created_at";
  const direction = query.order === "asc" ? 1 : -1;
  const sorted = [...matches].sort((a, b) => {
    const left = sortValue(a, field);
    const right = sortValue(b, field);
    if (left === right) return b.id - a.id;
    return left < right ? -direction : direction;
  });

  const start = (page - 1) * pageSize;
  return { items: sorted.slice(start, start + pageSize), total: sorted.length, page, page_size: pageSize };
}

export const mockApi = {
  health: () => delay(MOCK_HEALTH, 120),
  listInvoices: (query: InvoiceQuery = {}) => delay(paginate(query)),
  chat: (question: string) =>
    delay({ ...MOCK_CHAT, answer: `${MOCK_CHAT.answer} (asked: "${question}")` }, 900),
  /** Mirrors /invoices/ingest: structured exports are mapped, documents are extracted. */
  ingest: (file: File): Promise<IngestPreview> => {
    const name = file.name.toLowerCase();
    const fixture = IMPORT_SUFFIXES.some((suffix) => name.endsWith(suffix))
      ? MOCK_INGEST_IMPORTED
      : MOCK_INGEST_EXTRACTED;
    return delay({ ...structuredClone(fixture), filename: file.name }, 900);
  },
  /** Mirrors the server: creates what it can, skips invoice numbers already stored. */
  bulkCreate: (drafts: InvoiceDraft[], source: IngestSource): Promise<BulkCreateResponse> => {
    const created: InvoiceOut[] = [];
    const skipped: SkippedInvoice[] = [];
    for (const draft of drafts) {
      const { raw_text: _rawText, ...invoice } = draft;
      if (MOCK_INVOICES.some((row) => row.invoice_number === invoice.invoice_number)) {
        skipped.push({
          invoice_number: invoice.invoice_number,
          reason: "An invoice with this number already exists.",
        });
        continue;
      }
      const saved: InvoiceOut = {
        ...invoice,
        id: nextId++,
        needs_review: false,
        review_notes: [],
        source,
        created_at: new Date().toISOString(),
      };
      MOCK_INVOICES.unshift(saved);
      created.push(saved);
    }
    return delay({ created, skipped }, 700);
  },
};
