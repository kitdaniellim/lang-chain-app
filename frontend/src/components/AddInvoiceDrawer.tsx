import { useEffect, useId, useRef, useState } from "react";
import { ApiError, extractFromFile, extractFromText, saveInvoice } from "../api/client";
import type { ExtractResponse, Invoice, InvoiceDraft, InvoiceStatus, LineItem } from "../api/types";
import { formatMoney, parseNumber } from "../lib/format";
import { ImportPanel } from "./ImportPanel";

interface AddInvoiceDrawerProps {
  open: boolean;
  onClose: () => void;
  /** false disables extraction and explains why (no ANTHROPIC_API_KEY on the server). */
  llmConfigured: boolean;
  onSaved: () => void;
}

type Tab = "paste" | "upload" | "import";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = [".txt", ".md"];
const STATUSES: InvoiceStatus[] = ["pending", "paid", "overdue"];

const PLACEHOLDER = `INVOICE 2026-0042
Acme Fabrication Ltd. — billing@acmefab.example
Date: 2026-08-19   Due: 2026-09-18   PO: PO-90210

25 x CNC bracket, aluminium 6061 @ 18.40   460.00
25 x Powder coating @ 3.60                  90.00
 1 x Tooling setup @ 150.00                150.00

Subtotal 700.00   Tax 56.00   Total due USD 756.00`;

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Unexpected error";
}

function sumLines(lines: LineItem[]): number {
  return lines.reduce((total, line) => total + (Number.isFinite(line.amount) ? line.amount : 0), 0);
}

export function AddInvoiceDrawer({ open, onClose, llmConfigured, onSaved }: AddInvoiceDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const uid = useId();

  const [tab, setTab] = useState<Tab>("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);

  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [draft, setDraft] = useState<Invoice | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The import panel keeps its own state; bumping the key throws it away with the drawer.
  const [importKey, setImportKey] = useState(0);

  // Drive the native dialog from the `open` prop so Esc and the backdrop come for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function resetAll() {
    setTab("paste");
    setText("");
    setFile(null);
    setRawText(null);
    setResult(null);
    setDraft(null);
    setExtractError(null);
    setSaveError(null);
    setExtracting(false);
    setSaving(false);
    setImportKey((key) => key + 1);
  }

  function handleClose() {
    resetAll();
    onClose();
  }

  function patchDraft(patch: Partial<Invoice>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function patchLine(index: number, patch: Partial<LineItem>) {
    setDraft((current) => {
      if (!current) return current;
      const line_items = current.line_items.map((line, i) =>
        i === index ? { ...line, ...patch } : line,
      );
      return { ...current, line_items };
    });
  }

  async function handleExtract() {
    setExtracting(true);
    setExtractError(null);
    setSaveError(null);
    try {
      let response: ExtractResponse;
      if (tab === "paste") {
        response = await extractFromText(text);
        setRawText(text);
      } else {
        if (!file) throw new Error("Choose a file first");
        if (file.size > MAX_UPLOAD_BYTES) throw new Error("File is larger than 2 MB");
        response = await extractFromFile(file);
        const isText = TEXT_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
        setRawText(isText ? await file.text() : null);
      }
      setResult(response);
      setDraft(response.invoice);
    } catch (cause) {
      setExtractError(messageOf(cause));
      setResult(null);
      setDraft(null);
    } finally {
      setExtracting(false);
    }
  }

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload: InvoiceDraft = { ...draft, raw_text: rawText };
      await saveInvoice(payload);
      resetAll();
      onSaved();
      onClose();
    } catch (cause) {
      setSaveError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  const canExtract =
    llmConfigured && !extracting && (tab === "paste" ? text.trim().length >= 20 : Boolean(file));
  const lineTotal = draft ? sumLines(draft.line_items) : 0;

  return (
    <dialog
      className={`drawer${tab === "import" ? " drawer--wide" : ""}`}
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={`${uid}-title`}
      onClose={handleClose}
      onCancel={handleClose}
    >
      <div className="drawer__header">
        <h2 className="drawer__title" id={`${uid}-title`}>
          Add invoice
        </h2>
        <button type="button" className="icon-btn" onClick={handleClose} aria-label="Close drawer">
          ×
        </button>
      </div>

      <div className="drawer__body">
        {!llmConfigured && tab !== "import" && (
          <p className="notice notice--warn" role="status">
            Extraction is unavailable: the server reports no <code>ANTHROPIC_API_KEY</code>. Set the
            key in <code>backend/.env</code> and restart the API to enable “Extract with LangChain”.
          </p>
        )}

        <div className="tabs" role="tablist" aria-label="Invoice input method">
          <button
            type="button"
            role="tab"
            id={`${uid}-tab-paste`}
            className="tab"
            aria-selected={tab === "paste"}
            aria-controls={`${uid}-panel-paste`}
            onClick={() => setTab("paste")}
          >
            Paste text
          </button>
          <button
            type="button"
            role="tab"
            id={`${uid}-tab-upload`}
            className="tab"
            aria-selected={tab === "upload"}
            aria-controls={`${uid}-panel-upload`}
            onClick={() => setTab("upload")}
          >
            Upload file
          </button>
          <button
            type="button"
            role="tab"
            id={`${uid}-tab-import`}
            className="tab"
            aria-selected={tab === "import"}
            aria-controls={`${uid}-panel-import`}
            onClick={() => setTab("import")}
          >
            Import file
          </button>
        </div>

        {tab === "paste" && (
          <div
            className="field"
            role="tabpanel"
            id={`${uid}-panel-paste`}
            aria-labelledby={`${uid}-tab-paste`}
          >
            <label className="field__label" htmlFor={`${uid}-text`}>
              Invoice text
            </label>
            <textarea
              className="textarea"
              id={`${uid}-text`}
              value={text}
              placeholder={PLACEHOLDER}
              onChange={(event) => setText(event.target.value)}
              disabled={!llmConfigured}
            />
            <p className="field__hint">At least 20 characters. Paste the email body or the invoice text.</p>
          </div>
        )}

        {tab === "upload" && (
          <div
            className="field"
            role="tabpanel"
            id={`${uid}-panel-upload`}
            aria-labelledby={`${uid}-tab-upload`}
          >
            <div className="file-drop">
              <label className="field__label" htmlFor={`${uid}-file`}>
                Invoice file
              </label>
              <input
                className="input"
                id={`${uid}-file`}
                type="file"
                accept=".txt,.md,.pdf"
                disabled={!llmConfigured}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <p className="field__hint">.txt, .md or .pdf — 2 MB maximum.</p>
              {file && (
                <p className="field__hint">
                  Selected: <strong>{file.name}</strong> ({Math.ceil(file.size / 1024)} KB)
                </p>
              )}
            </div>
          </div>
        )}

        {/* Kept mounted so switching tabs never throws away a mapped preview. */}
        <div
          role="tabpanel"
          id={`${uid}-panel-import`}
          aria-labelledby={`${uid}-tab-import`}
          hidden={tab !== "import"}
        >
          <ImportPanel key={importKey} uid={`${uid}-import`} onImported={onSaved} />
        </div>

        {tab !== "import" && (
          <div className="chat__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleExtract}
              disabled={!canExtract}
            >
              {extracting ? "Extracting…" : "Extract with LangChain"}
            </button>
            {extracting && (
              <span className="pending" aria-live="polite">
                <span className="pending__dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                Calling the model…
              </span>
            )}
          </div>
        )}

        {extractError && (
          <p className="notice notice--error" role="alert">
            {extractError}
          </p>
        )}

        {result && draft && (
          <>
            <h3 className="section-heading">
              Extracted invoice
              <span className="section-heading__meta">
                <span className="model-chip">model: {result.model}</span>
              </span>
            </h3>

            {result.needs_review ? (
              <div className="notice notice--warn">
                <strong>Needs review — {result.review_notes.length} issue(s)</strong>
                <ul className="review__notes" style={{ marginTop: "var(--sp-2)" }}>
                  {result.review_notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="notice">Validation passed — no issues found.</p>
            )}

            <div className="field-grid">
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-vendor`}>
                  Vendor
                </label>
                <input
                  className="input"
                  id={`${uid}-vendor`}
                  value={draft.vendor_name}
                  onChange={(event) => patchDraft({ vendor_name: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-number`}>
                  Invoice number
                </label>
                <input
                  className="input"
                  id={`${uid}-number`}
                  value={draft.invoice_number}
                  onChange={(event) => patchDraft({ invoice_number: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-email`}>
                  Vendor email
                </label>
                <input
                  className="input"
                  id={`${uid}-email`}
                  type="email"
                  value={draft.vendor_email ?? ""}
                  onChange={(event) => patchDraft({ vendor_email: event.target.value || null })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-po`}>
                  PO number
                </label>
                <input
                  className="input"
                  id={`${uid}-po`}
                  value={draft.po_number ?? ""}
                  onChange={(event) => patchDraft({ po_number: event.target.value || null })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-date`}>
                  Invoice date
                </label>
                <input
                  className="input"
                  id={`${uid}-date`}
                  type="date"
                  value={draft.invoice_date}
                  onChange={(event) => patchDraft({ invoice_date: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-due`}>
                  Due date
                </label>
                <input
                  className="input"
                  id={`${uid}-due`}
                  type="date"
                  value={draft.due_date ?? ""}
                  onChange={(event) => patchDraft({ due_date: event.target.value || null })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-currency`}>
                  Currency
                </label>
                <input
                  className="input"
                  id={`${uid}-currency`}
                  maxLength={3}
                  value={draft.currency}
                  onChange={(event) => patchDraft({ currency: event.target.value.toUpperCase() })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-status`}>
                  Status
                </label>
                <select
                  className="select"
                  id={`${uid}-status`}
                  value={draft.status}
                  onChange={(event) => patchDraft({ status: event.target.value as InvoiceStatus })}
                >
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <h3 className="section-heading">
              Line items
              <span className="section-heading__meta numeric">
                lines total {formatMoney(lineTotal, draft.currency)}
              </span>
            </h3>

            <div className="table-wrap">
              <table className="lines">
                <thead>
                  <tr>
                    <th scope="col">Description</th>
                    <th scope="col" className="col-amount">
                      Qty
                    </th>
                    <th scope="col" className="col-amount">
                      Unit price
                    </th>
                    <th scope="col" className="col-amount">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {draft.line_items.map((line, index) => (
                    <tr key={index}>
                      <td>
                        <label className="visually-hidden" htmlFor={`${uid}-line-${index}-desc`}>
                          Line {index + 1} description
                        </label>
                        <input
                          className="input"
                          id={`${uid}-line-${index}-desc`}
                          value={line.description}
                          onChange={(event) => patchLine(index, { description: event.target.value })}
                        />
                      </td>
                      <td className="col-amount">
                        <label className="visually-hidden" htmlFor={`${uid}-line-${index}-qty`}>
                          Line {index + 1} quantity
                        </label>
                        <input
                          className="input input--number"
                          id={`${uid}-line-${index}-qty`}
                          type="number"
                          step="any"
                          value={line.quantity}
                          onChange={(event) =>
                            patchLine(index, { quantity: parseNumber(event.target.value) })
                          }
                        />
                      </td>
                      <td className="col-amount">
                        <label className="visually-hidden" htmlFor={`${uid}-line-${index}-unit`}>
                          Line {index + 1} unit price
                        </label>
                        <input
                          className="input input--number"
                          id={`${uid}-line-${index}-unit`}
                          type="number"
                          step="any"
                          value={line.unit_price}
                          onChange={(event) =>
                            patchLine(index, { unit_price: parseNumber(event.target.value) })
                          }
                        />
                      </td>
                      <td className="col-amount">
                        <label className="visually-hidden" htmlFor={`${uid}-line-${index}-amount`}>
                          Line {index + 1} amount
                        </label>
                        <input
                          className="input input--number"
                          id={`${uid}-line-${index}-amount`}
                          type="number"
                          step="any"
                          value={line.amount}
                          onChange={(event) =>
                            patchLine(index, { amount: parseNumber(event.target.value) })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="field-grid">
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-subtotal`}>
                  Subtotal
                </label>
                <input
                  className="input input--number"
                  id={`${uid}-subtotal`}
                  type="number"
                  step="any"
                  value={draft.subtotal}
                  onChange={(event) => patchDraft({ subtotal: parseNumber(event.target.value) })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-tax`}>
                  Tax
                </label>
                <input
                  className="input input--number"
                  id={`${uid}-tax`}
                  type="number"
                  step="any"
                  value={draft.tax}
                  onChange={(event) => patchDraft({ tax: parseNumber(event.target.value) })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-total`}>
                  Total
                </label>
                <input
                  className="input input--number"
                  id={`${uid}-total`}
                  type="number"
                  step="any"
                  value={draft.total}
                  onChange={(event) => patchDraft({ total: parseNumber(event.target.value) })}
                />
              </div>
            </div>

            {saveError && (
              <p className="notice notice--error" role="alert">
                {saveError}
              </p>
            )}
          </>
        )}
      </div>

      <div className="drawer__footer">
        <p className="field__hint drawer__footer-spacer">
          {tab === "import"
            ? "Nothing is stored until you press Import; the server re-validates every row."
            : draft
              ? "The server re-validates every field on save."
              : "Extract first, then review the fields before saving."}
        </p>
        <button type="button" className="btn btn--ghost" onClick={handleClose}>
          {tab === "import" ? "Close" : "Cancel"}
        </button>
        {tab !== "import" && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSave}
            disabled={!draft || saving}
          >
            {saving ? "Saving…" : "Save invoice"}
          </button>
        )}
      </div>
    </dialog>
  );
}
