import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/domain/policy.js";
import { PolicyRetriever } from "../../src/rag/policy-retriever.js";

const topSection = async (retriever: PolicyRetriever, query: string): Promise<string> => {
  const docs = await retriever.invoke(query);
  expect(docs.length).toBeGreaterThan(0);
  return docs[0]!.metadata.section as string;
};

describe("PolicyRetriever", () => {
  let retriever: PolicyRetriever;

  beforeAll(async () => {
    retriever = await PolicyRetriever.fromPolicy(DEFAULT_POLICY);
  });

  it("indexes every ## section of the rendered handbook", () => {
    const sections = retriever.documents.map((d) => d.metadata.section as string);
    expect(sections).toEqual([
      "Approval thresholds",
      "Purchase orders",
      "Vendors",
      "Duplicates",
      "Category-specific limits",
      "Data quality",
    ]);
    for (const doc of retriever.documents) {
      expect(doc.pageContent.length).toBeGreaterThan(0);
    }
  });

  it("ranks 'purchase order required' into the Purchase orders section", async () => {
    expect(await topSection(retriever, "purchase order required")).toBe("Purchase orders");
  });

  it("ranks 'unknown vendor' into the Vendors section", async () => {
    expect(await topSection(retriever, "unknown vendor")).toBe("Vendors");
  });

  it("ranks 'duplicate invoice' into the Duplicates section", async () => {
    expect(await topSection(retriever, "duplicate invoice")).toBe("Duplicates");
  });

  it("stems plurals so 'duplicates' and 'vendors' still hit their sections", async () => {
    expect(await topSection(retriever, "duplicates")).toBe("Duplicates");
    expect(await topSection(retriever, "vendors")).toBe("Vendors");
  });

  it("returns exactly k documents from the 6-section corpus", async () => {
    expect((await retriever.invoke("invoice")).length).toBe(3);

    const narrow = await PolicyRetriever.fromPolicy(DEFAULT_POLICY, { k: 1 });
    expect((await narrow.invoke("invoice")).length).toBe(1);
  });

  it("still returns top-k padding for a query that matches nothing", async () => {
    const docs = await retriever.invoke("zzzz qqqq xyzzy");
    expect(docs.length).toBe(3);
    expect(docs.map((d) => d.metadata.score as number)).toEqual([0, 0, 0]);
  });

  it("attaches numeric scores in descending order", async () => {
    const docs = await retriever.invoke("cfo sign-off escalated");
    const scores = docs.map((d) => d.metadata.score as number);
    expect(scores.length).toBeGreaterThan(1);
    for (const score of scores) expect(typeof score).toBe("number");
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
    expect(scores[0]!).toBeGreaterThan(0);
  });

  it("reflects a custom policy's numbers in the indexed text", async () => {
    const custom = await PolicyRetriever.fromPolicy({ ...DEFAULT_POLICY, reviewThreshold: 1234 });
    const docs = await custom.invoke("auto-approved data-quality checks");
    expect(docs[0]!.pageContent).toContain("$1,234");
  });
});
