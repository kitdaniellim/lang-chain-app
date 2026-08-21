import type { BatchResult, DeliveryReceipt } from "../domain/schemas.js";
import type { Logger } from "../observability/logger.js";

export interface SinkContext {
  /** Directory of the batch being delivered (`<outDir>/<batchId>`). */
  batchDir: string;
  logger: Logger;
}

/**
 * A delivery target. `deliver` must never throw for expected failures —
 * it returns a receipt with `ok: false` and a human-readable `detail` instead,
 * so the graph can record every outcome.
 */
export interface Sink {
  readonly name: string;
  deliver(result: BatchResult, ctx: SinkContext): Promise<DeliveryReceipt>;
}

export function receipt(sink: string, ok: boolean, detail: string): DeliveryReceipt {
  return { sink, ok, detail, at: new Date().toISOString() };
}
