import type { InvoiceStatus } from "../api/types";

const LABELS: Record<InvoiceStatus, string> = {
  paid: "Paid",
  pending: "Pending",
  overdue: "Overdue",
};

/** Colour-coded status pill; the label carries the meaning, colour only reinforces it. */
export function StatusPill({ status }: { status: InvoiceStatus }) {
  const label = LABELS[status] ?? status;
  return <span className={`pill pill--${status}`}>{label}</span>;
}
