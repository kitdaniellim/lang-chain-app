import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ProgressEvent } from "../pipeline/types.js";

/** Publishes a progress event on the `custom` stream; a graph invoked outside a stream has no writer. */
export function emitProgress(config: LangGraphRunnableConfig, event: ProgressEvent): void {
  config.writer?.(event);
}

/** Wraps a batch-graph node in start/end progress events; the update passes through unchanged. */
export async function traced<T>(
  node: string,
  config: LangGraphRunnableConfig,
  fn: () => Promise<T> | T,
): Promise<T> {
  emitProgress(config, { type: "node_start", node });
  const started = Date.now();
  try {
    return await fn();
  } finally {
    emitProgress(config, { type: "node_end", node, ms: Date.now() - started });
  }
}

/** Same as `traced`, but stamps the node's duration into the invoice state's `timings` map. */
export async function timed<T extends object>(
  node: string,
  documentId: string,
  config: LangGraphRunnableConfig,
  fn: () => Promise<T> | T,
): Promise<T & { timings: Record<string, number> }> {
  emitProgress(config, { type: "node_start", node, documentId });
  const started = Date.now();
  try {
    const update = await fn();
    return { ...update, timings: { [node]: Date.now() - started } };
  } finally {
    emitProgress(config, { type: "node_end", node, documentId, ms: Date.now() - started });
  }
}
