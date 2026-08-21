// Offline fixtures + canned responses so the UI can be built without the backend.
// Enabled by VITE_USE_MOCK=true; the default is off.

import type {
  ChatResponse,
  ExtractResponse,
  HealthResponse,
  InvoiceDraft,
  InvoiceOut,
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
      { description: "Compute — reserved instances (July)", quantity: 1, unit_price: 1840.0, amount: 1840.0 },
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
    line_items: [{ description: "Brand refresh — phase 2", quantity: 1, unit_price: 4200.0, amount: 4200.0 }],
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

const MOCK_EXTRACT: ExtractResponse = {
  invoice: {
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
  },
  needs_review: false,
  review_notes: [],
  model: "claude-sonnet-5",
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

export const mockApi = {
  health: () => delay(MOCK_HEALTH, 120),
  invoices: () => delay([...MOCK_INVOICES]),
  extract: () => delay(structuredClone(MOCK_EXTRACT), 900),
  chat: (question: string) =>
    delay({ ...MOCK_CHAT, answer: `${MOCK_CHAT.answer} (asked: "${question}")` }, 900),
  save: (draft: InvoiceDraft): Promise<InvoiceOut> => {
    const { raw_text: _rawText, ...invoice } = draft;
    const saved: InvoiceOut = {
      ...invoice,
      id: nextId++,
      needs_review: false,
      review_notes: [],
      source: "extracted",
      created_at: new Date().toISOString(),
    };
    MOCK_INVOICES.unshift(saved);
    return delay(saved, 500);
  },
};
