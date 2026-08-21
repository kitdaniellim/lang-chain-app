interface ReviewBadgeProps {
  notes: string[];
  /** Used to give each disclosure a stable, unique id. */
  invoiceLabel: string;
}

/** "Needs review" badge that expands into the validation notes via a native <details>. */
export function ReviewBadge({ notes, invoiceLabel }: ReviewBadgeProps) {
  const count = notes.length;
  const listId = `review-notes-${invoiceLabel.replace(/\s+/g, "-")}`;

  return (
    <details className="review">
      <summary className="review__summary" aria-describedby={listId}>
        <span className="review__chevron" aria-hidden="true">
          ›
        </span>
        Needs review
        {count > 0 && <span className="numeric">({count})</span>}
      </summary>
      {count > 0 ? (
        <ul className="review__notes" id={listId}>
          {notes.map((note) => (
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
