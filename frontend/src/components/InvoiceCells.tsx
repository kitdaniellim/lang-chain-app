// The invoice columns, defined once so the stored table and the drawer preview match exactly.

import type { Invoice } from "../api/types";
import { formatDate, formatMoney } from "../lib/format";
import { ReviewBadge } from "./ReviewBadge";
import { StatusPill } from "./StatusPill";

/** Header cells shared by both tables; each table adds its own leading/trailing columns. */
export function InvoiceHeaderCells() {
  return (
    <>
      <th scope="col">Vendor</th>
      <th scope="col">Invoice #</th>
      <th scope="col">Date</th>
      <th scope="col">Due</th>
      <th scope="col" className="col-amount">
        Total
      </th>
      <th scope="col">Status</th>
    </>
  );
}

interface InvoiceCellsProps {
  invoice: Invoice;
  needsReview: boolean;
  reviewNotes: string[];
  /** Import derivations, shown inside the same expandable as the review notes. */
  importNotes?: string[];
  /** Stable id so each row's disclosure keeps its own state. */
  rowKey: string;
}

/** The six body cells of one invoice row, from vendor through to the status pill. */
export function InvoiceCells({
  invoice,
  needsReview,
  reviewNotes,
  importNotes = [],
  rowKey,
}: InvoiceCellsProps) {
  return (
    <>
      <th scope="row" className="cell-vendor">
        {invoice.vendor_name}
        {invoice.vendor_email && <span className="cell-vendor__email">{invoice.vendor_email}</span>}
      </th>
      <td className="cell-ref">{invoice.invoice_number}</td>
      <td className="cell-date">{formatDate(invoice.invoice_date)}</td>
      <td className="cell-date">{formatDate(invoice.due_date)}</td>
      <td className="col-amount">{formatMoney(invoice.total, invoice.currency)}</td>
      <td>
        <div className="cell-status">
          <StatusPill status={invoice.status} />
          {needsReview && (
            <ReviewBadge notes={reviewNotes} extraNotes={importNotes} invoiceLabel={rowKey} />
          )}
          {/* A clean row still carries its import derivations, just in a neutral tone. */}
          {!needsReview && importNotes.length > 0 && (
            <ReviewBadge notes={importNotes} invoiceLabel={rowKey} tone="info" />
          )}
        </div>
      </td>
    </>
  );
}
