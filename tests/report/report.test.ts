import { describe, expect, it } from "vitest";
import { toCsv } from "../../src/report/csv.js";
import { renderHtmlReport } from "../../src/report/html.js";
import { renderMarkdownReport } from "../../src/report/markdown.js";
import { makeBatchResult, makeProcessed } from "../fixtures/processed.js";

const result = makeBatchResult();

describe("renderHtmlReport", () => {
  const html = renderHtmlReport(result);

  it("includes a title and every invoice number", () => {
    expect(html).toContain("<title>");
    expect(html).toContain(result.batchId);
    for (const p of result.processed) expect(html).toContain(p.invoiceNumber!);
  });

  it("shows stats, decisions and issue codes", () => {
    expect(html).toContain("auto_approved");
    expect(html).toContain("TOTAL_MISMATCH");
    expect(html).toContain("DUPLICATE_IN_BATCH");
    expect(html).toContain("CLOUD_HOSTING");
  });

  it("carries no scripts or external assets", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<link");
  });

  it("escapes HTML-special characters from LLM text", () => {
    expect(html).toContain("&lt;Globex&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<Globex>");
  });

  it("escapes markup smuggled into an extracted field", () => {
    const evil = makeProcessed({
      documentId: "doc-evil",
      invoiceNumber: '<script>alert("x")</script>',
      extracted: { ...makeProcessed().extracted!, vendorName: "<img src=x onerror=1>" },
    });
    const out = renderHtmlReport(makeBatchResult({ processed: [evil] }));
    expect(out).not.toContain("<script>alert");
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;script&gt;");
  });

  it("colours the decision cell inline and lists flagged invoices", () => {
    expect(html).toMatch(/style="[^"]*background/);
    expect(html).toContain("Sent back to the vendor for a corrected invoice.");
    expect(html).toContain("Recommend rejection.");
  });
});

describe("renderMarkdownReport", () => {
  const md = renderMarkdownReport(result);

  it("has a table row per invoice", () => {
    const rows = md.split("\n").filter((l) => l.startsWith("| doc-"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("INV-2026-0417");
  });

  it("includes the batch id, stats and the summary", () => {
    expect(md).toContain(result.batchId);
    expect(md).toContain(result.summary);
    expect(md).toContain("Auto-approved");
  });

  it("escapes pipes so the table survives", () => {
    const piped = makeProcessed({ documentId: "doc-pipe", invoiceNumber: "A|B" });
    const out = renderMarkdownReport(makeBatchResult({ processed: [piped] }));
    expect(out).toContain(String.raw`A\|B`);
  });
});

describe("currency labelling and duration", () => {
  it("names the currency when the batch uses only one", () => {
    const single = makeBatchResult({ processed: [makeProcessed()] });
    expect(renderHtmlReport(single)).toContain("USD 1,765.50");
    expect(renderMarkdownReport(single)).toContain("**USD 216.00**");
    expect(renderMarkdownReport(single)).not.toContain("mixed currencies");
  });

  it("warns that a mixed-currency batch was summed as printed", () => {
    expect(renderHtmlReport(result)).toContain("mixed currencies: USD, EUR");
    expect(renderMarkdownReport(result)).toContain("mixed currencies: USD, EUR — summed as printed");
    expect(renderHtmlReport(result)).not.toContain("USD 1,765.50");
  });

  it("renders n/a rather than NaN for an unparsable duration", () => {
    const broken = makeBatchResult({ finishedAt: "whenever" });
    expect(renderHtmlReport(broken)).toContain("n/a");
    expect(renderMarkdownReport(broken)).toContain("n/a");
    expect(renderHtmlReport(broken)).not.toContain("NaN");
  });
});

describe("toCsv", () => {
  const csv = toCsv(result.processed);
  const lines = csv.trimEnd().split(/\r?\n/);

  it("emits the agreed header plus one row per invoice", () => {
    expect(lines[0]).toBe(
      "documentId,invoiceNumber,vendorName,issueDate,dueDate,currency,total,category,riskLevel,riskScore,decision,decidedBy,issues,provider",
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("doc-001");
  });

  it("quotes values containing commas", () => {
    expect(csv).toContain('"Globex Consulting, LLC"');
    expect(csv).toContain('"TOTAL_MISMATCH,UNKNOWN_VENDOR"');
  });

  it("neutralises a cell a spreadsheet would run as a formula", () => {
    const base = makeProcessed();
    const injected = toCsv([
      makeProcessed({ documentId: "doc-eq", extracted: { ...base.extracted!, vendorName: "=cmd|calc" } }),
      makeProcessed({ documentId: "doc-at", extracted: { ...base.extracted!, vendorName: "  @SUM(A1)" } }),
      makeProcessed({ documentId: "doc-plus", extracted: { ...base.extracted!, vendorName: "+1+1" } }),
    ]);
    expect(injected).toContain("'=cmd|calc");
    expect(injected).toContain("'  @SUM(A1)");
    expect(injected).toContain("'+1+1");
    expect(injected).not.toMatch(/,=cmd/);
  });

  it("quotes a value containing a newline", () => {
    const base = makeProcessed();
    const multiline = makeProcessed({
      documentId: "doc-nl",
      extracted: { ...base.extracted!, vendorName: "Globex\nEurope" },
    });
    const out = toCsv([multiline]);
    expect(out).toContain('"Globex\nEurope"');
    expect(out.trimEnd().split("\r\n")).toHaveLength(2);
  });

  it("doubles embedded quotes per RFC 4180", () => {
    const quoted = makeProcessed({ documentId: 'doc-"q"', invoiceNumber: "INV-1" });
    expect(toCsv([quoted])).toContain('"doc-""q"""');
  });

  it("renders empty cells for missing extraction", () => {
    const bare = makeProcessed({ documentId: "doc-bare", invoiceNumber: null, extracted: null, categorization: null });
    const row = toCsv([bare]).trimEnd().split(/\r?\n/)[1]!;
    expect(row.startsWith("doc-bare,,,,,,,")).toBe(true);
  });
});
