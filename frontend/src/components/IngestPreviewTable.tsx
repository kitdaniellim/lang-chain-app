// The previewed rows and the "how did we get here" disclosures for one ingested file.

import type { ColumnMapping, DateFormatHint, IngestPreview, RowGranularity } from "../api/types";
import { InvoiceCells, InvoiceHeaderCells } from "./InvoiceCells";

interface IngestPreviewTableProps {
  preview: IngestPreview;
  /** Indexes of the rows that will be saved. */
  selected: Set<number>;
  onToggleRow: (index: number) => void;
  onToggleAll: () => void;
  /** Rows animate in once, on arrival; a saved preview must not replay the stagger. */
  animate: boolean;
}

const STAGGERED_ROWS = 6;

const GRANULARITY_SENTENCE: Record<RowGranularity, string> = {
  invoice: "One row per invoice",
  line_item: "One row per line item, grouped by invoice number",
};

const DATE_FORMAT_LABELS: Record<DateFormatHint, string> = {
  ISO: "ISO, as in 2026-08-04",
  DMY: "DMY, day/month/year",
  MDY: "MDY, month/day/year",
  YMD: "YMD, year/month/day",
  unknown: "unknown, parsed leniently",
};

/** Mapping fields that name a source column, in the order they are shown. */
const MAPPED_FIELDS: [keyof ColumnMapping, string][] = [
  ["invoice_number", "Invoice number"],
  ["vendor_name", "Vendor"],
  ["vendor_email", "Vendor email"],
  ["invoice_date", "Invoice date"],
  ["due_date", "Due date"],
  ["currency", "Currency"],
  ["status", "Status"],
  ["subtotal", "Subtotal"],
  ["tax", "Tax"],
  ["total", "Total"],
  ["po_number", "PO number"],
  ["line_item_description", "Line description"],
  ["line_item_quantity", "Line quantity"],
  ["line_item_unit_price", "Line unit price"],
  ["line_item_amount", "Line amount"],
  ["line_items_json", "Line items (JSON)"],
];

interface MappingRow {
  key: string;
  label: string;
  value: string;
}

/** Granularity as a sentence, then every non-null column, then the literal settings. */
function mappingRows(mapping: ColumnMapping): MappingRow[] {
  const rows: MappingRow[] = [
    { key: "granularity", label: "Rows", value: GRANULARITY_SENTENCE[mapping.granularity] },
  ];
  for (const [field, label] of MAPPED_FIELDS) {
    const column = mapping[field];
    if (typeof column === "string" && column.trim()) rows.push({ key: field, label, value: column });
  }
  if (mapping.currency_default) {
    rows.push({
      key: "currency_default",
      label: "Currency default",
      value: `${mapping.currency_default}, assumed because there is no currency column`,
    });
  }
  rows.push({
    key: "date_format",
    label: "Date format",
    value: DATE_FORMAT_LABELS[mapping.date_format] ?? mapping.date_format,
  });
  const translations = Object.entries(mapping.status_values ?? {});
  if (translations.length > 0) {
    rows.push({
      key: "status_values",
      label: "Status values",
      value: translations.map(([raw, status]) => `${raw} → ${status}`).join(", "),
    });
  }
  return rows;
}

export function IngestPreviewTable({
  preview,
  selected,
  onToggleRow,
  onToggleAll,
  animate,
}: IngestPreviewTableProps) {
  const total = preview.invoices.length;
  const allSelected = total > 0 && selected.size === total;
  const mappedByClaude = preview.mapping_source === "claude";

  return (
    <>
      {preview.warnings.length > 0 && (
        <div className="notice notice--warn">
          <strong>
            {preview.warnings.length} {preview.warnings.length === 1 ? "warning" : "warnings"}
          </strong>
          <ul className="review__notes" style={{ marginTop: "var(--sp-2)" }}>
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.mapping && (
        <details className="disclosure">
          <summary className="disclosure__summary">
            <span className="disclosure__chevron" aria-hidden="true">
              ›
            </span>
            How the columns were mapped
            <span className={`model-chip${mappedByClaude ? "" : " model-chip--muted"}`}>
              {mappedByClaude
                ? `Mapped by Claude (${preview.model ?? "unknown model"})`
                : "Mapped heuristically"}
            </span>
          </summary>

          <div className="disclosure__body">
            <div className="table-wrap">
              <table className="lines mapping">
                <caption className="visually-hidden">
                  How each invoice field was matched to a column of {preview.filename}.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Invoice field</th>
                    <th scope="col">Source column</th>
                  </tr>
                </thead>
                <tbody>
                  {mappingRows(preview.mapping).map((row) => (
                    <tr key={row.key}>
                      <th scope="row" className="mapping__field">
                        {row.label}
                      </th>
                      <td className="mapping__column">{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.mapping.notes.length > 0 && (
              <div className="import-notes">
                <p className="field__label">Mapping notes</p>
                <ul className="review__notes">
                  {preview.mapping.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            )}

            {preview.unmapped_columns.length > 0 && (
              <div className="import-notes">
                <p className="field__label">Unmapped columns</p>
                <ul className="review__notes">
                  {preview.unmapped_columns.map((column) => (
                    <li key={column}>{column}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}

      {preview.raw_text && (
        <details className="disclosure">
          <summary className="disclosure__summary">
            <span className="disclosure__chevron" aria-hidden="true">
              ›
            </span>
            Source text
            <span className="model-chip">
              {preview.model ? `Read by Claude (${preview.model})` : "Read by Claude"}
            </span>
          </summary>
          <div className="disclosure__body">
            <pre className="raw-text">{preview.raw_text}</pre>
          </div>
        </details>
      )}

      <div className="table-wrap">
        <table className="invoices preview-table">
          <caption className="visually-hidden">
            Invoices found in {preview.filename}; untick any row to leave it out.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="col-check">
                <label className="check">
                  <input
                    type="checkbox"
                    aria-label="Include all invoices"
                    checked={allSelected}
                    ref={(node) => {
                      if (node) node.indeterminate = selected.size > 0 && !allSelected;
                    }}
                    onChange={onToggleAll}
                  />
                </label>
              </th>
              <InvoiceHeaderCells />
            </tr>
          </thead>
          <tbody>
            {preview.invoices.map((draft, index) => {
              const rowKey = `preview-${index}-${draft.invoice.invoice_number}`;
              const staggered = animate && index < STAGGERED_ROWS;
              return (
                <tr
                  key={rowKey}
                  className={staggered ? "preview-row" : undefined}
                  style={staggered ? { animationDelay: `calc(${index} * var(--stagger))` } : undefined}
                >
                  <td className="col-check">
                    <label className="check">
                      <input
                        type="checkbox"
                        aria-label={`Include ${draft.invoice.invoice_number}`}
                        checked={selected.has(index)}
                        onChange={() => onToggleRow(index)}
                      />
                    </label>
                  </td>
                  <InvoiceCells
                    invoice={draft.invoice}
                    needsReview={draft.needs_review}
                    reviewNotes={draft.review_notes}
                    importNotes={draft.import_notes}
                    rowKey={rowKey}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
