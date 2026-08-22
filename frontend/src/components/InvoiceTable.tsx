import type { InvoiceOut } from "../api/types";
import { InvoiceCells, InvoiceHeaderCells } from "./InvoiceCells";

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
                <InvoiceHeaderCells />
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((invoice) => (
                <tr key={invoice.id}>
                  <InvoiceCells
                    invoice={invoice}
                    needsReview={invoice.needs_review}
                    reviewNotes={invoice.review_notes}
                    rowKey={String(invoice.id)}
                  />
                  <td>
                    <span className="tag-source">
                      {SOURCE_LABELS[invoice.source] ?? invoice.source}
                    </span>
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
