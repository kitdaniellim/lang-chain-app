# Implementation plan — lang-chain-app (Python/FastAPI/React/Supabase)

Spec: `docs/SPEC.md`. Foundation already written (do not change shape without saying so):
`backend/app/schemas.py` (extraction schema + API contract), `backend/app/config.py` (settings),
`backend/.env.example`, `backend/requirements.txt` (installed in `backend/.venv`), `.gitignore`.

Global constraints: Python 3.12, type hints everywhere, `ruff`-clean style, comments 1–2 lines; never swallow
errors; no network in tests; `langchain`/`langgraph`/`langchain-anthropic` only (no `langchain-community`);
model id `claude-sonnet-5` from settings; the app must run with no `ANTHROPIC_API_KEY` (LLM endpoints return 503
`{error}`); all money as `float` rounded to 2 dp at the boundary; SQLite and Postgres both supported through
SQLAlchemy 2.x (no dialect-specific SQL outside `migrations/`).

Run the backend venv with `backend/.venv/Scripts/python` (Windows). Do NOT run git.

## Task A — Backend (`backend/`)

Files: `app/db.py`, `app/models.py`, `app/validation.py`, `app/extraction.py`, `app/sql_tools.py`,
`app/query_agent.py`, `app/raw_samples.py`, `app/seed.py`, `app/routers/invoices.py`, `app/routers/chat.py`,
`app/main.py`, `migrations/001_invoices.sql`, `tests/…`, `README-backend` section content (hand to the docs step).

1. **db.py / models.py** — `engine` from `settings.effective_database_url` (`pool_pre_ping=True`; for SQLite
   `check_same_thread=False`), `SessionLocal`, `get_session()` FastAPI dependency, `init_db()` that runs
   `Base.metadata.create_all` (SQLite and Postgres — the migration file is for people applying schema by hand /
   Supabase SQL editor; keep both in sync). `Invoice` ORM model matching SPEC §3 (`line_items`/`review_notes` as
   `JSON`, money as `Numeric(12,2)` read back as float, `created_at` default now UTC).
2. **validation.py** — `validate_invoice(inv: Invoice) -> list[str]` notes; rules: line amounts sum ≠ subtotal
   (±0.011), subtotal + tax ≠ total, due_date < invoice_date, empty line_items, currency not 3 uppercase letters,
   any line with quantity ≤ 0 or negative amounts, total ≤ 0. `needs_review = bool(notes)`.
3. **extraction.py** — `build_extractor(settings) -> Runnable` = `ChatAnthropic(model=settings.anthropic_model,
   api_key=…, temperature=0, max_tokens=4096).with_structured_output(Invoice)` behind a `ChatPromptTemplate`
   (system: copy values exactly, never recompute totals, ISO dates, infer currency from symbols, `status` paid only
   if the document says so). `extract_invoice(text, settings) -> ExtractionResult(invoice, notes, needs_review,
   model)`. Raise `LLMNotConfigured` when no key; wrap provider errors in `ExtractionError(message)`.
   Inject the chat model through a parameter (`model: BaseChatModel | None`) so tests pass a fake.
4. **sql_tools.py** — three `@tool`s bound to a SQLAlchemy engine: `list_tables()`, `describe_table(table)`
   (columns + types + 3 sample rows), `run_sql(query)` — **read-only guard**: single statement, must start with
   `SELECT`/`WITH`, reject `;` chaining and any of `insert|update|delete|drop|alter|create|truncate|grant|attach|pragma`
   as whole words, enforce `LIMIT settings.sql_row_limit` when absent, 10 s statement timeout where the dialect
   supports it; returns rows as a compact markdown table (header + rows) or `"(no rows)"`. Every executed query is
   appended to a `ContextVar[list[str]]` (`executed_sql`) so the agent layer can report `sql_query_used`.
5. **query_agent.py** — `build_agent(engine, model)` = `langchain.agents.create_agent(model, tools,
   system_prompt=…)`; system prompt: today's date, the `invoices` schema summary, "always inspect schema first if
   unsure, use run_sql for facts, answer in 1–3 sentences with the numbers, mention currency, never guess".
   `ask(question, engine, settings, model=None) -> ChatResponse`: resets `executed_sql`, invokes
   `{"messages":[HumanMessage(question)]}`, answer = last AI message text, `sql_query_used` = executed statements
   joined by `";\n"` (or `""`). `recursion_limit` 12. Same LLMNotConfigured / AgentError handling.
6. **raw_samples.py** — three realistic raw invoice texts (an email body, a plain-text invoice, an OCR-ish table)
   with their known expected values (used as the fallback when there is no key and as test fixtures).
7. **seed.py** — `seed(session, settings, *, count=17, seed=42, model=None) -> SeedReport`: Faker-seeded vendors
   (12 fictional companies), 1–8 line items, currencies USD/EUR/GBP/PHP, invoice dates in the last 120 days, due in
   15/30/45 days, statuses: ~5 paid, ~4 overdue (due < today, unpaid), rest pending; plus the three raw samples via
   `extract_invoice` when a key exists (`source="extracted"`, `raw_text` stored) else from known values
   (`source="seed-fallback"`). Idempotent: skips if the table has rows unless `force=True`. CLI:
   `python -m app.seed [--force] [--count N]` prints a summary table.
8. **routers + main.py** — endpoints per SPEC §4; CORS from settings; `GET /health`; startup runs `init_db()` and,
   if the table is empty, `seed()` (log the outcome). Errors → `{error}` JSON via exception handlers.
   `POST /invoices/upload`: `.txt/.md` decoded as UTF-8, `.pdf` via `pypdf` (text of all pages), size ≤ 2 MB,
   otherwise 415/413.
9. **tests** (pytest, SQLite temp file, `ANTHROPIC_API_KEY` unset): validation rules; `run_sql` guard (DELETE
   rejected, multi-statement rejected, LIMIT appended) and capture; seed without key → 20 rows, statuses present,
   all fallback rows valid; `extract_invoice` with a fake structured-output model (pass a fake `BaseChatModel`
   whose `with_structured_output` returns a `RunnableLambda` producing a fixed `Invoice`) → notes computed;
   agent with a scripted tool-calling fake (use `langchain_core.language_models.fake_chat_models.GenericFakeChatModel`
   fed AIMessages: first with a `run_sql` tool call, then a final answer) → answer + `sql_query_used`; API:
   `/health`, `/invoices` (20 rows), `/invoices/extract` → 503 without key, `/chat` → 503, `POST /invoices` with a
   valid draft → 201 and appears in the list, invalid → 422, upload of a `.txt` → 503 (no key) but 415 for `.exe`.
10. Verify: `pytest -q` green; `uvicorn app.main:app` starts with SQLite and `/invoices` returns 20 rows; print a
    curl transcript in the report.

## Task B — Frontend (`frontend/`)

Vite + React 19 + TypeScript (`npm create vite@latest frontend -- --template react-ts`), no UI framework, plain CSS
with tokens (`--bg, --surface, --text, --muted, --accent, --ok, --warn, --bad`), system font, dark theme.

1. `src/api/types.ts` — mirror `backend/app/schemas.py` (InvoiceOut, InvoiceDraft, ExtractResponse, ChatResponse,
   HealthResponse). `src/api/client.ts` — `fetchJson` with `{error}` handling; `VITE_API_URL` (default
   `http://127.0.0.1:8000`).
2. Layout: header (app name, health chip: database kind + "Claude: ready / key missing"); main = `InvoiceTable`;
   right sidebar (360 px, collapsible below 900 px) = `ChatPanel`.
3. `InvoiceTable`: columns vendor, invoice #, date, due, total (right-aligned, tabular nums, currency), status pill
   (paid/pending/overdue — label + colour), **needs review** badge with a tooltip/expand of `review_notes`,
   source tag; sort by date desc; loading/empty/error states; refresh after save.
4. `AddInvoiceDrawer`: tabs "Paste text" / "Upload file"; "Extract with LangChain" → shows the model used, the
   extracted fields in editable inputs, line items table (editable amounts), validation notes; "Save invoice" →
   `POST /invoices`; disabled with an explanation when health says the key is missing.
5. `ChatPanel`: suggested-question chips (the four from the spec), input + send (Enter), message thread
   (user / assistant), each assistant message has `<details><summary>view query</summary><pre>…</pre></details>`
   when `sql_query_used` is non-empty; `aria-live="polite"`; error bubbles for 503/502 with the server message.
6. `npm run build` + `tsc` clean; a Vitest + Testing Library smoke test for `InvoiceTable` rendering a needs-review
   row. Proxy `/api`? — no: call `VITE_API_URL` directly; CORS is configured server-side.

## Task C — Docs + wiring (after A and B)

Root `README.md` (setup: Supabase project + `DATABASE_URL`, Anthropic key steps, `backend` venv + `uvicorn`,
`frontend` `npm i && npm run dev`, seeding, endpoints, architecture diagram, what LangChain features are shown and
where, troubleshooting), `frontend/.env.example`, root `package.json` with convenience scripts (`dev:backend`,
`dev:frontend`) if useful, and apply `migrations/001_invoices.sql` to Supabase once the project exists.
