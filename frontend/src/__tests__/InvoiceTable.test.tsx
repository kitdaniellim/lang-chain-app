import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MOCK_INVOICES } from "../api/mock";
import { InvoiceTable } from "../components/InvoiceTable";

function renderTable() {
  return render(
    <InvoiceTable
      invoices={MOCK_INVOICES}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onAddInvoice={vi.fn()}
    />,
  );
}

describe("InvoiceTable", () => {
  it("renders the needs-review row with its badge, notes and status pill", () => {
    renderTable();

    const row = screen.getByRole("row", { name: /Vantage Print Werks/i });
    expect(within(row).getByText("Needs review")).toBeInTheDocument();
    expect(within(row).getByText("Overdue")).toBeInTheDocument();
    expect(
      within(row).getByText(/Line items sum to 567\.00 but the subtotal reads 600\.00\./),
    ).toBeInTheDocument();
    expect(
      within(row).getByText(/Due date 2026-06-15 is before the invoice date 2026-06-30\./),
    ).toBeInTheDocument();
  });

  it("labels every status pill and only badges rows that need review", () => {
    renderTable();

    expect(screen.getAllByText("Paid")).toHaveLength(2);
    expect(screen.getAllByText("Pending")).toHaveLength(2);
    expect(screen.getAllByText("Overdue")).toHaveLength(2);
    expect(screen.getAllByText("Needs review")).toHaveLength(1);
    expect(screen.getByRole("columnheader", { name: "Total" })).toBeInTheDocument();
  });
});
