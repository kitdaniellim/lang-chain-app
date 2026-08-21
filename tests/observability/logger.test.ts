import { START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamAwareLogger } from "../../src/observability/logger.js";
import type { ProgressEvent } from "../../src/pipeline/types.js";

const State = z.object({ done: z.boolean().default(false) });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createStreamAwareLogger", () => {
  it("emits log events on the custom stream while a node is running", async () => {
    const logger = createStreamAwareLogger({ level: "debug" });
    const graph = new StateGraph(State)
      .addNode("speak", () => {
        logger.info("inside");
        logger.raw("raw inside");
        return { done: true };
      })
      .addEdge(START, "speak")
      .compile();

    const events: ProgressEvent[] = [];
    for await (const chunk of await graph.stream({}, { streamMode: "custom" })) {
      events.push(chunk as ProgressEvent);
    }

    const logs = events.filter((event) => event.type === "log");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ type: "log", level: "info" });
    expect(logs[0]!.type === "log" && logs[0]!.line).toContain("inside");
    expect(logs[1]).toMatchObject({ type: "log", level: "raw", line: "raw inside" });
  });

  it("falls back to its own sink outside a graph run", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    const logger = createStreamAwareLogger({ level: "debug" });
    logger.info("outside");
    logger.raw("raw outside");

    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("outside");
    expect(writes[1]).toBe("raw outside\n");
  });

  it("keeps child scopes stream-aware and honours the level filter", async () => {
    const logger = createStreamAwareLogger({ level: "warn" }).child("sink");
    const graph = new StateGraph(State)
      .addNode("speak", () => {
        logger.debug("swallowed");
        logger.warn("kept");
        return { done: true };
      })
      .addEdge(START, "speak")
      .compile();

    const logs: ProgressEvent[] = [];
    for await (const chunk of await graph.stream({}, { streamMode: "custom" })) {
      const event = chunk as ProgressEvent;
      if (event.type === "log") logs.push(event);
    }

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "warn" });
    // Colour codes sit between the scope and the message, so they are checked separately.
    const line = logs[0]!.type === "log" ? logs[0]!.line : "";
    expect(line).toContain("[sink]");
    expect(line).toContain("kept");
  });
});
