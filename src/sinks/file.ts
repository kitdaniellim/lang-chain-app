import fs from "node:fs/promises";
import path from "node:path";
import type { BatchResult, DeliveryReceipt } from "../domain/schemas.js";
import { toCsv } from "../report/csv.js";
import { renderHtmlReport } from "../report/html.js";
import { renderMarkdownReport } from "../report/markdown.js";
import type { Sink, SinkContext } from "./types.js";
import { receipt } from "./types.js";

/** Relative artefact paths written under `ctx.batchDir` (POSIX separators for the receipt). */
export const FILE_SINK_ARTEFACTS = [
  "processed/results.json",
  "processed/results.csv",
  "report.html",
  "report.md",
] as const;

/** Writes the batch to disk: the full result (JSON), the rows (CSV) and the HTML/Markdown reports. */
export class FileSink implements Sink {
  readonly name = "file";

  async deliver(result: BatchResult, ctx: SinkContext): Promise<DeliveryReceipt> {
    try {
      // Rendering lives inside the try so a renderer or JSON failure is a receipt, not a throw.
      const contents: Record<(typeof FILE_SINK_ARTEFACTS)[number], string> = {
        "processed/results.json": `${JSON.stringify(result, null, 2)}\n`,
        "processed/results.csv": toCsv(result.processed),
        "report.html": renderHtmlReport(result),
        "report.md": renderMarkdownReport(result),
      };

      for (const rel of FILE_SINK_ARTEFACTS) {
        const target = path.join(ctx.batchDir, ...rel.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents[rel], "utf8");
      }
      const detail = FILE_SINK_ARTEFACTS.join(", ");
      ctx.logger.info(`file sink wrote ${FILE_SINK_ARTEFACTS.length} artefact(s) to ${ctx.batchDir}`);
      return receipt(this.name, true, detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error(`file sink failed: ${message}`);
      return receipt(this.name, false, message);
    }
  }
}
