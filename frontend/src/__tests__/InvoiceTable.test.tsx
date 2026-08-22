import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MOCK_INVOICES } from "../api/mock";
import { InvoiceTable } from "../components/InvoiceTable";

type TableProps = Parameters<typeof InvoiceTable>[0];

const onClearFilters = vi.fn();

const baseProps: TableProps = {
  invoices: MOCK_INVOICES,
  total: MOCK_INVOICES.length,
  baseTotal: MOCK_INVOICES.length,
  page: 1,
  pageSize: 25,
  loading: false,
  error: null,
  filters: { search: "", status: "", needsReview: false, source: "", sortKey: "newest" },
  filtersActive: false,
  onFilterChange: vi.fn(),
  onClearFilters,
  onPageChange: vi.fn(),
  onPageSizeChange: vi.fn(),
  onRetry: vi.fn(),
  onAddInvoice: vi.fn(),
};

function renderTable(overrides: Partial<TableProps> = {}) {
  return render(<InvoiceTable {...baseProps} {...overrides} />);
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

    // The filter row repeats these words as options, so every count is scoped to the table.
    const table = within(screen.getByRole("table"));
    expect(table.getAllByText("Paid")).toHaveLength(2);
    expect(table.getAllByText("Pending")).toHaveLength(2);
    expect(table.getAllByText("Overdue")).toHaveLength(2);
    expect(table.getAllByText("Needs review")).toHaveLength(1);
    expect(screen.getByRole("columnheader", { name: "Total" })).toBeInTheDocument();
  });

  it("counts filtered rows against the unfiltered total", () => {
    renderTable({ total: 12, baseTotal: 32, filtersActive: true });

    expect(screen.getByText("12 of 32 invoices")).toBeInTheDocument();
  });

  it("offers a way out when the filters match nothing", async () => {
    const user = userEvent.setup();
    renderTable({ invoices: [], total: 0, baseTotal: 32, filtersActive: true });

    expect(screen.getByText("No invoices match these filters.")).toBeInTheDocument();
    const [, inEmptyState] = screen.getAllByRole("button", { name: "Clear filters" });
    await user.click(inEmptyState);
    expect(onClearFilters).toHaveBeenCalled();
  });

  it("keeps the previous rows on screen while the next page loads", () => {
    const { container } = renderTable({ loading: true });

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(container.querySelector(".table-wrap--stale")).toBeTruthy();
  });
});
