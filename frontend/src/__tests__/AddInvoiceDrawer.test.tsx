import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_INGEST_EXTRACTED, MOCK_INGEST_IMPORTED } from "../api/mock";
import type { IngestPreview } from "../api/types";
import { AddInvoiceDrawer } from "../components/AddInvoiceDrawer";

// Only the network layer is faked; the drawer, preview table and formatting run for real.
vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, ingestFile: vi.fn(), bulkCreate: vi.fn() };
});

const { bulkCreate, ingestFile } = await import("../api/client");

const onSaved = vi.fn();

function renderDrawer() {
  return render(<AddInvoiceDrawer open onClose={vi.fn()} llmConfigured onSaved={onSaved} />);
}

const csv = () => new File(["Supplier,Inv No\n"], "ledger-export-aug.csv", { type: "text/csv" });

/** Drops a file on the dropzone and waits for the previewed rows. */
async function ingest(file = csv()) {
  const user = userEvent.setup();
  const view = renderDrawer();
  await user.upload(screen.getByLabelText("Invoice file"), file);
  await screen.findByRole("table", { name: /Invoices found in/i });
  return { user, ...view };
}

describe("AddInvoiceDrawer", () => {
  beforeEach(() => {
    onSaved.mockClear();
    vi.mocked(ingestFile).mockReset();
    vi.mocked(ingestFile).mockResolvedValue(structuredClone(MOCK_INGEST_IMPORTED));
    vi.mocked(bulkCreate).mockReset();
  });

  it("starts extracting on file choice and shows the skeleton until the rows land", async () => {
    let release: (preview: IngestPreview) => void = () => {};
    vi.mocked(ingestFile).mockImplementation(
      () => new Promise<IngestPreview>((resolve) => (release = resolve)),
    );

    const user = userEvent.setup();
    const { container } = renderDrawer();
    await user.upload(screen.getByLabelText("Invoice file"), csv());

    // No "Extract" button was pressed: choosing the file is what starts the work.
    expect(ingestFile).toHaveBeenCalledTimes(1);
    await screen.findAllByText("Reading file");
    expect(container.querySelectorAll(".skeleton-cell").length).toBeGreaterThan(0);
    expect(screen.queryByRole("table", { name: /Invoices found in/i })).not.toBeInTheDocument();

    await act(async () => release(structuredClone(MOCK_INGEST_IMPORTED)));

    const preview = await screen.findByRole("table", { name: /Invoices found in/i });
    expect(container.querySelectorAll(".skeleton-cell")).toHaveLength(0);
    expect(within(preview).getAllByRole("rowheader")).toHaveLength(3);
    expect(container.querySelector(".ingest-summary")).toHaveTextContent(
      "3 invoices found in ledger-export-aug.csv. 1 needs review.",
    );
  });

  it("renders preview rows with the invoice table's own columns and badges", async () => {
    const { container } = await ingest();

    const preview = screen.getByRole("table", { name: /Invoices found in/i });
    for (const column of ["Vendor", "Invoice #", "Date", "Due", "Total", "Status"]) {
      expect(within(preview).getByRole("columnheader", { name: column })).toBeInTheDocument();
    }

    const flagged = within(preview).getByRole("row", { name: /KF-2026-118/ });
    expect(within(flagged).getByText("Needs review")).toBeInTheDocument();
    expect(within(flagged).getByText(/Line items sum to 1068\.40/)).toBeInTheDocument();
    expect(within(flagged).getByText("Overdue")).toBeInTheDocument();

    // The mapping Claude produced stays available, collapsed.
    expect(screen.getByText("Mapped by Claude (claude-sonnet-5)")).toBeInTheDocument();
    const mapping = container.querySelector(".mapping") as HTMLElement;
    const rowFor = (field: string) =>
      within(mapping).getByText(field).closest("tr") as HTMLElement;
    expect(rowFor("Invoice number")).toHaveTextContent("Inv No");
    expect(rowFor("Currency default")).toHaveTextContent("GBP");
    expect(within(mapping).queryByText("PO number")).not.toBeInTheDocument();
    expect(screen.getByText("Cost Centre")).toBeInTheDocument();
  });

  it("counts the selection in the save button", async () => {
    const { user } = await ingest();

    expect(screen.getByRole("button", { name: "Save 3 invoices" })).toBeEnabled();

    await user.click(screen.getByRole("checkbox", { name: "Include KF-2026-118" }));
    expect(screen.getByRole("button", { name: "Save 2 of 3" })).toBeInTheDocument();

    // The header checkbox re-selects everything, then clears the whole selection.
    await user.click(screen.getByRole("checkbox", { name: "Include all invoices" }));
    expect(screen.getByRole("button", { name: "Save 3 invoices" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Include all invoices" }));
    expect(screen.getByRole("button", { name: "Save 0 of 3" })).toBeDisabled();
  });

  it("saves the selected rows as an import and reports what landed", async () => {
    vi.mocked(bulkCreate).mockResolvedValue({ created: [], skipped: [] });
    const { user } = await ingest();

    await user.click(screen.getByRole("checkbox", { name: "Include KF-2026-118" }));
    await user.click(screen.getByRole("button", { name: "Save 2 of 3" }));

    const [drafts, source] = vi.mocked(bulkCreate).mock.calls[0];
    expect(drafts.map((draft) => draft.invoice_number)).toEqual(["MTL-4820", "WC-0912"]);
    expect(source).toBe("imported");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Saved 0 invoices.")).toBeInTheDocument();
  });

  it("sends a document as an upload, with its source text attached", async () => {
    vi.mocked(ingestFile).mockResolvedValue(structuredClone(MOCK_INGEST_EXTRACTED));
    vi.mocked(bulkCreate).mockResolvedValue({ created: [], skipped: [] });

    const { user, container } = await ingest(
      new File(["INVOICE 42"], "acme.txt", { type: "text/plain" }),
    );

    expect(container.querySelector(".ingest-summary")).toHaveTextContent(
      "1 invoice found in acme-2026-0042.txt.",
    );
    await user.click(screen.getByRole("button", { name: "Save invoice" }));

    const [drafts, source] = vi.mocked(bulkCreate).mock.calls[0];
    expect(source).toBe("uploaded");
    expect(drafts[0].raw_text).toContain("Acme Fabrication Ltd.");
  });

  it("refuses a dropped file the API cannot read, without calling the server", async () => {
    const { container } = renderDrawer();
    const dropzone = container.querySelector(".dropzone") as HTMLElement;

    // Dropping bypasses the input's accept filter, so the guard has to run in the drawer.
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(["x"], "scan.png", { type: "image/png" })] },
    });

    expect(ingestFile).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot read scan.png. Upload a PDF, text, CSV, JSON or Excel file.",
    );
  });

  it("highlights the dropzone while a file is dragged over it", () => {
    const { container } = renderDrawer();
    const dropzone = container.querySelector(".dropzone") as HTMLElement;

    fireEvent.dragEnter(dropzone);
    expect(dropzone.className).toContain("dropzone--over");
    fireEvent.dragLeave(dropzone);
    expect(dropzone.className).not.toContain("dropzone--over");
  });
});
