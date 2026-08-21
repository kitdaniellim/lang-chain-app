import type { InvoiceOut } from "../api/types";
import { formatDate, formatMoney } from "../lib/format";
import { ReviewBadge } from "./ReviewBadge";
import { StatusPill } from "./StatusPill";

interface InvoiceTableProps {
  invoices: InvoiceOut[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onAddInvoice: () => void;
  /** When set, "Add invoice" is disabled and this explains why. */
  addDisabledReason?: string | null;
}

const SOURCE_LABELS: Record<InvoiceOut["source"], string> = {
  seed: "seed",
  extracted: "extracted",
  "seed-fallback": "seed (fallback)",
  uploaded: "uploaded",
  imported: "imported",
};

/** Newest invoice date first; ties broken by id so the order never flickers. */
function byDateDesc(a: InvoiceOut, b: InvoiceOut): number {
  if (a.invoice_date === b.invoice_date) return b.id - a.id;
  return a.invoice_date < b.invoice_date ? 1 : -1;
}

export function InvoiceTable({
  invoices,
  loading,
  error,
  onRetry,
  onAddInvoice,
  addDisabledReason,
}: InvoiceTableProps) {
  const rows = [...invoices].sort(byDateDesc);
  const showingSkeleton = loading && invoices.length === 0;

  return (
    <section className="panel" aria-labelledby="invoices-heading">
      <div className="toolbar">
        <h2 className="toolbar__title" id="invoices-heading">
          Invoices
        </h2>
        <p className="toolbar__count" aria-live="polite">
          {showingSkeleton
            ? "Loading…"
            : `${rows.length} ${rows.length === 1 ? "invoice" : "invoices"}`}
          {loading && invoices.length > 0 ? " · refreshing…" : ""}
        </p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={onAddInvoice}
          disabled={Boolean(addDisabledReason)}
          title={addDisabledReason ?? undefined}
        >
          Add invoice
        </button>
      </div>

      {addDisabledReason && (
        <p className="notice notice--warn" style={{ margin: "var(--sp-4)" }}>
          {addDisabledReason}
        </p>
      )}

      {showingSkeleton && (
        <div className="skeleton-rows" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <div className="skeleton-row" key={index} />
          ))}
        </div>
      )}

      {!showingSkeleton && error && (
        <div className="state state--error" role="alert">
          <p className="state__title">Could not load invoices</p>
          <p>{error}</p>
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}

      {!showingSkeleton && !error && rows.length === 0 && (
        <div className="state">
          <p className="state__title">No invoices yet</p>
          <p>Add one with “Add invoice”, or seed the backend to populate the table.</p>
        </div>
      )}

      {!showingSkeleton && !error && rows.length > 0 && (
        <div className="table-wrap">
          <table className="invoices">
            <caption className="visually-hidden">
              Invoices, newest first: vendor, number, dates, total, status and source.
            </caption>
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Invoice #</th>
                <th scope="col">Date</th>
                <th scope="col">Due</th>
                <th scope="col" className="col-amount">
                  Total
                </th>
                <th scope="col">Status</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((invoice) => (
                <tr key={invoice.id}>
                  <th scope="row" className="cell-vendor">
                    {invoice.vendor_name}
                    {invoice.vendor_email && (
                      <span className="cell-vendor__email">{invoice.vendor_email}</span>
                    )}
                  </th>
                  <td className="cell-ref">{invoice.invoice_number}</td>
                  <td className="cell-date">{formatDate(invoice.invoice_date)}</td>
                  <td className="cell-date">{formatDate(invoice.due_date)}</td>
                  <td className="col-amount">{formatMoney(invoice.total, invoice.currency)}</td>
                  <td>
                    <div className="cell-status">
                      <StatusPill status={invoice.status} />
                      {invoice.needs_review && (
                        <ReviewBadge
                          notes={invoice.review_notes}
                          invoiceLabel={String(invoice.id)}
                        />
                      )}
                    </div>
                  </td>
                  <td>
                    <span className="tag-source">{SOURCE_LABELS[invoice.source] ?? invoice.source}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
