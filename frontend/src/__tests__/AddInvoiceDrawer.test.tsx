import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_IMPORT_PREVIEW } from "../api/mock";
import { AddInvoiceDrawer } from "../components/AddInvoiceDrawer";

// Only the network layer is faked; the drawer, panel and formatting run for real.
vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    importFile: vi.fn(),
    bulkCreate: vi.fn(),
    extractFromText: vi.fn(),
    extractFromFile: vi.fn(),
    saveInvoice: vi.fn(),
  };
});

const { importFile } = await import("../api/client");

function renderDrawer() {
  return render(
    <AddInvoiceDrawer open onClose={vi.fn()} llmConfigured onSaved={vi.fn()} />,
  );
}

/** Picks a CSV on the import tab and waits for the mapped preview. */
async function mapFile() {
  const user = userEvent.setup();
  renderDrawer();

  await user.click(screen.getByRole("tab", { name: "Import file" }));
  const input = screen.getByLabelText("Structured file");
  await user.upload(input, new File(["Supplier,Inv No\n"], "ledger-export-aug.csv", { type: "text/csv" }));
  await user.click(screen.getByRole("button", { name: "Map columns with LangChain" }));
  await screen.findByRole("table", { name: /How each invoice field was matched/i });

  return user;
}

describe("AddInvoiceDrawer — import tab", () => {
  beforeEach(() => {
    vi.mocked(importFile).mockResolvedValue(structuredClone(MOCK_IMPORT_PREVIEW));
  });

  it("shows the mapping Claude produced, including the unmapped column", async () => {
    await mapFile();

    expect(screen.getByText("Mapped by Claude (claude-sonnet-5)")).toBeInTheDocument();

    const rowFor = (field: string) =>
      screen.getByRole("rowheader", { name: field }).closest("tr") as HTMLElement;
    expect(rowFor("Rows")).toHaveTextContent("One row per line item, grouped by invoice number");
    expect(rowFor("Invoice number")).toHaveTextContent("Inv No");
    expect(rowFor("Vendor")).toHaveTextContent("Supplier");
    expect(rowFor("Line quantity")).toHaveTextContent("Qty");
    expect(rowFor("Currency default")).toHaveTextContent("GBP");
    expect(rowFor("Date format")).toHaveTextContent("DMY");

    // Nulls in the mapping are simply absent, and the leftover column is listed.
    expect(screen.queryByRole("rowheader", { name: "PO number" })).not.toBeInTheDocument();
    expect(screen.getByText("Unmapped columns").parentElement).toHaveTextContent("Cost Centre");
    expect(screen.getByText(/Dates read as day\/month\/year/)).toBeInTheDocument();
  });

  it("previews every invoice, badges the one that needs review and counts the selection", async () => {
    const user = await mapFile();

    const preview = screen.getByRole("table", { name: /Invoices found in/i });
    expect(within(preview).getAllByRole("rowheader")).toHaveLength(3);

    const flagged = within(preview).getByRole("row", { name: /KF-2026-118/ });
    expect(within(flagged).getByText("Needs review")).toBeInTheDocument();
    expect(within(flagged).getByText(/Line items sum to 1068\.40/)).toBeInTheDocument();
    expect(within(flagged).getByText("rows 5–6")).toBeInTheDocument();
    expect(
      within(flagged).getByText(/Subtotal derived as total − tax/),
    ).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Import 3 of 3" })).toBeEnabled();

    await user.click(screen.getByRole("checkbox", { name: "Include KF-2026-118" }));
    expect(screen.getByRole("button", { name: "Import 2 of 3" })).toBeInTheDocument();

    // The header checkbox re-selects everything, then clears the whole selection.
    await user.click(screen.getByRole("checkbox", { name: "Include all invoices" }));
    expect(screen.getByRole("button", { name: "Import 3 of 3" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Include all invoices" }));
    expect(screen.getByRole("button", { name: "Import 0 of 3" })).toBeDisabled();
  });
});
