# Invoice Processing Pipeline — LangChain.js + LangGraph.js demo

Date: 2026-08-20 · Status: approved-by-default (autonomous session; assumptions listed below)

## 1. Purpose

A self-contained, runnable TypeScript project that takes a batch of **randomly generated invoices**,
previews them, processes them through a **LangGraph** state machine built from **LangChain** primitives,
previews the processed results, and **delivers** them (console, files, email). Every core LangChain and
LangGraph feature is exercised by a real step of the pipeline — not by toy snippets — and a feature→file
map in the README points at each one.

Success criteria:

1. `npm run demo` (generate → run → deliver) works **offline** with zero credentials, deterministically.
2. Setting `ANTHROPIC_API_KEY` + `LLM_PROVIDER=anthropic` swaps in real Claude with no code change.
3. `npm test` passes; the graph's routing, interrupt/resume, reducers, tools, sinks are covered.
4. README feature matrix maps ≥ 14 LangChain features and ≥ 12 LangGraph features to files.

## 2. Assumptions (made autonomously — reversible)

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript (Node ≥ 20, ESM, `tsx`) | User's stack is Node/TS everywhere; Python project was retired |
| LangChain version | `langchain@1.x`, `@langchain/core@1.x`, `@langchain/langgraph@1.x` | Current majors; APIs verified against installed `.d.ts`, not memory |
| LLM provider | `@langchain/anthropic` `ChatAnthropic`, default model `claude-opus-5` | Claude API skill default; overridable via `ANTHROPIC_MODEL` |
| Offline mode | `ScriptedChatModel` — a custom `BaseChatModel` with rule-based responders | No API key on this machine; tests must be deterministic; demonstrates provider abstraction honestly (README says it is rule-based) |
| Email | `nodemailer`; Ethereal test account by default, SMTP/Resend via env | Zero-config preview URL; Resend exposes SMTP so no extra SDK |
| Package manager | npm | Avoids the Defender/pnpm temp-rename race on this machine |
| Schema lib | zod 4 | Native `withStructuredOutput` / `tool()` support |

## 3. Domain

### 3.1 Entities (`src/domain/schemas.ts`, zod)

- **Vendor** `{ id, name, aliases[], taxId, approved, defaultCategory }` — static registry (`vendors.ts`, ~12 vendors).
- **Invoice** (ground truth) `{ id, invoiceNumber, vendor{name,email,address}, issueDate, dueDate, currency, lineItems[{description, quantity, unitPrice, amount}], subtotal, taxRate, taxAmount, total, poNumber?, notes?, defects[] }`.
- **RawInvoiceDocument** `{ id, filename, format: 'plain'|'email'|'table', text }` — what the pipeline sees. Ground truth lives only in `manifest.json` for `evaluate`.
- **ExtractedInvoice** — LLM output: every field nullable + `confidence (0-1)` + `warnings[]`. The model must copy, never compute.
- **ValidationIssue** `{ code, severity: 'error'|'warning', message, field? }`.
- **Categorization** `{ category: Category, glAccount, confidence, rationale }` — `Category` enum of 9 values.
- **RiskAssessment** `{ score 0-100, level: 'low'|'medium'|'high', reasons[] }`.
- **Decision** `'auto_approved' | 'approved_by_human' | 'rejected_by_human' | 'auto_rejected' | 'needs_review'`.
- **ProcessedInvoice** `{ documentId, invoiceNumber, extracted, issues[], categorization, risk, investigation?, decision, decidedBy, reviewerNote?, provider, timings }`.
- **BatchResult** `{ batchId, threadId, processed[], stats, summary, deliveries[] }`.

### 3.2 Injected defects (`src/data/defects.ts`)

| Code | Effect on the rendered document | Expected pipeline outcome |
|---|---|---|
| `MATH_MISMATCH` | total ≠ subtotal + tax | `recompute_totals` error → review |
| `LINE_SUM_MISMATCH` | Σ line amounts ≠ subtotal | error → review |
| `DUE_BEFORE_ISSUE` | due date earlier than issue date | error → review |
| `MISSING_DUE_DATE` | due date line omitted | warning |
| `DUPLICATE_NUMBER` | second doc reuses an earlier invoice number | `auto_rejected` at batch fan-in |
| `UNKNOWN_VENDOR` | vendor not in registry | policy: always review |
| `OVER_THRESHOLD` | total above approval threshold | policy: review |
| `MISSING_PO` | PO omitted on a total that requires one | warning → review if combined |
| `FOREIGN_CURRENCY` | currency ≠ USD | warning |

Generation is seeded (`--seed`) so previews, tests and docs are reproducible. Defect rate default 0.35.

### 3.3 Policy (`src/domain/policy.ts`)

Typed rules are the single source of truth for enforcement (`reviewThreshold`, `cfoThreshold`, `poRequiredAbove`,
per-category overrides, `unknownVendorsRequireReview`). `renderPolicyDocument(policy)` produces the Markdown that the
BM25 retriever indexes, so prose and enforcement cannot drift.

## 4. Architecture

```
                 ┌─────────────────────────────── batch graph ───────────────────────────────┐
  raw docs ─►  load ─► fan_out ─(Send ×N)─► process_invoice ─► collect ─►(loop)─► review_next ─┐
                                            │ invoice subgraph │            ▲   interrupt()     │
                                            └─────────────────┘            └───────────────────┘
                                                                           │
                                                                        summarize (stream) ─► deliver ─► END
                                                                                     console · files · email
```

### 4.1 Invoice subgraph (`src/graph/invoice.graph.ts`) — side-effect free, Send-parallel safe

```
START → extract ─┬─► validate ───┐
                 └─► categorize ─┴─► assess_risk ─► (route) ─► auto_approve → END
                                                        ├─────► investigate → flag_for_review → END
                                                        └─────► auto_reject → END
```

- `extract` — LCEL: `ChatPromptTemplate` → `model.withStructuredOutput(ExtractedInvoiceSchema)`; node `retryPolicy`.
- `validate` — deterministic tools: `recompute_totals`, date checks, `lookup_vendor`, `find_duplicates` (ledger of prior batches), policy checks (PO, thresholds).
- `categorize` — few-shot `ChatPromptTemplate` + structured output; vendor `defaultCategory` injected as a hint.
- `assess_risk` — deterministic scoring from issues + policy; `search_policy` (BM25 retriever) supplies the quoted rule text for the brief.
- route: fatal issue (unparseable / ledger duplicate) → `auto_reject`; `risk.level !== 'low'` → `investigate` (ReAct agent with the 4 tools) → `flag_for_review`; else `auto_approve`.

### 4.2 Batch graph (`src/graph/batch.graph.ts`)

- `load` — reads the batch's raw docs (from state input or disk).
- `fan_out` — returns `Send('process_invoice', { document })` per doc (map); `results` reducer concatenates (reduce).
- `process_invoice` — invokes the compiled subgraph; writes one `ProcessedInvoice`.
- `collect` — intra-batch duplicate detection (cross-document, so it must run at fan-in), stats, builds `reviewQueue`.
- `review_next` — pops one flagged invoice, `interrupt({ invoice, brief })`, applies `{ action, note }` from `Command({ resume })`; conditional edge loops until the queue is empty (a cycle).
- `summarize` — LLM narrative, streamed token-by-token (`streamMode: 'messages'`) plus `custom` progress events via `config.writer`.
- `deliver` — runs every configured sink with `Promise.allSettled`; receipts (ok/failed + reason) are stored in state and printed. No sink failure is silent.
- Checkpointer: `MemorySaver` default; SQLite (`@langchain/langgraph-checkpoint-sqlite`) opt-in for cross-process `resume`. `thread_id` = batch id.

### 4.3 Model layer (`src/llm/`)

- `factory.ts` — `createModel(config)` → `ChatAnthropic` or `ScriptedChatModel`, wrapped as `model.withRetry({ stopAfterAttempt })` and `.withFallbacks([scripted])` when provider is anthropic (fallback is logged via callback and the result is stamped `provider: 'fake'` — graceful degradation, never silent). `cache: InMemoryCache` enabled.
- `fake-model.ts` — `ScriptedChatModel extends BaseChatModel`: `bindTools`, `_generate`, `_streamResponseChunks`, `withStructuredOutput`. A router picks a responder from the bound tool names / system prompt marker:
  - `extract_invoice` → parses the `<invoice_document>` block with the inverse of the renderers;
  - `categorize_invoice` → keyword/vendor-hint rules;
  - investigator tools bound → turn 1 emits parallel tool calls, turn 2 writes a brief from the `ToolMessage`s;
  - otherwise → summary responder (templated narrative from the stats JSON in the prompt).
  - Fault injection: `FAKE_FAILURE_RATE` (seeded) throws `TransientModelError` to exercise retries/fallbacks; `FAKE_LATENCY_MS` makes streaming visible.
- `pricing.ts` — $/MTok table for cost estimates in the run footer.

### 4.4 Observability (`src/observability/`)

- `UsageTracker extends BaseCallbackHandler` — per-LLM-call model, run name, latency, tokens, errors; tool start/end; aggregated into the run footer.
- `progress.ts` — renders `updates` / `custom` / `messages` stream events as a live log.
- LangSmith: honoured via standard env vars; documented, not required.

### 4.5 Delivery (`src/sinks/`, `src/report/`)

`Sink { name, deliver(result): Promise<DeliveryReceipt> }` — `ConsoleSink` (tables), `FileSink` (`results.json`, `results.csv`, `report.html`, `report.md`), `EmailSink` (nodemailer; HTML report body + JSON/CSV attachments; transport = SMTP env → Ethereal → `jsonTransport` `.eml` fallback, each step logged). One HTML renderer serves both file and email.

### 4.6 CLI (`src/cli.ts`, commander)

| Command | Purpose |
|---|---|
| `generate [-n 10] [--seed 42] [--defect-rate 0.35]` | create a batch; print raw preview |
| `preview <batch> [--show <docId>] [--ground-truth]` | re-print raw preview / full text / truth |
| `run <batch> [--provider fake\|anthropic] [--review interactive\|approve\|reject] [--email <to>] [--chaos <rate>] [--checkpointer memory\|sqlite]` | process + deliver; live progress; processed table |
| `resume <thread> --decision approve\|reject [--note]` | continue an interrupted run (sqlite) |
| `evaluate <batch>` | processed vs ground truth: field accuracy, defect recall |
| `graph` | Mermaid for both graphs |

`examples/*.ts` (npm scripts) cover features that don't sit naturally in the pipeline: LCEL basics (`RunnableParallel`, `.batch`, parsers), `streamEvents`, retry/fallback under chaos, time travel (`getStateHistory` + `updateState`).

## 5. Error handling

- Zod at every boundary: CLI args, env config, LLM structured output, tool inputs, batch files on disk.
- LLM failures: per-call `withRetry` (transient), node `retryPolicy` (extract), model `withFallbacks` (stamped + logged). A document whose extraction still fails becomes `auto_rejected` with issue `EXTRACTION_FAILED` — the batch continues.
- Tool errors return typed issues, never throw across the graph boundary.
- Sink failures are receipts, surfaced in the console and the state; the run exits non-zero if any sink failed.
- Interrupt resume payload is validated; an invalid payload re-interrupts with the validation message.

## 6. Testing (vitest, fake provider only — no network)

generator determinism & defect counts · renderer↔fake-parser round trip · fake model structured/agent/chaos paths ·
each tool · each chain · invoice-graph routing per defect · batch graph interrupt → resume (approve & reject, two flagged in a row) ·
reducers · sinks (file; email via injected `jsonTransport`) · evaluate metrics · checkpoint history length.

## 7. Out of scope

Real OCR/PDF parsing, a web UI, persistent DB beyond the JSON ledger, LangGraph Platform deployment, embeddings-based vector stores (BM25 chosen so RAG needs no embedding provider).
