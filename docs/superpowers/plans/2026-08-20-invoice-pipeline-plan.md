# Invoice Pipeline (LangChain.js + LangGraph.js demo) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable TypeScript project that generates random invoices, previews them, processes them through a LangGraph pipeline built from LangChain primitives, previews the results, and delivers them (console / files / email) — exercising every core LangChain + LangGraph feature with a file-level feature map.

**Architecture:** Generator → unstructured text docs → batch graph (`Send` fan-out into a per-invoice subgraph: LLM extract → deterministic validate ∥ LLM categorize → risk → investigator agent) → fan-in → sequential human-review loop via `interrupt()` → streamed LLM summary → sinks. A custom `ScriptedChatModel` (rule-based `BaseChatModel`) makes everything run offline and deterministically; `ChatAnthropic` is the real provider.

**Tech Stack:** Node 24, TypeScript 5.9 (ESM, `tsx`), `@langchain/core@1.2`, `@langchain/langgraph@1.4`, `langchain@1.5` (`createAgent` + middleware), `@langchain/anthropic@1.5`, `@langchain/textsplitters`, zod 4, `@faker-js/faker`, nodemailer, commander, cli-table3, picocolors, vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-invoice-pipeline-design.md`

## Global Constraints

- ESM only; relative imports end in `.js` (`import { x } from "../domain/schemas.js"`); `verbatimModuleSyntax` → use `import type` for types.
- Zod 4: `z.record(keySchema, valueSchema)` needs both args; use `.nullable()` not `.optional()` for LLM-facing fields.
- No network in tests. Tests use the fake provider only. Test files live in `tests/**/*.test.ts` (mirroring `src/`), run with `npm test`.
- Never throw across a graph-node boundary for *expected* failures (bad extraction, sink failure) — return typed issues/receipts. Never use a bare `catch {}`; log or convert every error.
- Comments: 1–2 lines, say what the code does; no ticket IDs, no essays.
- Each task must finish with `npm run typecheck` clean and its tests passing. **Do not use git** (the user owns all git operations; there is no repo yet).
- Foundation files already exist and are the contract — read them before coding: `src/domain/schemas.ts`, `src/domain/constants.ts`, `src/domain/policy.ts`, `src/domain/vendors.ts`, `src/config.ts`, `src/llm/types.ts`, `src/llm/errors.ts`, `src/llm/pricing.ts`, `src/sinks/types.ts`, `src/data/ledger.types.ts`, `src/pipeline/types.ts`, `src/graph/state.ts`, `src/observability/logger.ts`, `tests/fixtures/sample-documents.ts`.

## Verified API notes (installed versions — trust these over memory)

- `BaseChatModel` subclass needs `_llmType()`, `_generate(messages, options, runManager)`, optional `_streamResponseChunks`, optional `bindTools(tools)`. Core's default `withStructuredOutput(schema, {name})` calls `this.bindTools([{type:"function", function:{name, description, parameters}}])` and then returns `toolCall.args` of the tool call whose `name` matches (default name `"extract"`) — **no zod validation**, so chains must `Schema.parse()` the result.
- `bindTools` convention (from core's `FakeListChatModel`): build a new instance carrying the merged tools and `return next.withConfig({ tools })`.
- Streaming chunk: `new ChatGenerationChunk({ message: new AIMessageChunk({ content: text }), text })`, then `await runManager?.handleLLMNewToken(text)`.
- Tool-call message: `new AIMessage({ content: "", tool_calls: [{ id, name, args, type: "tool_call" }], usage_metadata: { input_tokens, output_tokens, total_tokens } })`.
- `tool(fn, { name, description, schema })` from `@langchain/core/tools` accepts zod 4 object schemas; returns `DynamicStructuredTool` (a `StructuredToolInterface`).
- `BaseRetriever` subclass: implement `_getRelevantDocuments(query, runManager)` returning `Document[]`; set `lc_namespace`.
- LangGraph: `new StateGraph(StateSchemaInstance, ContextZodSchema)`; node `(state, config: LangGraphRunnableConfig<Ctx>)` reads `config.context`, emits `config.writer?.(event)`; `addNode(name, fn, { input: InputStateSchema, retryPolicy: { maxAttempts, retryOn } })`; `addConditionalEdges(from, router, [targets])` where the router may return `new Send("node", payload)[]`; `interrupt<I,R>(payload): R`; resume with `graph.stream(new Command({ resume }), config)`; `await g.getState(config)` → `state.tasks[].interrupts[].value`; `g.getStateHistory(config)` async-iterable; `(await g.getGraphAsync()).drawMermaid()`. Stream modes used: `"updates" | "custom" | "messages"`. `context` is NOT checkpointed. A subgraph gets the parent's context by passing `config` to `sub.invoke(input, config)`. (All verified by a spike.)
- `langchain`: `createAgent({ model, tools, systemPrompt, middleware: [...], responseFormat: toolStrategy(zodSchema) })` → `await agent.invoke({ messages: [new HumanMessage(...)] })` → `result.structuredResponse`. Middleware available: `toolCallLimitMiddleware`, `modelRetryMiddleware`, `modelFallbackMiddleware`.
- `ChatAnthropic({ model, apiKey, maxTokens, maxRetries, clientOptions })` from `@langchain/anthropic`. Default model `claude-opus-5` (adaptive thinking is on by default; forced `tool_choice` is fine on the Claude API).

---

## File structure (who owns what)

| Task | Creates |
|---|---|
| 1 Data | `src/data/rng.ts`, `src/data/defects.ts`, `src/data/renderers.ts`, `src/data/generator.ts`, `src/data/batch-store.ts`, `src/data/ledger.ts`, tests |
| 2 LLM layer | `src/llm/text-parser.ts`, `src/llm/fake-model.ts`, `src/llm/responders/{router,extract,categorize,investigate,summarize}.ts`, `src/llm/factory.ts`, `src/chains/{extract,categorize,summarize}.ts`, tests |
| 3 Tools + RAG | `src/rag/policy-retriever.ts`, `src/tools/{recompute-totals,lookup-vendor,find-duplicates,search-policy,index}.ts`, tests |
| 4 Output | `src/pipeline/stats.ts`, `src/report/{html,markdown,csv}.ts`, `src/sinks/{console,file,email,index}.ts`, `src/observability/{usage-tracker,progress}.ts`, `src/evaluate/evaluate.ts`, tests |
| 5 Graphs | `src/agents/investigator.ts`, `src/graph/{checkpointer,invoice.graph,batch.graph}.ts`, `src/pipeline/run-batch.ts`, tests |
| 6 CLI + examples | `src/cli.ts`, `src/cli/*.ts`, `examples/*.ts` |
| 7 Docs | `README.md`, `docs/FEATURES.md` |
| 8 Verify | end-to-end run, review fixes |

Tasks 1–4 are independent of each other (they depend only on the foundation) and run in parallel. Task 5 needs 1–4. Task 6 needs 5. Task 7 needs 6.

---

### Task 1: Data — generator, renderers, defects, batch store, ledger

**Files:**
- Create: `src/data/rng.ts`, `src/data/defects.ts`, `src/data/renderers.ts`, `src/data/generator.ts`, `src/data/batch-store.ts`, `src/data/ledger.ts`
- Test: `tests/data/renderers.test.ts`, `tests/data/generator.test.ts`, `tests/data/batch-store.test.ts`, `tests/data/ledger.test.ts`

**Interfaces:**
- Consumes: `Invoice`, `RawInvoiceDocument`, `BatchManifest`, `DefectCode`, `DocumentFormat` (`src/domain/schemas.ts`); `VENDORS` (`src/domain/vendors.ts`); `DEFAULT_POLICY` (`src/domain/policy.ts`); `LedgerEntry`, `LedgerStore`, `SimilarQuery` (`src/data/ledger.types.ts`); `DEFAULT_BATCH_DIR`, `LEDGER_FILENAME` (`src/domain/constants.ts`); fixture `tests/fixtures/sample-documents.ts`.
- Produces:
  - `createRng(seed: number): Rng` where `interface Rng { next(): number; int(min, max): number; pick<T>(arr: readonly T[]): T; chance(p: number): boolean; shuffle<T>(arr: readonly T[]): T[] }` (mulberry32).
  - `renderDocument(invoice: Invoice, format: DocumentFormat): string` and `renderPlain/renderEmail/renderTable`.
  - `applyDefect(invoice: Invoice, code: DefectCode, rng: Rng, ctx: { earlier: Invoice[]; policy: ApprovalPolicy }): Invoice` (pure; returns a new invoice with `defects` appended).
  - `generateBatch(opts: GenerateOptions): BatchManifest` with `interface GenerateOptions { count: number; seed: number; defectRate: number; batchId?: string; now?: Date }`.
  - `batchDir(outDir, batchId): string`; `writeBatch(outDir, manifest): Promise<string>` (writes `manifest.json` + `raw/<docId>.txt`, returns dir); `readManifest(outDir, batchId): Promise<BatchManifest>` (zod-validated; throws a clear error when missing); `listBatches(outDir): Promise<string[]>`; `writeResult(outDir, batchId, result: BatchResult): Promise<void>` (writes `processed/results.json`); `readResult(outDir, batchId): Promise<BatchResult | null>`.
  - `class JsonLedger implements LedgerStore` with `static async load(filePath): Promise<JsonLedger>` (missing file → empty), `find`, `findSimilar`, `size`, `append`, `save`.

**Rendering rules** (must reproduce the fixture byte-for-byte):
- plain: see `PLAIN_TEXT`. Dates ISO. `Tax (8%)` uses `Math.round(taxRate*100)`. Money `toFixed(2)`. Omit `Due Date:`/`PO Number:`/`Notes:` lines when null. Bill-To block is constant (`Demo Corp - Accounts Payable` / `ap@democorp.example`).
- email: see `EMAIL_TEXT`. Dates `DD Mon YYYY` (`03 Jul 2026`). Omit `Due:`/`PO:` lines when null; omit the notes paragraph (and its blank line) when null. Signature `<vendor name> Billing`.
- table: see `TABLE_TEXT` + the column spec in its doc comment. Dates `MM/DD/YYYY`. Vendor name upper-cased, truncated to 53 chars. Omit `Due`/`PO` rows when null. Descriptions truncated to 32 chars.

**Generator rules:**
- `faker.seed(seed)` + `createRng(seed)`; never call `Math.random`. `now` defaults to `new Date("2026-08-20T00:00:00Z")` so output is reproducible.
- Invoice numbers `INV-2026-${String(1000 + i * 7 + rng.int(0, 6)).padStart(4, "0")}` style (unique unless duplicated on purpose). Document ids `doc-001`… Filenames `doc-001.plain.txt` etc. Format cycles plain/email/table via rng.
- Vendor from `VENDORS` (use its `emailDomain`/`address`); 1–5 line items from a per-category description pool; `unitPrice` 2 decimals; `amount = round2(qty*unit)`; `subtotal = Σ`; `taxRate ∈ {0, 0.05, 0.08, 0.12}`; `taxAmount = round2(subtotal*taxRate)`; `total = round2(subtotal+tax)`; `dueDate = issueDate + 30d`; `poNumber = "PO-"+5 digits` (always present unless defected); keep totals **below** `DEFAULT_POLICY.reviewThreshold` unless `OVER_THRESHOLD` is injected.
- Defects: for each invoice, `rng.chance(defectRate)` → apply one code drawn round-robin from `rng.shuffle(DEFECT_CODES)` (so a 10-invoice batch gets variety), with a 25% chance of a second distinct code. `DUPLICATE_NUMBER` needs an earlier invoice (skip to next code if none). Effects: `MATH_MISMATCH` → `total += rng.int(5, 60)`; `LINE_SUM_MISMATCH` → `subtotal += rng.int(3, 30)` and recompute tax/total from the wrong subtotal; `DUE_BEFORE_ISSUE` → due = issue − 5d; `MISSING_DUE_DATE` → due null; `DUPLICATE_NUMBER` → copy an earlier invoice's number (and vendor) but keep this invoice's other data; `UNKNOWN_VENDOR` → vendor name from `faker.company.name()` with a faker email/address; `OVER_THRESHOLD` → scale line quantities so total lands in `[reviewThreshold*1.2, cfoThreshold*1.5]`; `MISSING_PO` → force total ≥ `poRequiredAbove` (but < reviewThreshold) and `poNumber = null`; `FOREIGN_CURRENCY` → currency ∈ EUR/GBP/PHP.
- Guarantee at least one clean invoice when `count ≥ 2`.

- [ ] **Step 1: Write failing renderer tests** — `renderDocument(FIXTURE_INVOICE, "plain") === PLAIN_TEXT`, same for email/table; null due/PO/notes remove the right lines; table rows are all 64 chars.
- [ ] **Step 2: Implement `rng.ts`, `renderers.ts`**, run tests → pass.
- [ ] **Step 3: Write failing generator tests** — same seed ⇒ deep-equal manifests; `count` documents; `defectRate: 0` ⇒ zero defects and all totals < 5000; `defectRate: 1, count: 12` ⇒ ≥ 6 distinct codes and a `DUPLICATE_NUMBER` invoice whose number equals an earlier one; every `groundTruth[i].id === documents[i].id`; each document text contains its invoice number; `InvoiceSchema.parse` succeeds for all.
- [ ] **Step 4: Implement `defects.ts`, `generator.ts`**, run tests → pass.
- [ ] **Step 5: Write failing batch-store + ledger tests** (use `fs.mkdtemp` under `os.tmpdir()`): write/read manifest round-trip; `readManifest` throws mentioning the batch id when absent; `listBatches` sorted; ledger `load` of a missing file is empty; `append`+`save`+`load` round-trip; `find` excludes `excludeBatchId`; `findSimilar` respects the window.
- [ ] **Step 6: Implement `batch-store.ts`, `ledger.ts`**, run tests → pass; `npm run typecheck` clean.

---

### Task 2: LLM layer — text parser, ScriptedChatModel, responders, factory, chains

**Files:**
- Create: `src/llm/text-parser.ts`, `src/llm/fake-model.ts`, `src/llm/responders/router.ts`, `src/llm/responders/extract.ts`, `src/llm/responders/categorize.ts`, `src/llm/responders/investigate.ts`, `src/llm/responders/summarize.ts`, `src/llm/factory.ts`, `src/chains/extract.ts`, `src/chains/categorize.ts`, `src/chains/summarize.ts`
- Test: `tests/llm/text-parser.test.ts`, `tests/llm/fake-model.test.ts`, `tests/llm/factory.test.ts`, `tests/chains/extract.test.ts`, `tests/chains/categorize.test.ts`, `tests/chains/summarize.test.ts`

**Interfaces:**
- Consumes: schemas; `TOOL_NAMES`, `PROMPT_MARKERS`, `SYSTEM_MARKERS`, `INVESTIGATOR_TOOL_NAMES` (constants); `VENDORS`, `findVendor`; `GL_ACCOUNTS`; `ModelBundle`, `Tagged`, `ChainBuilder`, `ProviderTag` (`src/llm/types.ts`); `TransientModelError`, `isRetryableError`; `AppConfig`; fixture.
- Produces:
  - `parseInvoiceText(text: string): ExtractedInvoice` — heuristic inverse of the three renderers (never throws; unknown layout ⇒ nulls + low confidence + warning).
  - `class ScriptedChatModel extends BaseChatModel<ScriptedCallOptions>` with `constructor(fields?: { failureRate?: number; latencyMs?: number; seed?: number })`, `bindTools(tools)`, `_generate`, `_streamResponseChunks`, `_llmType() === "scripted-invoice-model"`, and `readonly calls: number` counter. Identifies itself with `lc_name() === "ScriptedChatModel"`.
  - `createModels(config: AppConfig): ModelBundle` — `fake` ⇒ primary = ScriptedChatModel (no fallback); `anthropic` ⇒ primary = `ChatAnthropic` + fallback = ScriptedChatModel. Both get `cache: new InMemoryCache()`.
  - `resilient<I,O>(models: ModelBundle, build: ChainBuilder<I,O>, opts?: { runName?: string; onFallback?: (err: Error) => void }): Runnable<I, Tagged<O>>` — `build(primary).pipe(tag) .withRetry({ stopAfterAttempt: models.maxRetries, onFailedAttempt })` and, if a fallback exists, `.withFallbacks([build(fallback).pipe(tag)])`. `onFailedAttempt` must **throw** non-retryable errors (see `isRetryableError`) so retries only cover transient ones. Fallback use must call `opts.onFallback` (default: `console.warn`).
  - `buildExtractChain: ChainBuilder<{ document: RawInvoiceDocument }, ExtractedInvoice>` — `RunnableSequence.from([RunnableLambda(format input), ChatPromptTemplate.fromMessages([["system", EXTRACT_SYSTEM], ["human", "{payload}"]]), model.withStructuredOutput(ExtractedInvoiceSchema, { name: TOOL_NAMES.extract }), RunnableLambda((raw) => ExtractedInvoiceSchema.parse(raw))])`. The human payload is `${PROMPT_MARKERS.documentOpen}\n${text}\n${PROMPT_MARKERS.documentClose}` (escape `{`/`}` by passing the text as a variable, never by template interpolation of the text). `EXTRACT_SYSTEM` starts with `SYSTEM_MARKERS.extract` and tells the model to copy values exactly, never recompute totals, use null when absent, normalise dates to YYYY-MM-DD, and rate confidence.
  - `buildCategorizeChain: ChainBuilder<{ extracted: ExtractedInvoice; vendorHint: string | null }, Categorization>` — `FewShotChatMessagePromptTemplate` with 5 examples (vendor + line descriptions → category), system starts with `SYSTEM_MARKERS.categorize`, human contains `PROMPT_MARKERS.extractedOpen` + a compact JSON of `{vendorName, lineItems: descriptions}` + close marker and, when present, `${PROMPT_MARKERS.vendorHint} ${vendorHint}`; `withStructuredOutput(CategorizationSchema, { name: TOOL_NAMES.categorize })`; parse; force `glAccount = GL_ACCOUNTS[category]` in a final lambda (the model may hallucinate codes).
  - `buildSummaryChain: ChainBuilder<{ stats: BatchStats; highlights: string[] }, string>` — prompt (system starts with `SYSTEM_MARKERS.summarize`; human wraps `JSON.stringify(stats)` in `statsOpen/Close` then a "Highlights:" bullet list) `.pipe(model).pipe(new StringOutputParser())`. Must support `.stream()`.

**ScriptedChatModel behaviour (the router):**
1. Fault injection first: if `failureRate > 0` and seeded `rng.chance(failureRate)` ⇒ throw `TransientModelError` (count the call regardless). Then `await sleep(latencyMs)` if set.
2. Collect bound tool names (normalise OpenAI `{type:"function", function:{name,parameters}}`, Anthropic `{name, input_schema}`, and `StructuredToolInterface` `{name, schema}`), both from `this.boundTools` and `options.tools`.
3. Route, in order:
   - bound tool `TOOL_NAMES.extract` ⇒ **extract responder**: find the text between `documentOpen`/`documentClose` in the last human message, `parseInvoiceText`, return one tool call `{ name: extract, args }`.
   - bound tool `TOOL_NAMES.categorize` ⇒ **categorize responder**: parse the JSON between `extractedOpen/Close`; if a `vendorHint` line exists use that category (confidence 0.9), else keyword rules over descriptions (e.g. `hours|compute|storage|hosting` → CLOUD_HOSTING, `license|subscription|seat|software` → SOFTWARE, `paper|toner|pens|stapler` → OFFICE_SUPPLIES, `consulting|advisory|legal|retainer` → PROFESSIONAL_SERVICES, `flight|hotel|taxi|travel|per diem` → TRAVEL, `campaign|ads|design|branding` → MARKETING, `electricity|water|gas|utility` → UTILITIES, `laptop|monitor|server|printer|hardware` → EQUIPMENT, else OTHER, confidence 0.7); `glAccount = GL_ACCOUNTS[category]`.
   - any bound tool in `INVESTIGATOR_TOOL_NAMES` ⇒ **investigate responder**: if the last message is a `HumanMessage` (turn 1) return parallel tool calls for every bound investigator tool with args derived from the JSON object inside `extractedOpen/Close` in that message (`recompute_totals` gets `{lineItems, subtotal, taxRate, taxAmount, total}`, `lookup_vendor` `{name}`, `find_duplicates` `{invoiceNumber, vendorName, total, issueDate}`, `search_policy` `{query: "approval threshold purchase order unknown vendor duplicate"}`); if the last message is a `ToolMessage` (turn 2) build the brief from the tool outputs and either (a) if a bound tool exists whose name is **not** in `INVESTIGATOR_TOOL_NAMES` (that is `createAgent`'s structured-response tool) return a tool call to it with `{ brief, recommendation, confidence, toolsUsed }`, or (b) return plain text `brief`. Recommendation: any ledger duplicate ⇒ `reject`; unknown vendor or math mismatch ⇒ `escalate`; else `approve`.
   - otherwise ⇒ **summarize responder**: parse the JSON between `statsOpen/Close` and produce 3–5 sentences (totals, approvals, rejections, top issues, top category). Streaming yields word-by-word chunks.
4. Always attach `usage_metadata` (`input_tokens ≈ chars/4`, `output_tokens ≈ chars/4`) and `response_metadata: { provider: "fake" }`.

- [ ] **Step 1: Failing text-parser tests** — each fixture text parses to `FIXTURE_EXTRACTED` (table: `vendorName === TABLE_VENDOR_NAME`); missing Due/PO ⇒ nulls; garbage input ⇒ all nulls, `confidence < 0.3`, one warning.
- [ ] **Step 2: Implement `text-parser.ts`** (date normalisers for ISO / `DD Mon YYYY` / `MM/DD/YYYY`; line-item regexes for the three layouts; vendor name from the `From:` block, the `Subject: … from X`, or the first table row minus `INVOICE`). Tests pass.
- [ ] **Step 3: Failing fake-model tests** — `withStructuredOutput(ExtractedInvoiceSchema, {name: extract}).invoke([system, human(PLAIN_TEXT wrapped)])` returns the fixture values; categorize path honours the hint; investigate turn 1 returns 4 tool calls, turn 2 with `ToolMessage`s returns a structured report tool call when a 5th tool is bound; `failureRate: 1` throws `TransientModelError`; `stream()` on a summary prompt yields > 3 chunks whose concatenation equals `invoke()` text; `calls` increments.
- [ ] **Step 4: Implement `fake-model.ts` + responders**, tests pass.
- [ ] **Step 5: Failing chain + factory tests** — `buildExtractChain(new ScriptedChatModel())` on each fixture format returns a schema-valid `ExtractedInvoice` equal to `FIXTURE_EXTRACTED` (+confidence ≥ 0.8); categorize chain with hint `CLOUD_HOSTING` returns that category and `glAccount "6110"`; summary chain returns non-empty text mentioning the total count; `resilient()` with `failureRate: 1` primary and a clean fallback returns `provider: "fake"` and calls `onFallback`; with `failureRate: 0.5, seed` it eventually succeeds within `maxRetries`; `createModels({llmProvider:"fake"})` returns no fallback; `createModels` with anthropic + a dummy key returns a `ChatAnthropic` primary and a Scripted fallback (do not invoke it).
- [ ] **Step 6: Implement `factory.ts`, `chains/*.ts`**, tests pass; `npm run typecheck` clean.

---

### Task 3: Tools + RAG

**Files:**
- Create: `src/rag/policy-retriever.ts`, `src/tools/recompute-totals.ts`, `src/tools/lookup-vendor.ts`, `src/tools/find-duplicates.ts`, `src/tools/search-policy.ts`, `src/tools/index.ts`
- Test: `tests/rag/policy-retriever.test.ts`, `tests/tools/tools.test.ts`

**Interfaces:**
- Consumes: `renderPolicyDocument`, `DEFAULT_POLICY`, `ApprovalPolicy`; `findVendor`, `VENDORS`; `LedgerReader`; `ValidationIssue`; `TOOL_NAMES`; `MONEY_TOLERANCE`; `ToolKit` (`src/pipeline/types.ts`).
- Produces:
  - `class PolicyRetriever extends BaseRetriever` — `static async fromPolicy(policy?: ApprovalPolicy, opts?: { k?: number }): Promise<PolicyRetriever>`; splits the rendered markdown with `MarkdownTextSplitter` from `@langchain/textsplitters` (`chunkSize: 400, chunkOverlap: 0`) into `Document`s with `metadata.section` (the `##` heading), ranks with BM25 (k1 = 1.5, b = 0.75, own implementation, lower-cased alphanumeric tokens), returns top `k` (default 3) with `metadata.score`.
  - `createTools(deps: { ledger: LedgerReader; retriever: PolicyRetriever; policy: ApprovalPolicy; batchId: string }): ToolKit`.
  - Tool contracts (zod input → JSON-serialisable object output; tools **return** objects, LangChain stringifies for ToolMessages):
    - `recompute_totals({ lineItems: {quantity,unitPrice,amount}[] (nullable numbers), subtotal, taxRate, taxAmount, total })` → `{ computedLineSum, computedTax, computedTotal, lineSumMatches, totalMatches, issues: ValidationIssue[] }` using `MONEY_TOLERANCE`; null inputs ⇒ `MISSING_FIELD` warnings, no false mismatches.
    - `lookup_vendor({ name })` → `{ found: boolean; vendorId?, canonicalName?, approved?, defaultCategory?, matchedOn?, score? }`.
    - `find_duplicates({ invoiceNumber, vendorName, total, issueDate })` → `{ exact: LedgerEntry[]; similar: LedgerEntry[] }` (uses `ledger.find(n, batchId)` and `findSimilar` with `policy.duplicateWindowDays`).
    - `search_policy({ query })` → `{ excerpts: { section: string; text: string; score: number }[] }`.
  - Also export pure helpers used by the graph's `validate` node (so the node doesn't need to go through tool invocation for deterministic checks): `checkTotals(extracted): ValidationIssue[]`, `checkDates(extracted): ValidationIssue[]`, `checkVendor(extracted): { issues: ValidationIssue[]; match: VendorMatch | null }`, `checkPolicy(extracted, category: Category | null, policy): ValidationIssue[]` (OVER_REVIEW_THRESHOLD / OVER_CFO_THRESHOLD / MISSING_PO / FOREIGN_CURRENCY / LOW_CONFIDENCE), `checkLedgerDuplicates(extracted, ledger, batchId, policy): ValidationIssue[]`. Put them in `src/tools/checks.ts`.

- [ ] **Step 1: Failing retriever tests** — `invoke("purchase order required")` top hit section is `Purchase orders`; `"unknown vendor"` → `Vendors`; `"duplicate invoice"` → `Duplicates`; returns ≤ k docs; scores descending.
- [ ] **Step 2: Implement `policy-retriever.ts`**, tests pass.
- [ ] **Step 3: Failing tool tests** — recompute on the fixture ⇒ both match, no issues; total+10 ⇒ `TOTAL_MISMATCH` error; subtotal+5 ⇒ `LINE_SUM_MISMATCH`; null total ⇒ `MISSING_FIELD` warning only; lookup `"ACME CLOUD INC"` ⇒ found `v-001`; `"Acme Cloud"` alias; `"Totally Unknown GmbH"` ⇒ not found; find_duplicates against an in-memory `LedgerReader` stub returns exact + similar; search_policy returns excerpts with sections; `checkPolicy` flags 6000 total as OVER_REVIEW_THRESHOLD, 30000 also OVER_CFO_THRESHOLD, 2500 with null PO ⇒ MISSING_PO, EUR ⇒ FOREIGN_CURRENCY, TRAVEL 3500 ⇒ OVER_REVIEW_THRESHOLD (category override); `checkDates` flags due < issue and missing due; `createTools(...).all` has 4 tools with the `TOOL_NAMES` names and each `invoke`s with a plain object.
- [ ] **Step 4: Implement tools + checks + index**, tests pass; typecheck clean.

---

### Task 4: Output — stats, reports, sinks, observability, evaluate

**Files:**
- Create: `src/pipeline/stats.ts`, `src/report/html.ts`, `src/report/markdown.ts`, `src/report/csv.ts`, `src/sinks/console.ts`, `src/sinks/file.ts`, `src/sinks/email.ts`, `src/sinks/index.ts`, `src/observability/usage-tracker.ts`, `src/observability/progress.ts`, `src/evaluate/evaluate.ts`
- Test: `tests/pipeline/stats.test.ts`, `tests/report/report.test.ts`, `tests/sinks/sinks.test.ts`, `tests/observability/usage-tracker.test.ts`, `tests/evaluate/evaluate.test.ts`

**Interfaces:**
- Consumes: `BatchResult`, `ProcessedInvoice`, `BatchStats`, `BatchManifest`, `Invoice`, `DeliveryReceipt`; `Sink`, `SinkContext`, `receipt`; `Logger`; `ProgressEvent`; `AppConfig["email"]`; `estimateCostUsd`.
- Produces:
  - `computeStats(processed: ProcessedInvoice[]): BatchStats`.
  - `renderHtmlReport(result: BatchResult): string` (email-safe: tables + inline styles, no external assets; header stats, per-invoice table — number, vendor, total+currency, category, risk level, decision, issue codes — then the summary paragraph, then flagged-invoice briefs). `renderMarkdownReport(result): string`. `toCsv(processed): string` (RFC-4180 quoting; columns `documentId,invoiceNumber,vendorName,issueDate,dueDate,currency,total,category,riskLevel,riskScore,decision,decidedBy,issues,provider`).
  - `class ConsoleSink implements Sink` (`name: "console"`): prints the processed table with `cli-table3` + picocolors (decision coloured), the stats line, the summary; returns ok receipt.
  - `class FileSink implements Sink` (`name: "file"`): writes `processed/results.json`, `processed/results.csv`, `report.html`, `report.md` under `ctx.batchDir`; receipt detail lists the paths; any fs error ⇒ `ok: false` with the message.
  - `class EmailSink implements Sink` (`name: "email"`): `constructor(opts: { to: string; from: string; smtp?: { host; port; user?; pass?; secure }; transportFactory?: () => Promise<Transporter> })`. Transport resolution: `transportFactory` (tests) → SMTP from opts → `nodemailer.createTestAccount()` Ethereal; if Ethereal creation fails (offline) → `nodemailer.createTransport({ jsonTransport: true })` and write the JSON message to `ctx.batchDir/email.json`, receipt detail says `"offline: message written to …"`. Sends HTML body = `renderHtmlReport`, attachments `results.json` + `results.csv`. On Ethereal, detail includes `nodemailer.getTestMessageUrl(info)`. Never throws.
  - `createSinks(opts: { email?: { to: string; from: string; smtp?: … } | null }): Sink[]` → `[console, file, (email)]`.
  - `class UsageTracker extends BaseCallbackHandler` (`name = "usage-tracker"`): records per LLM run `{ runId, model, runName?, startedAt, ms, inputTokens, outputTokens, error? }` from `handleChatModelStart`/`handleLLMEnd`(use `output.llmOutput?.tokenUsage` or `generations[0][0].message.usage_metadata`)/`handleLLMError`; tool runs from `handleToolStart/End/Error`; `summary(): { llmCalls, llmErrors, toolCalls, inputTokens, outputTokens, totalMs, estimatedCostUsd, byModel: Record<string, {calls, inputTokens, outputTokens}> }`; `renderSummary(): string` (one compact table). Model name comes from `extraParams.invocation_params.model` or `llm.id.at(-1)`.
  - `createProgressPrinter(logger: Logger, opts?: { showTokens?: boolean }): { onEvent(mode: string, chunk: unknown): void; finish(): void }` — handles tuples from `streamMode: ["updates","custom","messages"]`: `custom` ⇒ `ProgressEvent` lines (`node_end` as `✓ extract doc-003 (412 ms)`), `messages` ⇒ token chunks from the summarize node written inline without newline (detect via `metadata.langgraph_node === "summarize"`), `updates` ⇒ debug lines listing the node names; `__interrupt__` key ⇒ info line.
  - `evaluateBatch(manifest: BatchManifest, result: BatchResult): EvaluationReport` where `interface EvaluationReport { fields: Record<string, { correct: number; total: number; accuracy: number }>; overallFieldAccuracy: number; defects: { code: string; injected: number; caught: number; recall: number }[]; overallDefectRecall: number; perDocument: { documentId; defects: string[]; caughtIssues: string[]; decision: string }[] }` — field comparison is normalised (trimmed, lower-cased strings; numbers within 0.01; `lineItems` compared by length); defect→issue map: `MATH_MISMATCH→[TOTAL_MISMATCH]`, `LINE_SUM_MISMATCH→[LINE_SUM_MISMATCH]`, `DUE_BEFORE_ISSUE→[DUE_BEFORE_ISSUE]`, `MISSING_DUE_DATE→[MISSING_DUE_DATE]`, `DUPLICATE_NUMBER→[DUPLICATE_IN_BATCH, DUPLICATE_IN_LEDGER]`, `UNKNOWN_VENDOR→[UNKNOWN_VENDOR]`, `OVER_THRESHOLD→[OVER_REVIEW_THRESHOLD, OVER_CFO_THRESHOLD]`, `MISSING_PO→[MISSING_PO]`, `FOREIGN_CURRENCY→[FOREIGN_CURRENCY]`. `renderEvaluation(report): string` table.

- [ ] **Step 1: Failing stats/report/csv tests** — build 3 `ProcessedInvoice` fixtures (approved / human-rejected / auto-rejected) inline in a `tests/fixtures/processed.ts` helper (export `makeProcessed(overrides)` + `makeBatchResult()`); `computeStats` counts and `issuesByCode`; HTML contains each invoice number and no `<script`; CSV has header + 3 rows and quotes a description containing a comma; markdown has a table row per invoice.
- [ ] **Step 2: Implement `stats.ts`, `report/*.ts`**, tests pass.
- [ ] **Step 3: Failing sink tests** — FileSink writes the four files into a temp dir and the receipt lists them; FileSink with an unwritable path (a file used as a directory) returns `ok: false`; EmailSink with `transportFactory: () => nodemailer.createTransport({ jsonTransport: true })` returns ok and the transporter's `sendMail` got `to`, an `html` containing an invoice number, and 2 attachments (spy via a wrapping factory); ConsoleSink with a memory logger prints every invoice number.
- [ ] **Step 4: Implement sinks**, tests pass.
- [ ] **Step 5: Failing tracker/progress/evaluate tests** — tracker: call `handleChatModelStart` then `handleLLMEnd` with a fake `LLMResult` carrying `usage_metadata` ⇒ summary tokens add up and `estimatedCostUsd` is 0 for model `scripted-invoice-model` and > 0 for `claude-opus-5`; progress printer formats a `node_end` event and collects summarize tokens on one line; evaluate on a hand-built manifest/result ⇒ accuracy 1 for matching fields, recall 1 for a caught defect and 0 for a missed one.
- [ ] **Step 6: Implement `usage-tracker.ts`, `progress.ts`, `evaluate.ts`**, tests pass; typecheck clean.

---

### Task 5: Graphs, investigator agent, pipeline runner

**Files:**
- Create: `src/agents/investigator.ts`, `src/graph/checkpointer.ts`, `src/graph/invoice.graph.ts`, `src/graph/batch.graph.ts`, `src/pipeline/run-batch.ts`, `src/pipeline/context.ts`
- Test: `tests/graph/invoice.graph.test.ts`, `tests/graph/batch.graph.test.ts`, `tests/pipeline/run-batch.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4 plus `InvoiceState`, `BatchState`, `ProcessInvoiceInput`, `upsertResults`; `PipelineContext`, `ProgressEvent`, `ReviewRequest`, `Reviewer`, `ReviewMode`.
- Produces:
  - `buildInvestigator(models: ModelBundle, tools: ToolKit)` → `{ investigate(extracted, issues, risk): Promise<Investigation> }` using `createAgent({ model: models.primary, tools: tools.all, systemPrompt, middleware: [toolCallLimitMiddleware({ threadLimit: 8 }), modelRetryMiddleware({ maxRetries: models.maxRetries })], responseFormat: toolStrategy(InvestigationSchema, { name: TOOL_NAMES.investigationReport }) })`; on agent failure returns `{ brief: "Investigation unavailable: <reason>", recommendation: "escalate", confidence: 0, toolsUsed: [] }` and logs a warning.
  - `createCheckpointer(kind: "memory" | "sqlite", outDir: string): BaseCheckpointSaver` (sqlite path `out/checkpoints.sqlite` via `SqliteSaver.fromConnString`).
  - `buildInvoiceGraph()` → compiled subgraph; `buildBatchGraph(opts: { checkpointer })` → compiled batch graph. Both export `PipelineContextSchema = z.custom<PipelineContext>()`.
  - `createPipelineContext(opts: { config: AppConfig; batchId: string; batchDir: string; logger: Logger; sinks: Sink[]; models?: ModelBundle }): Promise<PipelineContext>` (loads ledger `out/ledger.json`, builds retriever, tools).
  - `runBatch(opts: { manifest: BatchManifest; config: AppConfig; context: PipelineContext; checkpointer?: BaseCheckpointSaver; reviewer: Reviewer; threadId?: string; callbacks?: BaseCallbackHandler[]; onStream?: (mode: string, chunk: unknown) => void }): Promise<{ result: BatchResult; threadId: string; checkpoints: number }>` — the interrupt/resume loop from the spike; after completion appends final decisions to the ledger and saves it.
  - `autoReviewer(mode: "approve" | "reject"): Reviewer`; `interactiveReviewer(logger): Reviewer` (readline prompt `approve / reject [note]`) lives in `src/cli/reviewers.ts` in Task 6 — Task 5 only needs `autoReviewer` (put it in `run-batch.ts`).

**Invoice subgraph nodes** (each wraps work in a timer and returns `timings: { [node]: ms }`; emits `node_start`/`node_end` via `config.writer`):
- `extract` (retryPolicy `{ maxAttempts: 3, retryOn: isRetryableError }`): `resilient(models, buildExtractChain).invoke({ document })` → `{ extracted, provider }`; on final failure ⇒ `{ extracted: null, issues: [EXTRACTION_FAILED error], decision: "auto_rejected" }`.
- `validate`: skip if `extracted` null; `checkTotals + checkDates + checkVendor + checkLedgerDuplicates` → `{ issues }`.
- `categorize`: skip if null; vendor hint from `findVendor(extracted.vendorName)?.vendor.defaultCategory`; `resilient(models, buildCategorizeChain)` → `{ categorization }`; on failure ⇒ `{ categorization: null, issues: [MISSING_FIELD warning "category unavailable"] }`.
- `assess_risk` (runs after both branches): `checkPolicy(extracted, categorization?.category, policy)` adds issues; score = Σ(error 35, warning 12) + 20 if UNKNOWN_VENDOR + 25 if any threshold issue, capped 100; level `< 25 low`, `< 60 medium`, else high; reasons = issue messages; `policyExcerpts` = `retriever.invoke(<issue codes joined>)` page contents (top 2).
- router `routeAfterRisk`: `extracted === null || issues.some(i => i.code === "DUPLICATE_IN_LEDGER")` ⇒ `auto_reject`; `risk.level !== "low"` ⇒ `investigate`; else `auto_approve`.
- `investigate` → `{ investigation }`; `flag_for_review` → `{ decision: "needs_review" }`; `auto_approve` → `{ decision: "auto_approved" }`; `auto_reject` → `{ decision: "auto_rejected" }`. Edges: `START→extract`, `extract→validate`, `extract→categorize`, `validate→assess_risk`, `categorize→assess_risk`, conditional from `assess_risk`, `investigate→flag_for_review`, terminal nodes → `END`.

**Batch graph nodes:** `load` (sets `startedAt`), `fan_out` (passthrough; conditional edge returns `Send("process_invoice", { document })` per doc), `process_invoice` (`{ input: ProcessInvoiceInput }`; invokes the subgraph with the parent config; maps to `ProcessedInvoice` with `decidedBy: "system"`, `reviewerNote: null`), `collect` (intra-batch duplicates: group non-null invoice numbers, keep the first documentId, later ones get `DUPLICATE_IN_BATCH` error + `auto_rejected`; `stats = computeStats`; `reviewQueue` = ids with `needs_review`), `review_next` (interrupt with a `ReviewRequest`; validate the resume payload with `ReviewActionSchema.safeParse`, on failure `interrupt` again with `{ ...request, error }`; apply decision `approved_by_human`/`rejected_by_human`, `decidedBy: "human"`, `reviewerNote`), `summarize` (recompute stats; highlights = one line per non-auto-approved invoice; `resilient(models, buildSummaryChain).stream(...)` concatenated — streaming tokens surface through `streamMode: "messages"`), `deliver` (`Promise.allSettled(sinks.map(s => s.deliver(result, ctx)))` → receipts, rejected promises become `ok: false` receipts; sets `finishedAt`). Edges: `START→load→fan_out ⇒Send⇒ process_invoice→collect`, conditional `collect`/`review_next` → `review_next | summarize`, `summarize→deliver→END`.

- [ ] **Step 1: Failing invoice-graph tests** — using `generateBatch({count: 12, seed: 7, defectRate: 1})` pick documents by ground-truth defect and assert: clean ⇒ `auto_approved`, `MATH_MISMATCH` ⇒ `needs_review` with `TOTAL_MISMATCH` + an investigation; `UNKNOWN_VENDOR` ⇒ `needs_review`; a ledger seeded with the doc's number ⇒ `auto_rejected` with `DUPLICATE_IN_LEDGER`; `timings` has `extract`, `validate`, `categorize`, `assess_risk`; `provider === "fake"`; with `fakeFailureRate: 1` ⇒ `auto_rejected` + `EXTRACTION_FAILED`.
- [ ] **Step 2: Implement `investigator.ts`, `invoice.graph.ts`, `context.ts`, `checkpointer.ts`**, tests pass.
- [ ] **Step 3: Failing batch-graph + runner tests** — batch of 10 (seed 42, defectRate 0.5) with `autoReviewer("approve")`: every result has a final decision (no `needs_review`), `stats.total === 10`, `summary` non-empty, `deliveries` has one ok receipt per sink (use a `FileSink` on a temp dir + a stub sink), `checkpoints > 0`; with `autoReviewer("reject")` flagged ones are `rejected_by_human`; a custom reviewer that records requests sees `remaining` counting down; an invalid reviewer payload (cast) triggers a second interrupt with `error`; duplicate-number batch yields exactly one `DUPLICATE_IN_BATCH`; ledger file has `stats.total` new rows after the run and a second run of the same batch does **not** flag ledger duplicates.
- [ ] **Step 4: Implement `batch.graph.ts`, `run-batch.ts`**, tests pass; typecheck clean.

---

### Task 6: CLI + examples

**Files:**
- Create: `src/cli.ts`, `src/cli/reviewers.ts`, `src/cli/preview.ts`, `src/cli/commands.ts`, `examples/lcel-basics.ts`, `examples/streaming.ts`, `examples/retry-fallback.ts`, `examples/time-travel.ts`

**Commands** (commander, all `async`, exit code 1 on failure or any `ok: false` delivery):
- `generate [-n 10] [--seed 42] [--defect-rate 0.35] [--batch-id]` → `generateBatch` + `writeBatch` + raw preview table (`id, format, invoice # (from ground truth), vendor, total, defects`) — note the preview labels ground-truth columns as "(truth)".
- `preview <batchId> [--show <docId>] [--ground-truth]`.
- `run <batchId> [--provider fake|anthropic] [--model] [--review interactive|approve|reject] [--email <to>] [--chaos <rate>] [--checkpointer memory|sqlite] [--concurrency n]` → `loadConfig(overrides)`, context, `UsageTracker`, `createProgressPrinter`, `runBatch`, then the processed table (ConsoleSink already prints it), usage summary, delivery receipts, and `evaluate` summary if the manifest has ground truth.
- `resume <threadId> --decision approve|reject [--note]` → requires `CHECKPOINTER=sqlite` / `--checkpointer sqlite`; resumes one interrupt and continues with `--review` mode for the rest.
- `evaluate <batchId>`; `graph [--which invoice|batch|both]` prints Mermaid; `demo [-n] [--seed] [--review] [--email]` = generate → run → evaluate.
- `interactiveReviewer(logger)` uses `node:readline/promises` (`approve`/`reject`, optional note after a space; invalid input re-prompts).

**Examples** (each ≤ 80 lines, prints what it demonstrates):
- `lcel-basics.ts`: `ChatPromptTemplate | model | StringOutputParser`, `RunnableParallel` running categorize + summary prompts at once, `.batch()` over 3 inputs with `maxConcurrency: 2`, `RunnableLambda`, `withConfig({ runName, tags })`.
- `streaming.ts`: `.stream()` tokens, `streamEvents({ version: "v2" })` event names, LangGraph `streamMode: ["updates","custom"]` on the invoice subgraph.
- `retry-fallback.ts`: `ScriptedChatModel({ failureRate: 0.7, seed: 1 })` through `resilient()` showing attempts + fallback + `provider` tag; node `retryPolicy` logs.
- `time-travel.ts`: run a 3-invoice batch, list `getStateHistory`, pick the checkpoint after `collect`, `updateState` to flip one decision, resume from that checkpoint.

- [ ] **Step 1: Implement CLI files**; `npm run cli -- --help` lists all commands.
- [ ] **Step 2: `npm run demo -- -n 8 --seed 42 --review approve`** runs end-to-end offline: raw preview, progress, streamed summary, processed table, usage table, receipts, evaluation.
- [ ] **Step 3: Implement examples**; run each once; typecheck clean.

---

### Task 7: README + feature map

- `README.md`: what it is, quickstart (install → demo), the two provider modes (+ exact env vars, cost note for `claude-opus-5`), email modes (Ethereal / SMTP / Resend-via-SMTP), CLI reference, architecture Mermaid (from `npm run graph`), sample output excerpt, project layout, testing, honest note that the fake model is rule-based.
- `docs/FEATURES.md`: two tables — LangChain features (≥ 14 rows) and LangGraph features (≥ 12 rows) — each row `Feature | Where (file:symbol) | What to look at`.

### Task 8: Verification

- `npm run typecheck`, `npm test`, `npm run demo`, every example, `npm run graph`; a code-review pass (silent failures, error handling, spec coverage); fix findings; record real output in the README sample.
