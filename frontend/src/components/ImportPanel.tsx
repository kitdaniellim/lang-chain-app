import { useState } from "react";
import { ApiError, bulkCreate, importFile } from "../api/client";
import type {
  BulkCreateResponse,
  ColumnMapping,
  DateFormatHint,
  ImportPreview,
  RowGranularity,
} from "../api/types";
import { formatDate, formatMoney } from "../lib/format";
import { ReviewBadge } from "./ReviewBadge";
import { StatusPill } from "./StatusPill";

interface ImportPanelProps {
  /** Id prefix from the drawer so labels and controls stay unique in the document. */
  uid: string;
  /** Fired after a successful bulk create so the invoice table refreshes. */
  onImported: () => void;
}

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const GRANULARITY_SENTENCE: Record<RowGranularity, string> = {
  invoice: "One row per invoice",
  line_item: "One row per line item, grouped by invoice number",
};

const DATE_FORMAT_LABELS: Record<DateFormatHint, string> = {
  ISO: "ISO — 2026-08-04",
  DMY: "DMY — day/month/year",
  MDY: "MDY — month/day/year",
  YMD: "YMD — year/month/day",
  unknown: "unknown — parsed leniently",
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

/** Granularity as a sentence, then every non-null column, then the two literal settings. */
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
      value: `${mapping.currency_default} (assumed — no currency column)`,
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
      value: translations.map(([raw, status]) => `${raw} → ${status}`).join(" · "),
    });
  }
  return rows;
}

/** "row 7", "rows 2–4" for a contiguous run, otherwise the explicit list. */
function sourceRowsLabel(rows: number[]): string {
  if (rows.length === 0) return "no source rows";
  if (rows.length === 1) return `row ${rows[0]}`;
  const first = rows[0];
  const contiguous = rows.every((row, index) => row === first + index);
  return contiguous ? `rows ${first}–${rows[rows.length - 1]}` : `rows ${rows.join(", ")}`;
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Unexpected error";
}

/** Import tab: map a CSV/JSON/XLSX export with LangChain, review the rows, create them. */
export function ImportPanel({ uid, onImported }: ImportPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkCreateResponse | null>(null);
  const [announcement, setAnnouncement] = useState("");

  async function handleMap() {
    if (!file) return;
    setMapping(true);
    setMapError(null);
    setImportError(null);
    setResult(null);
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("File is larger than 2 MB");
      const response = await importFile(file);
      setPreview(response);
      setSelected(new Set(response.invoices.map((_, index) => index)));
      setAnnouncement(`Mapped ${response.invoices.length} invoices from ${response.filename}`);
    } catch (cause) {
      setMapError(messageOf(cause));
      setPreview(null);
      setSelected(new Set());
    } finally {
      setMapping(false);
    }
  }

  async function handleImport() {
    if (!preview) return;
    const drafts = preview.invoices
      .filter((_, index) => selected.has(index))
      .map((draft) => ({ ...draft.invoice }));
    if (drafts.length === 0) return;

    setImporting(true);
    setImportError(null);
    try {
      const response = await bulkCreate(drafts);
      setResult(response);
      setAnnouncement(
        `Created ${response.created.length} invoices, skipped ${response.skipped.length}.`,
      );
      onImported();
    } catch (cause) {
      setImportError(messageOf(cause));
    } finally {
      setImporting(false);
    }
  }

  function toggleOne(index: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleAll() {
    if (!preview) return;
    setSelected((current) =>
      current.size === preview.invoices.length
        ? new Set()
        : new Set(preview.invoices.map((_, index) => index)),
    );
  }

  const total = preview?.invoices.length ?? 0;
  const allSelected = total > 0 && selected.size === total;
  const badge =
    preview?.mapping_source === "claude"
      ? `Mapped by Claude (${preview.model ?? "unknown model"})`
      : "Mapped heuristically (no API key)";

  return (
    <div className="import">
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <div className="file-drop">
        <label className="field__label" htmlFor={`${uid}-import-file`}>
          Structured file
        </label>
        <input
          className="input"
          id={`${uid}-import-file`}
          type="file"
          accept=".csv,.json,.xlsx"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <p className="field__hint">
          .csv, .json or .xlsx — 2 MB maximum. Claude maps the columns; without an API key the
          server falls back to heuristics.
        </p>
        {file && (
          <p className="field__hint">
            Selected: <strong>{file.name}</strong> ({Math.ceil(file.size / 1024)} KB)
          </p>
        )}
      </div>

      <div className="chat__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={handleMap}
          disabled={!file || mapping}
        >
          {mapping ? "Mapping columns…" : "Map columns with LangChain"}
        </button>
        {mapping && file && (
          <span className="pending" aria-live="polite">
            <span className="pending__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            Reading {file.name}…
          </span>
        )}
      </div>

      {mapError && (
        <p className="notice notice--error" role="alert">
          {mapError}
        </p>
      )}

      {preview && (
        <>
          <h3 className="section-heading">
            Column mapping
            <span className="section-heading__meta">
              <span
                className={`model-chip${preview.mapping_source === "claude" ? "" : " model-chip--muted"}`}
              >
                {badge}
              </span>
            </span>
          </h3>

          <div className="import-card">
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
          </div>

          {preview.warnings.length > 0 && (
            <div className="notice notice--warn">
              <strong>Warnings — {preview.warnings.length}</strong>
              <ul className="review__notes" style={{ marginTop: "var(--sp-2)" }}>
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <h3 className="section-heading">
            Preview
            <span className="section-heading__meta numeric">
              {preview.row_count} rows → {total} {total === 1 ? "invoice" : "invoices"}
            </span>
          </h3>

          <div className="table-wrap">
            <table className="lines import-preview">
              <caption className="visually-hidden">
                Invoices found in {preview.filename}; untick any row to leave it out.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="col-check">
                    <input
                      type="checkbox"
                      aria-label="Include all invoices"
                      checked={allSelected}
                      ref={(node) => {
                        if (node) node.indeterminate = selected.size > 0 && !allSelected;
                      }}
                      onChange={toggleAll}
                    />
                  </th>
                  <th scope="col">Invoice #</th>
                  <th scope="col">Vendor</th>
                  <th scope="col">Date</th>
                  <th scope="col" className="col-amount">
                    Total
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Source rows</th>
                </tr>
              </thead>
              <tbody>
                {preview.invoices.map((draft, index) => {
                  const invoice = draft.invoice;
                  const label = `import-${index}-${invoice.invoice_number}`;
                  return (
                    <tr key={label}>
                      <td className="col-check">
                        <input
                          type="checkbox"
                          aria-label={`Include ${invoice.invoice_number}`}
                          checked={selected.has(index)}
                          onChange={() => toggleOne(index)}
                        />
                      </td>
                      <th scope="row" className="cell-ref">
                        {invoice.invoice_number}
                      </th>
                      <td>{invoice.vendor_name}</td>
                      <td className="cell-date">{formatDate(invoice.invoice_date)}</td>
                      <td className="col-amount">
                        {formatMoney(invoice.total, invoice.currency)}{" "}
                        <span className="cell-ccy">{invoice.currency}</span>
                      </td>
                      <td>
                        <div className="cell-status">
                          <StatusPill status={invoice.status} />
                          {draft.needs_review && (
                            <ReviewBadge notes={draft.review_notes} invoiceLabel={label} />
                          )}
                        </div>
                      </td>
                      <td>
                        <details className="review review--info">
                          <summary className="review__summary">
                            <span className="review__info" aria-hidden="true">
                              ⓘ
                            </span>
                            {sourceRowsLabel(draft.source_rows)}
                          </summary>
                          {draft.import_notes.length > 0 ? (
                            <ul className="review__notes">
                              {draft.import_notes.map((note) => (
                                <li key={note}>{note}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="review__notes">Converted with no assumptions.</p>
                          )}
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="chat__actions">
            <p className="field__hint drawer__footer-spacer">
              Selected rows are created in one request; the server skips duplicates.
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleImport}
              disabled={selected.size === 0 || importing}
            >
              {importing ? "Importing…" : `Import ${selected.size} of ${total}`}
            </button>
          </div>

          {importError && (
            <p className="notice notice--error" role="alert">
              {importError}
            </p>
          )}

          {result && (
            <div className={`notice${result.skipped.length > 0 ? " notice--warn" : ""}`}>
              <strong>
                Created {result.created.length} · Skipped {result.skipped.length}
              </strong>
              {result.skipped.length > 0 && (
                <ul className="review__notes" style={{ marginTop: "var(--sp-2)" }}>
                  {result.skipped.map((skip) => (
                    <li key={skip.invoice_number}>
                      {skip.invoice_number} — {skip.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
