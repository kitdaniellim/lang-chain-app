interface ReviewBadgeProps {
  notes: string[];
  /** Used to give each disclosure a stable, unique id. */
  invoiceLabel: string;
  /** Import derivations listed under the validation notes in the same disclosure. */
  extraNotes?: string[];
  /** "warn" flags a validation problem; "info" is a neutral note about how a row was built. */
  tone?: "warn" | "info";
}

/** Badge that expands into its notes via a native <details>; used by both invoice tables. */
export function ReviewBadge({
  notes,
  invoiceLabel,
  extraNotes = [],
  tone = "warn",
}: ReviewBadgeProps) {
  const all = [...notes, ...extraNotes];
  const listId = `review-notes-${tone}-${invoiceLabel.replace(/\s+/g, "-")}`;

  return (
    <details className={`review${tone === "info" ? " review--info" : ""}`}>
      <summary className="review__summary" aria-describedby={listId}>
        <span className="review__chevron" aria-hidden="true">
          ›
        </span>
        {tone === "info" ? "Notes" : "Needs review"}
        {all.length > 0 && <span className="numeric">({all.length})</span>}
      </summary>
      {all.length > 0 ? (
        <ul className="review__notes" id={listId}>
          {all.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : (
        <p className="review__notes" id={listId}>
          Flagged for review, but no notes were recorded.
        </p>
      )}
    </details>
  );
}
