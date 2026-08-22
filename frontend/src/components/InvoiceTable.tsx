import type { InvoiceOut } from "../api/types";
import type { InvoiceFilters as Filters } from "../lib/useInvoiceQuery";
import { InvoiceCells, InvoiceHeaderCells } from "./InvoiceCells";
import { InvoiceFilters } from "./InvoiceFilters";
import { TablePager } from "./TablePager";

interface InvoiceTableProps {
  invoices: InvoiceOut[];
  /** Rows matching the current filters; `baseTotal` is the unfiltered count. */
  total: number;
  baseTotal: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: string | null;
  filters: Filters;
  filtersActive: boolean;
  onFilterChange: (patch: Partial<Filters>) => void;
  onClearFilters: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
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

export function InvoiceTable({
  invoices,
  total,
  baseTotal,
  page,
  pageSize,
  loading,
  error,
  filters,
  filtersActive,
  onFilterChange,
  onClearFilters,
  onPageChange,
  onPageSizeChange,
  onRetry,
  onAddInvoice,
  addDisabledReason,
}: InvoiceTableProps) {
  const showingSkeleton = loading && invoices.length === 0;
  // A page in flight keeps the previous rows on screen, dimmed, so nothing jumps.
  const stale = loading && invoices.length > 0;

  function countLabel(): string {
    if (showingSkeleton) return "Loading…";
    if (filtersActive) return `${total} of ${baseTotal} invoices`;
    return `${total} ${total === 1 ? "invoice" : "invoices"}`;
  }

  return (
    <section className="panel" aria-labelledby="invoices-heading">
      <div className="toolbar">
        <h2 className="toolbar__title" id="invoices-heading">
          Invoices
        </h2>
        <p className="toolbar__count" aria-live="polite">
          {countLabel()}
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

      <InvoiceFilters
        filters={filters}
        onChange={onFilterChange}
        onClear={onClearFilters}
        active={filtersActive}
      />

      {addDisabledReason && (
        <p className="notice notice--warn" style={{ margin: "var(--sp-4)" }}>
          {addDisabledReason}
        </p>
      )}

      {showingSkeleton && !error && (
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

      {!showingSkeleton && !error && invoices.length === 0 && (
        <div className="state">
          {filtersActive ? (
            <>
              <p className="state__title">No invoices match these filters.</p>
              <button type="button" className="btn" onClick={onClearFilters}>
                Clear filters
              </button>
            </>
          ) : (
            <>
              <p className="state__title">No invoices yet</p>
              <p>Add one with “Add invoice”, or seed the backend to populate the table.</p>
            </>
          )}
        </div>
      )}

      {!showingSkeleton && !error && invoices.length > 0 && (
        <>
          <div className={`table-wrap${stale ? " table-wrap--stale" : ""}`} aria-busy={stale}>
            <table className="invoices">
              <caption className="visually-hidden">
                Invoices: vendor, number, dates, total, status and source.
              </caption>
              <thead>
                <tr>
                  <InvoiceHeaderCells />
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
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

          <TablePager
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
          />
        </>
      )}
    </section>
  );
}
