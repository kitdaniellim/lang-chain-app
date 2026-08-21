import { AIMessageChunk } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryLogger } from "../../src/observability/logger.js";
import { createProgressPrinter } from "../../src/observability/progress.js";
import type { ProgressEvent } from "../../src/pipeline/types.js";

function spyStdout() {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return { writes, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createProgressPrinter — custom events", () => {
  it("formats node start/end lines", () => {
    const logger = createMemoryLogger("debug");
    const printer = createProgressPrinter(logger);
    printer.onEvent("custom", { type: "node_start", node: "extract", documentId: "doc-003" } satisfies ProgressEvent);
    printer.onEvent("custom", { type: "node_end", node: "extract", documentId: "doc-003", ms: 412 } satisfies ProgressEvent);

    const out = logger.lines.join("\n");
    expect(out).toContain("▶ extract doc-003");
    expect(out).toContain("✓ extract doc-003 (412 ms)");
  });

  it("formats warn, decision and delivery events", () => {
    const logger = createMemoryLogger("debug");
    const printer = createProgressPrinter(logger);
    printer.onEvent("custom", { type: "warn", message: "low confidence", documentId: "doc-002" } satisfies ProgressEvent);
    printer.onEvent("custom", {
      type: "decision",
      documentId: "doc-002",
      decision: "auto_rejected",
      reason: "duplicate",
    } satisfies ProgressEvent);
    printer.onEvent("custom", { type: "delivery", sink: "file", ok: true, detail: "report.md" } satisfies ProgressEvent);
    printer.onEvent("custom", { type: "info", message: "batch loaded" } satisfies ProgressEvent);

    const out = logger.lines.join("\n");
    expect(out).toContain("⚠ low confidence");
    expect(out).toContain("→ doc-002 auto_rejected");
    expect(out).toContain("✉ file");
    expect(out).toContain("batch loaded");
  });

  it("never prints internal nodes", () => {
    const logger = createMemoryLogger("debug");
    const printer = createProgressPrinter(logger);
    printer.onEvent("custom", { type: "node_start", node: "__start__" } satisfies ProgressEvent);
    printer.onEvent("custom", { type: "node_end", node: "__end__", ms: 1 } satisfies ProgressEvent);
    expect(logger.lines).toHaveLength(0);
  });
});

describe("createProgressPrinter — message tokens", () => {
  it("streams summarize tokens inline and closes the line on finish", () => {
    const { writes } = spyStdout();
    const printer = createProgressPrinter(createMemoryLogger("debug"));

    for (const token of ["Processed ", "3 ", "invoices."]) {
      printer.onEvent("messages", [new AIMessageChunk({ content: token }), { langgraph_node: "summarize" }]);
    }
    expect(writes.join("")).toBe("Processed 3 invoices.");
    expect(writes.join("")).not.toContain("\n");

    printer.finish();
    expect(writes.join("")).toBe("Processed 3 invoices.\n");
    printer.finish();
    expect(writes.join("")).toBe("Processed 3 invoices.\n");
  });

  it("closes an open token line before logging a custom event", () => {
    const { writes } = spyStdout();
    const logger = createMemoryLogger("debug");
    const printer = createProgressPrinter(logger);

    printer.onEvent("messages", [
      new AIMessageChunk({ content: "Processed 3 invoices." }),
      { langgraph_node: "summarize" },
    ]);
    printer.onEvent("custom", {
      type: "node_end",
      node: "summarize",
      documentId: "doc-001",
      ms: 412,
    } satisfies ProgressEvent);

    // The token line must be terminated before the log line, never appended to.
    expect(writes.join("")).toBe("Processed 3 invoices.\n");
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).not.toContain("invoices.");
    expect(logger.lines[0]).toContain("✓ summarize doc-001 (412 ms)");

    printer.finish();
    expect(writes.join("")).toBe("Processed 3 invoices.\n");
  });

  it("closes an open token line before a log event and prints the line verbatim", () => {
    const { writes } = spyStdout();
    const logger = createMemoryLogger("debug");
    const printer = createProgressPrinter(logger);

    printer.onEvent("messages", [
      new AIMessageChunk({ content: "Processed 8 invoices." }),
      { langgraph_node: "summarize" },
    ]);
    printer.onEvent("custom", {
      type: "log",
      level: "raw",
      line: "Batch batch-001 — 8 invoice(s)",
    } satisfies ProgressEvent);

    // The summary must be terminated before the sink's table header lands.
    expect(writes.join("")).toBe("Processed 8 invoices.\n");
    expect(logger.lines).toEqual(["Batch batch-001 — 8 invoice(s)"]);

    printer.finish();
    expect(writes.join("")).toBe("Processed 8 invoices.\n");
  });

  it("closes an open token line before an update line", () => {
    const { writes } = spyStdout();
    const logger = createMemoryLogger("debug");
    const printer = createProgressPrinter(logger);
    printer.onEvent("messages", [new AIMessageChunk({ content: "tokens" }), { langgraph_node: "summarize" }]);
    printer.onEvent("updates", { deliver: { ok: true } });

    expect(writes.join("")).toBe("tokens\n");
    expect(logger.lines[0]).toContain("update: deliver");
  });

  it("ignores tokens from other nodes and honours showTokens:false", () => {
    const { writes } = spyStdout();
    const printer = createProgressPrinter(createMemoryLogger("debug"));
    printer.onEvent("messages", [new AIMessageChunk({ content: "hidden" }), { langgraph_node: "extract" }]);
    printer.onEvent("messages", [new AIMessageChunk({ content: "hidden" }), undefined]);
    expect(writes).toHaveLength(0);

    const quiet = createProgressPrinter(createMemoryLogger("debug"), { showTokens: false });
    quiet.onEvent("messages", [new AIMessageChunk({ content: "hidden" }), { langgraph_node: "summarize" }]);
    quiet.finish();
    expect(writes).toHaveLength(0);
  });
});

describe("createProgressPrinter — updates", () => {
  it("debug-logs the node names in the update", () => {
    const logger = createMemoryLogger("debug");
    createProgressPrinter(logger).onEvent("updates", { extract: { ok: 1 }, validate: { ok: 1 } });
    expect(logger.lines.join("\n")).toContain("update: extract, validate");
  });

  it("announces an interrupt", () => {
    const logger = createMemoryLogger("debug");
    createProgressPrinter(logger).onEvent("updates", { __interrupt__: [{ value: {} }] });
    expect(logger.lines.join("\n")).toContain("waiting for human review");
  });

  it("tolerates unknown modes and malformed chunks", () => {
    const logger = createMemoryLogger("debug");
    const printer = createProgressPrinter(logger);
    expect(() => {
      printer.onEvent("values", { anything: true });
      printer.onEvent("custom", null);
      printer.onEvent("messages", "not-a-tuple");
      printer.onEvent("updates", null);
      printer.finish();
    }).not.toThrow();
  });
});
