import { getConfig, type LangGraphRunnableConfig } from "@langchain/langgraph";
import pc from "picocolors";
import type { ProgressEvent } from "../pipeline/types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  level: LogLevel;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** Raw line without prefix (for tables / streamed tokens). */
  raw(text: string): void;
  child(scope: string): Logger;
}

/** Receives the formatted line plus the level it was emitted at (`"raw"` for `raw()`). */
export type LogSink = (line: string, level: LogLevel | "raw") => void;

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  sink?: LogSink;
}

const PAINT: Record<LogLevel, (s: string) => string> = {
  debug: pc.dim,
  info: pc.cyan,
  warn: pc.yellow,
  error: pc.red,
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const scope = options.scope;
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const tag = PAINT[lvl](lvl.toUpperCase().padEnd(5));
    const prefix = scope ? pc.dim(`[${scope}] `) : "";
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${pc.dim(JSON.stringify(meta))}` : "";
    sink(`${tag} ${prefix}${msg}${suffix}`, lvl);
  };

  return {
    level,
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
    raw: (text) => sink(text, "raw"),
    child: (childScope) => createLogger({ level, scope: scope ? `${scope}:${childScope}` : childScope, sink }),
  };
}

/** The `custom`-stream writer of the running node, or undefined when no graph run is active. */
function graphStreamWriter(): ((chunk: unknown) => void) | undefined {
  // getConfig() reads AsyncLocalStorage and yields undefined outside a graph run.
  const config = getConfig() as LangGraphRunnableConfig | undefined;
  return config?.writer ?? (config?.configurable?.writer as ((chunk: unknown) => void) | undefined);
}

/**
 * Logger that routes lines through the graph's `custom` stream while a node is running, so
 * node/sink output stays ordered with the tokens and progress events the CLI printer drains.
 * Outside a graph run it falls back to the plain sink (stdout by default).
 */
export function createStreamAwareLogger(options: LoggerOptions = {}): Logger {
  const fallback: LogSink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  return createLogger({
    ...options,
    sink: (line, level) => {
      const writer = graphStreamWriter();
      if (writer) writer({ type: "log", level, line } satisfies ProgressEvent);
      else fallback(line, level);
    },
  });
}

/** Collects lines instead of printing — for tests. */
export function createMemoryLogger(level: LogLevel = "debug"): Logger & { lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line) });
  return Object.assign(logger, { lines });
}
