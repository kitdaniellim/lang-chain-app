import { mkdirSync } from "node:fs";
import path from "node:path";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export type CheckpointerKind = "memory" | "sqlite";

export const CHECKPOINT_FILENAME = "checkpoints.sqlite";

/** Memory keeps history for the process only; sqlite survives restarts so `time-travel` can replay a past run. */
export function createCheckpointer(kind: CheckpointerKind, outDir: string): BaseCheckpointSaver {
  if (kind !== "sqlite") return new MemorySaver();
  mkdirSync(outDir, { recursive: true });
  return SqliteSaver.fromConnString(path.join(outDir, CHECKPOINT_FILENAME));
}

/**
 * Releases the sqlite file handle. `SqliteSaver` has no close() of its own, but it
 * exposes the better-sqlite3 database, which holds the handle for the whole process.
 */
export function closeCheckpointer(saver: BaseCheckpointSaver): void {
  const db = (saver as { db?: { close?: () => void; open?: boolean } }).db;
  if (db && typeof db.close === "function" && db.open !== false) db.close();
}
