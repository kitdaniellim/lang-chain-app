import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const fake = new (class extends EventEmitter {
  question = vi.fn(() => new Promise<string>(() => {}));
  close = vi.fn(() => this.emit("close"));
})();

vi.mock("node:readline/promises", () => ({ default: { createInterface: () => fake } }));

const { interactiveReviewer } = await import("../../src/cli/reviewers.js");
const { createMemoryLogger } = await import("../../src/observability/logger.js");

describe("interactive reviewer SIGINT", () => {
  it("rejects with the resume hint when the user presses Ctrl-C", async () => {
    const reviewer = interactiveReviewer(createMemoryLogger());
    const pending = reviewer({
      documentId: "doc-001",
      invoiceNumber: "INV-1",
      vendorName: "V",
      total: 1,
      currency: "USD",
      risk: { score: 50, level: "medium", reasons: [] },
      issues: [],
      investigation: null,
      policyExcerpts: [],
      remaining: 0,
    });
    await Promise.resolve();
    fake.emit("SIGINT");
    await expect(pending).rejects.toThrow(/Review aborted by user \(Ctrl-C\)/);
    await expect(pending).rejects.toThrow(/resume <threadId> --checkpointer sqlite/);
    expect(fake.close).toHaveBeenCalled();
  });
});
