import type { ProgressEvent } from "../pipeline/types.js";
import type { Logger } from "./logger.js";

export interface ProgressPrinterOptions {
  /** Streams summarize-node tokens to stdout as they arrive (default true). */
  showTokens?: boolean;
}

export interface ProgressPrinter {
  onEvent(mode: string, chunk: unknown): void;
  finish(): void;
}

const SYMBOL = { start: "▶", end: "✓", warn: "⚠", decision: "→", delivery: "✉", pause: "⏸" } as const;

/** LangGraph's own bookkeeping nodes (`__start__`, `__end__`, `__interrupt__`) are never user-facing. */
function isInternal(node: string): boolean {
  return node.startsWith("__");
}

function withDoc(text: string, documentId?: string): string {
  return documentId ? `${text} ${documentId}` : text;
}

/**
 * Renders `graph.stream(..., { streamMode: ["updates", "custom", "messages"] })` chunks.
 * Token text goes straight to stdout so the summary streams on one line.
 */
export function createProgressPrinter(logger: Logger, opts: ProgressPrinterOptions = {}): ProgressPrinter {
  const showTokens = opts.showTokens !== false;
  let streamed = "";

  /** Closes an open token line so a log line can never be appended mid-token. */
  const closeTokenLine = (): void => {
    if (streamed === "") return;
    process.stdout.write("\n");
    streamed = "";
  };

  const log = (level: "debug" | "info" | "warn", message: string): void => {
    closeTokenLine();
    logger[level](message);
  };

  const handleCustom = (chunk: unknown): void => {
    const event = chunk as ProgressEvent | null;
    if (!event || typeof event !== "object" || typeof event.type !== "string") return;

    switch (event.type) {
      case "node_start":
        if (!isInternal(event.node)) log("info", withDoc(`${SYMBOL.start} ${event.node}`, event.documentId));
        break;
      case "node_end":
        if (!isInternal(event.node)) {
          log("info", `${withDoc(`${SYMBOL.end} ${event.node}`, event.documentId)} (${event.ms} ms)`);
        }
        break;
      case "info":
        log("info", withDoc(event.message, event.documentId));
        break;
      case "warn":
        log("warn", withDoc(`${SYMBOL.warn} ${event.message}`, event.documentId));
        break;
      case "decision":
        log("info", `${SYMBOL.decision} ${event.documentId} ${event.decision}: ${event.reason}`);
        break;
      case "review_request":
        log("info", `${SYMBOL.pause} review ${event.documentId} (${event.remaining} left in the queue)`);
        break;
      case "delivery":
        log("info", `${SYMBOL.delivery} ${event.sink} ${event.ok ? "ok" : "FAILED"} — ${event.detail}`);
        break;
      case "log":
        // Already formatted by the node's logger; only its position in the stream matters here.
        closeTokenLine();
        logger.raw(event.line);
        break;
    }
  };

  const handleMessages = (chunk: unknown): void => {
    if (!showTokens || !Array.isArray(chunk)) return;
    const [message, metadata] = chunk as [{ content?: unknown } | undefined, { langgraph_node?: string } | undefined];
    if (metadata?.langgraph_node !== "summarize") return;
    const text = typeof message?.content === "string" ? message.content : "";
    if (!text) return;
    streamed += text;
    process.stdout.write(text);
  };

  const handleUpdates = (chunk: unknown): void => {
    if (!chunk || typeof chunk !== "object") return;
    const keys = Object.keys(chunk as Record<string, unknown>);
    if (keys.includes("__interrupt__")) log("info", `${SYMBOL.pause} waiting for human review`);
    const nodes = keys.filter((key) => !isInternal(key));
    if (nodes.length > 0) log("debug", `update: ${nodes.join(", ")}`);
  };

  return {
    onEvent(mode: string, chunk: unknown): void {
      if (mode === "custom") handleCustom(chunk);
      else if (mode === "messages") handleMessages(chunk);
      else if (mode === "updates") handleUpdates(chunk);
    },
    finish(): void {
      closeTokenLine();
    },
  };
}
