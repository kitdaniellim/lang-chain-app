import { Document } from "@langchain/core/documents";
import { BaseRetriever, type BaseRetrieverInput } from "@langchain/core/retrievers";
import { MarkdownTextSplitter } from "@langchain/textsplitters";
import { DEFAULT_POLICY, renderPolicyDocument, type ApprovalPolicy } from "../domain/policy.js";

/** Okapi BM25 term-frequency saturation and length-normalisation constants. */
const K1 = 1.5;
const B = 0.75;
const DEFAULT_K = 3;

const TOKEN_RE = /[a-z0-9]+/g;
/** `-es` plurals of sibilant stems ("matches", "boxes", "classes"). */
const ES_PLURAL_RE = /(ss|x|z|ch|sh)es$/;

/** Fold simple plurals so "duplicates"/"duplicate" and "vendors"/"vendor" share a token. */
function stem(token: string): string {
  if (token.length > 4 && ES_PLURAL_RE.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Lower-case, keep alphanumeric runs, stem each token. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).map(stem);
}

/** Metadata carried by every chunk this retriever indexes and returns. */
export interface PolicyChunkMetadata extends Record<string, unknown> {
  /** The `##` heading the chunk sits under. */
  section: string;
  /** Position of the chunk in the rendered handbook. */
  chunk: number;
  /** BM25 relevance for the query that retrieved it; 0 on the indexed copies. */
  score: number;
}

export interface PolicyRetrieverFields extends BaseRetrieverInput {
  documents: Document<PolicyChunkMetadata>[];
  k?: number;
}

/**
 * BM25 retriever over the rendered approval-policy handbook.
 * The index is built from `renderPolicyDocument`, so retrieved prose can never
 * drift from the numbers the deterministic checks enforce.
 */
export class PolicyRetriever extends BaseRetriever<PolicyChunkMetadata> {
  lc_namespace = ["lang-chain-demo", "retrievers"];

  /** The indexed chunks, in document order. */
  readonly documents: Document<PolicyChunkMetadata>[];
  /** How many chunks `invoke` returns. */
  readonly k: number;

  private readonly termFrequencies: Map<string, number>[];
  private readonly docLengths: number[];
  private readonly documentFrequency: Map<string, number>;
  private readonly averageLength: number;

  constructor(fields: PolicyRetrieverFields) {
    super(fields);
    this.documents = fields.documents;
    this.k = fields.k ?? DEFAULT_K;

    this.termFrequencies = [];
    this.docLengths = [];
    this.documentFrequency = new Map();

    for (const doc of this.documents) {
      const tokens = tokenize(doc.pageContent);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const term of counts.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
      this.termFrequencies.push(counts);
      this.docLengths.push(tokens.length);
    }

    const totalLength = this.docLengths.reduce((sum, len) => sum + len, 0);
    this.averageLength = this.docLengths.length > 0 ? totalLength / this.docLengths.length : 0;
  }

  /** Split the rendered handbook into one `Document` per `##` section and index it. */
  static async fromPolicy(
    policy: ApprovalPolicy = DEFAULT_POLICY,
    opts: { k?: number } = {},
  ): Promise<PolicyRetriever> {
    const splitter = new MarkdownTextSplitter({ chunkSize: 400, chunkOverlap: 0 });
    const chunks = await splitter.splitText(renderPolicyDocument(policy));

    let section = "General";
    const documents = chunks.map((text, index) => {
      section = lastHeading(text) ?? section;
      return new Document<PolicyChunkMetadata>({
        pageContent: text,
        metadata: { section, chunk: index, score: 0 },
      });
    });

    return new PolicyRetriever({ documents, k: opts.k ?? DEFAULT_K });
  }

  /** BM25-rank every chunk against the query and return the top `k` with their scores. */
  async _getRelevantDocuments(query: string): Promise<Document<PolicyChunkMetadata>[]> {
    const terms = tokenize(query);
    const ranked = this.documents.map((doc, index) => ({ doc, index, score: this.score(terms, index) }));

    ranked.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));

    return ranked.slice(0, this.k).map(
      ({ doc, score }) =>
        new Document<PolicyChunkMetadata>({
          pageContent: doc.pageContent,
          metadata: { ...doc.metadata, score },
        }),
    );
  }

  /** Okapi BM25 score of one indexed chunk against the already-tokenised query. */
  private score(terms: string[], index: number): number {
    const counts = this.termFrequencies[index];
    const length = this.docLengths[index];
    if (!counts || length === undefined || this.averageLength === 0) return 0;

    const total = this.documents.length;
    let score = 0;
    for (const term of terms) {
      const frequency = counts.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = this.documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const denominator = frequency + K1 * (1 - B + (B * length) / this.averageLength);
      score += idf * ((frequency * (K1 + 1)) / denominator);
    }
    return score;
  }
}

/** Last `## ` heading in a chunk; null when the chunk carries no heading. */
function lastHeading(text: string): string | null {
  const matches = [...text.matchAll(/^##\s+(.+)$/gm)];
  const last = matches.at(-1);
  return last?.[1]?.trim() ?? null;
}
