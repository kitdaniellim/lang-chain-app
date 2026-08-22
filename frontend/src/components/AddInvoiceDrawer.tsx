import { useEffect, useId, useRef, useState } from "react";
import { ApiError, bulkCreate, ingestFile } from "../api/client";
import type { BulkCreateResponse, IngestPreview, InvoiceDraft } from "../api/types";
import { IngestDropzone } from "./IngestDropzone";
import { IngestPreviewTable } from "./IngestPreviewTable";
import { InvoiceHeaderCells } from "./InvoiceCells";
import { FileIcon } from "./icons";

interface AddInvoiceDrawerProps {
  open: boolean;
  onClose: () => void;
  /** false disables document extraction and says why (no ANTHROPIC_API_KEY on the server). */
  llmConfigured: boolean;
  onSaved: () => void;
}

/** idle: the dropzone. working: skeleton. ready: preview. failed: the dropzone stays collapsed. */
type Phase = "idle" | "working" | "ready" | "failed" | "saving" | "saved";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const IMPORT_SUFFIXES = [".csv", ".json", ".xlsx"];
const DOCUMENT_SUFFIXES = [".pdf", ".txt", ".md"];
/** How long the first status line stays up before the model phase replaces it. */
const MODEL_STEP_DELAY_MS = 300;
/** How long the saved summary stays up before the drawer closes itself. */
const AUTOCLOSE_MS = 900;

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Unexpected error";
}

function isImport(name: string): boolean {
  return IMPORT_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));
}

function isDocument(name: string): boolean {
  return DOCUMENT_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** "Save invoice" / "Save 3 invoices" / "Save 2 of 3". */
function saveLabel(count: number, total: number): string {
  if (count === total) return total === 1 ? "Save invoice" : `Save ${total} invoices`;
  return `Save ${count} of ${total}`;
}

/** "3 invoices found in odd_export.json. 1 needs review." */
function summaryLine(preview: IngestPreview): string {
  const total = preview.invoices.length;
  const flagged = preview.invoices.filter((draft) => draft.needs_review).length;
  const found = `${total} ${total === 1 ? "invoice" : "invoices"} found in ${preview.filename}.`;
  return flagged > 0 ? `${found} ${flagged} ${flagged === 1 ? "needs" : "need"} review.` : found;
}

function savedLine(result: BulkCreateResponse): string {
  const created = result.created.length;
  return `Saved ${created} ${created === 1 ? "invoice" : "invoices"}.`;
}

/** Three shimmering rows on the real column grid, so the preview does not jump when it lands. */
function PreviewSkeleton() {
  return (
    <div className="table-wrap" aria-hidden="true">
      <table className="invoices preview-table">
        <thead>
          <tr>
            <th scope="col" className="col-check" />
            <InvoiceHeaderCells />
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2].map((row) => (
            <tr key={row}>
              <td className="col-check">
                <span className="skeleton-cell" style={{ width: "16px" }} />
              </td>
              <td>
                <span className="skeleton-cell" style={{ width: "72%" }} />
              </td>
              <td>
                <span className="skeleton-cell" style={{ width: "64px" }} />
              </td>
              <td>
                <span className="skeleton-cell" style={{ width: "72px" }} />
              </td>
              <td>
                <span className="skeleton-cell" style={{ width: "72px" }} />
              </td>
              <td className="col-amount">
                <span className="skeleton-cell" style={{ width: "64px" }} />
              </td>
              <td>
                <span className="skeleton-cell" style={{ width: "60px" }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AddInvoiceDrawer({ open, onClose, llmConfigured, onSaved }: AddInvoiceDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const uid = useId();

  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState("");
  const [preview, setPreview] = useState<IngestPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkCreateResponse | null>(null);

  const stepTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  // Drive the native dialog from the `open` prop so Esc and the backdrop come for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    return () => {
      window.clearTimeout(stepTimer.current);
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  function resetAll() {
    window.clearTimeout(stepTimer.current);
    window.clearTimeout(closeTimer.current);
    setPhase("idle");
    setFile(null);
    setStep("");
    setPreview(null);
    setSelected(new Set());
    setError(null);
    setResult(null);
  }

  function handleClose() {
    resetAll();
    onClose();
  }

  /** Auto-triggered by the dropzone: validate locally, then ingest with no further clicks. */
  async function handleFile(chosen: File) {
    window.clearTimeout(stepTimer.current);
    setFile(chosen);
    setPreview(null);
    setResult(null);
    setError(null);

    const document = isDocument(chosen.name);
    if (!document && !isImport(chosen.name)) {
      setStep("");
      setPhase("failed");
      setError(`Cannot read ${chosen.name}. Upload a PDF, text, CSV, JSON or Excel file.`);
      return;
    }
    if (chosen.size > MAX_UPLOAD_BYTES) {
      setStep("");
      setPhase("failed");
      setError(`${chosen.name} is ${formatBytes(chosen.size)}, which is over the 2 MB limit.`);
      return;
    }

    setPhase("working");
    setStep("Reading file");
    stepTimer.current = window.setTimeout(() => {
      setStep(document ? "Claude is reading the invoice" : "Claude is mapping the columns");
    }, MODEL_STEP_DELAY_MS);

    try {
      const response = await ingestFile(chosen);
      setPreview(response);
      setSelected(new Set(response.invoices.map((_, index) => index)));
      setPhase("ready");
    } catch (cause) {
      setError(messageOf(cause));
      setPhase("failed");
    } finally {
      window.clearTimeout(stepTimer.current);
      setStep("");
    }
  }

  async function handleSave() {
    if (!preview) return;
    const drafts: InvoiceDraft[] = preview.invoices
      .filter((_, index) => selected.has(index))
      // The document text belongs on the extracted draft; exports have none.
      .map((draft) => ({ ...draft.invoice, raw_text: preview.raw_text }));
    if (drafts.length === 0) return;

    setPhase("saving");
    setError(null);
    try {
      const response = await bulkCreate(
        drafts,
        preview.kind === "extracted" ? "uploaded" : "imported",
      );
      setResult(response);
      setPhase("saved");
      onSaved();
      closeTimer.current = window.setTimeout(handleClose, AUTOCLOSE_MS);
    } catch (cause) {
      setError(messageOf(cause));
      setPhase("ready");
    }
  }

  function toggleRow(index: number) {
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
  const showPreview = preview !== null && phase !== "idle" && phase !== "working";
  const announcement = step || (showPreview && preview ? summaryLine(preview) : "");

  return (
    <dialog
      className={`drawer${phase === "idle" ? "" : " drawer--wide"}`}
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={`${uid}-title`}
      onClose={handleClose}
      onCancel={handleClose}
      // While the saved summary is up, any click dismisses instead of waiting out the timer.
      onClick={phase === "saved" ? handleClose : undefined}
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
        <p className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>

        {phase === "idle" && (
          <IngestDropzone
            onFile={handleFile}
            llmConfigured={llmConfigured}
            inputId={`${uid}-file`}
          />
        )}

        {phase !== "idle" && file && (
          <div className="filerow">
            <FileIcon className="filerow__icon" size={20} />
            <span className="filerow__name">{file.name}</span>
            <span className="filerow__size numeric">{formatBytes(file.size)}</span>
            <button
              type="button"
              className="btn btn--text"
              onClick={resetAll}
              disabled={phase === "saving" || phase === "saved"}
            >
              Choose a different file
            </button>
          </div>
        )}

        {phase === "working" && (
          <>
            <p className="status-line">
              <span className="pending__dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {step}
            </p>
            <PreviewSkeleton />
          </>
        )}

        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}

        {showPreview && preview && (
          <>
            <p className={`ingest-summary${phase === "saved" ? " ingest-summary--done" : ""}`}>
              {phase === "saved" && result ? savedLine(result) : summaryLine(preview)}
            </p>

            {phase === "saved" && result && result.skipped.length > 0 && (
              <ul className="review__notes">
                {result.skipped.map((skip) => (
                  <li key={skip.invoice_number}>
                    Skipped {skip.invoice_number}: {skip.reason}
                  </li>
                ))}
              </ul>
            )}

            <IngestPreviewTable
              preview={preview}
              selected={selected}
              onToggleRow={toggleRow}
              onToggleAll={toggleAll}
              animate={phase === "ready"}
            />
          </>
        )}
      </div>

      <div className="drawer__footer">
        <p className="field__hint drawer__footer-spacer">
          {phase === "saved"
            ? "The table behind is up to date."
            : showPreview
              ? "Nothing is stored until you save. The server re-validates every row."
              : "Pick a file and extraction starts on its own."}
        </p>
        <button type="button" className="btn btn--ghost" onClick={handleClose}>
          {phase === "saved" ? "Close" : "Cancel"}
        </button>
        {showPreview && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSave}
            disabled={selected.size === 0 || phase === "saving" || phase === "saved"}
          >
            {phase === "saving" && <span className="spinner" aria-hidden="true" />}
            {phase === "saving" ? "Saving" : phase === "saved" ? "Saved" : saveLabel(selected.size, total)}
          </button>
        )}
      </div>
    </dialog>
  );
}
