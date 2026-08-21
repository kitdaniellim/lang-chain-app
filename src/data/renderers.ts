import type { DocumentFormat, Invoice, LineItem } from "../domain/schemas.js";

/** The buyer is constant across the demo corpus. */
const BILL_TO_NAME = "Demo Corp - Accounts Payable";
const BILL_TO_EMAIL = "ap@democorp.example";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Table geometry: "| " + 60 chars of content + " |" = 64. */
const TABLE_WIDTH = 64;
const CONTENT_WIDTH = TABLE_WIDTH - 4;
const TABLE_BORDER = `+${"-".repeat(TABLE_WIDTH - 2)}+`;
const VENDOR_COLUMN = 53;
const DESCRIPTION_COLUMN = 32;

const money = (n: number): string => n.toFixed(2);
const qty = (n: number): string => String(n);
const taxPercent = (rate: number): string => String(Math.round(rate * 100));

/** Split "YYYY-MM-DD"; returns null for anything that is not three parts. */
function isoParts(iso: string): { year: string; month: string; day: string } | null {
  const parts = iso.split("-");
  const [year, month, day] = parts;
  if (parts.length !== 3 || !year || !month || !day) return null;
  return { year, month, day };
}

/** "2026-07-03" -> "03 Jul 2026" */
function longDate(iso: string): string {
  const parts = isoParts(iso);
  if (!parts) return iso;
  return `${parts.day} ${MONTHS[Number(parts.month) - 1] ?? parts.month} ${parts.year}`;
}

/** "2026-07-03" -> "07/03/2026" */
function usDate(iso: string): string {
  const parts = isoParts(iso);
  if (!parts) return iso;
  return `${parts.month}/${parts.day}/${parts.year}`;
}

/** Drops null/undefined entries so optional lines simply disappear. */
function lines(...entries: (string | null)[]): string {
  return entries.filter((entry): entry is string => entry !== null).join("\n");
}

/** Blocks are separated by one blank line; a null block is omitted entirely. */
function blocks(...entries: (string | null)[]): string {
  return `${entries.filter((entry): entry is string => entry !== null).join("\n\n")}\n`;
}

export function renderPlain(invoice: Invoice): string {
  const items = invoice.lineItems
    .map((item, i) => `${i + 1}. ${item.description} - ${qty(item.quantity)} x ${money(item.unitPrice)} = ${money(item.amount)}`)
    .join("\n");

  return blocks(
    "INVOICE",
    lines(
      `Invoice Number: ${invoice.invoiceNumber}`,
      `Invoice Date: ${invoice.issueDate}`,
      invoice.dueDate === null ? null : `Due Date: ${invoice.dueDate}`,
      invoice.poNumber === null ? null : `PO Number: ${invoice.poNumber}`,
      `Currency: ${invoice.currency}`,
    ),
    lines("From:", invoice.vendor.name, invoice.vendor.address, invoice.vendor.email),
    lines("Bill To:", BILL_TO_NAME, BILL_TO_EMAIL),
    `Line Items:\n${items}`,
    lines(
      `Subtotal: ${money(invoice.subtotal)}`,
      `Tax (${taxPercent(invoice.taxRate)}%): ${money(invoice.taxAmount)}`,
      `Total Due: ${money(invoice.total)}`,
    ),
    invoice.notes === null ? null : `Notes: ${invoice.notes}`,
  );
}

export function renderEmail(invoice: Invoice): string {
  const items = invoice.lineItems
    .map((item) => `- ${item.description} | qty ${qty(item.quantity)} | @ ${money(item.unitPrice)} | ${money(item.amount)}`)
    .join("\n");

  return blocks(
    lines(
      `From: ${invoice.vendor.email}`,
      `To: ${BILL_TO_EMAIL}`,
      `Subject: Invoice ${invoice.invoiceNumber} from ${invoice.vendor.name}`,
    ),
    "Hi team,",
    "Please find the details of your invoice below.",
    lines(
      `Invoice #: ${invoice.invoiceNumber}`,
      `Date: ${longDate(invoice.issueDate)}`,
      invoice.dueDate === null ? null : `Due: ${longDate(invoice.dueDate)}`,
      invoice.poNumber === null ? null : `PO: ${invoice.poNumber}`,
      `Currency: ${invoice.currency}`,
    ),
    items,
    lines(
      `Subtotal: ${invoice.currency} ${money(invoice.subtotal)}`,
      `Tax ${taxPercent(invoice.taxRate)}%: ${invoice.currency} ${money(invoice.taxAmount)}`,
      `Amount due: ${invoice.currency} ${money(invoice.total)}`,
    ),
    invoice.notes,
    lines("Regards,", `${invoice.vendor.name} Billing`),
  );
}

/** Pads (or truncates) one row of content into the fixed-width box. */
function tableRow(content: string): string {
  return `| ${content.slice(0, CONTENT_WIDTH).padEnd(CONTENT_WIDTH)} |`;
}

const metaRow = (label: string, value: string): string => tableRow(`${label.padEnd(13)}${value}`);

const itemRow = (item: LineItem): string =>
  tableRow(
    qty(item.quantity).padEnd(6) +
      item.description.slice(0, DESCRIPTION_COLUMN).padEnd(34) +
      money(item.unitPrice).padEnd(10) +
      money(item.amount).padStart(10),
  );

const totalRow = (label: string, amount: number): string =>
  tableRow("".padEnd(40) + label.padEnd(10) + money(amount).padStart(10));

export function renderTable(invoice: Invoice): string {
  const header = invoice.vendor.name.toUpperCase().slice(0, VENDOR_COLUMN).padEnd(VENDOR_COLUMN) + "INVOICE";

  const rows = [
    TABLE_BORDER,
    tableRow(header),
    tableRow(invoice.vendor.address),
    tableRow(invoice.vendor.email),
    TABLE_BORDER,
    metaRow("Invoice No", invoice.invoiceNumber),
    metaRow("Issued", usDate(invoice.issueDate)),
    ...(invoice.dueDate === null ? [] : [metaRow("Due", usDate(invoice.dueDate))]),
    ...(invoice.poNumber === null ? [] : [metaRow("PO", invoice.poNumber)]),
    metaRow("Currency", invoice.currency),
    TABLE_BORDER,
    tableRow("QTY".padEnd(6) + "DESCRIPTION".padEnd(34) + "UNIT".padEnd(10) + "AMOUNT".padStart(10)),
    ...invoice.lineItems.map(itemRow),
    TABLE_BORDER,
    totalRow("SUBTOTAL", invoice.subtotal),
    totalRow(`TAX ${taxPercent(invoice.taxRate)}%`, invoice.taxAmount),
    totalRow("TOTAL", invoice.total),
    TABLE_BORDER,
  ];

  return `${rows.join("\n")}\n`;
}

export function renderDocument(invoice: Invoice, format: DocumentFormat): string {
  switch (format) {
    case "plain":
      return renderPlain(invoice);
    case "email":
      return renderEmail(invoice);
    case "table":
      return renderTable(invoice);
  }
}
