# Task A — Backend report

Date: 2026-08-21 · Spec: `docs/SPEC.md` · Plan: `docs/PLAN.md` (Task A)
Status: **complete**, `pytest -q` → **72 passed**, manual run verified against SQLite.

---

## 1. Files delivered

All paths relative to `backend/`.

| File | Lines | What it does |
|---|---:|---|
| `app/db.py` | 35 | `make_engine()` (`pool_pre_ping`, SQLite `check_same_thread=False`), module-level `engine`, `SessionLocal`, `init_db()`, `get_session()` dependency |
| `app/models.py` | 47 | `Invoice` ORM row for SPEC §3. Money is `Numeric(12, 2, asdecimal=False)` so it reads back as `float` on both dialects |
| `app/validation.py` | 72 | `validate_invoice()` (the deterministic rules), `round_money()`, `today()` |
| `app/extraction.py` | 88 | `build_chat_model()`, `build_extractor()`, `extract_invoice()`, `LLMNotConfigured`, `ExtractionError` |
| `app/sql_tools.py` | 174 | `guard_query()` read-only guard, `build_sql_tools()` (3 tools), the `executed_sql` capture buffer |
| `app/query_agent.py` | 98 | `build_system_prompt()`, `build_agent()`, `ask()`, `AgentError` |
| `app/raw_samples.py` | 174 | 3 realistic raw invoices (email body / plain text / OCR-ish table) with their known-correct values |
| `app/seed.py` | 244 | `seed()` + `SeedReport` + `to_row()` + CLI `python -m app.seed [--force] [--count N]` |
| `app/routers/invoices.py` | 121 | `GET /invoices`, `POST /invoices/extract`, `POST /invoices/upload`, `POST /invoices` |
| `app/routers/chat.py` | 28 | `POST /chat` |
| `app/main.py` | 95 | app wiring, CORS, lifespan (init + seed), `GET /health`, `{error}` exception handlers |
| `migrations/001_invoices.sql` | 30 | Postgres/Supabase DDL matching the ORM |
| `pytest.ini` | 5 | `testpaths=tests`, `pythonpath=.` |
| `tests/conftest.py` | 64 | temp-SQLite env, `settings` / `db_engine` / `session` / `seeded_session` / `client` fixtures |
| `tests/fakes.py` | 48 | `StructuredOutputFake`, `ToolCallingFake`, `scripted_model()` |
| `tests/test_validation.py` | 93 | 14 tests |
| `tests/test_sql_tools.py` | 104 | 19 tests |
| `tests/test_extraction.py` | 69 | 8 tests |
| `tests/test_agent.py` | 92 | 7 tests |
| `tests/test_seed.py` | 105 | 9 tests |
| `tests/test_api.py` | 151 | 15 tests |

Unchanged foundation files: `app/schemas.py`, `app/config.py`, `.env.example`, `requirements.txt`.

---

## 2. Where each LangChain piece lives

### Structured extraction — `with_structured_output`

- `app/extraction.py:55` — `ChatAnthropic(model=…, api_key=…, temperature=0, max_tokens=4096, max_retries=2)`.
- `app/extraction.py:67` — `ChatPromptTemplate.from_messages([("system", SYSTEM_PROMPT), ("human", "{text}")])`.
  Only the template string is parsed for placeholders, so braces inside a pasted invoice pass through untouched (verified).
- `app/extraction.py:68` — `prompt | chat.with_structured_output(Invoice)`. The Pydantic `Invoice` from
  `app/schemas.py` is handed to Claude as a tool schema; its `Field(description=…)` texts double as the
  extraction instructions, which is why the schema is reused rather than redefined.
- `app/extraction.py:79-88` — provider/parse failures are wrapped in `ExtractionError` (→ 502); the result is
  rounded to 2 dp and run through `validate_invoice`, so `needs_review` is never the model's opinion.

### SQL tools — `@tool` over SQLAlchemy (no `langchain-community`)

- `app/sql_tools.py:126/132/150` — `@tool`-decorated `list_tables`, `describe_table`, `run_sql`, closed over one
  `Engine` by `build_sql_tools()` (`app/sql_tools.py:123`).
- `app/sql_tools.py:68` — `guard_query()`: strips comments and quoted string literals first, then requires a
  single statement starting with `SELECT`/`WITH`, and scans the **whole** statement for forbidden verbs as whole
  words (`app/sql_tools.py:84`). A CTE-smuggled write such as
  `WITH gone AS (DELETE FROM invoices RETURNING *) SELECT * FROM gone` is rejected. String literals are blanked
  before scanning, so `WHERE vendor_name LIKE '%update%'` is still allowed.
- `LIMIT` is appended only when the statement has no `LIMIT` / `FETCH FIRST` of its own; the fetch is
  additionally capped at `settings.sql_row_limit` and the table is annotated `(truncated to N rows)` when it hits
  the cap, so truncation is never silent.
- `app/sql_tools.py:160` — `SET LOCAL statement_timeout = 10000` inside the transaction, **postgresql dialect
  only**; SQLite skips it.
- `app/sql_tools.py:21-58` — `executed_sql` capture. This is a `ContextVar` holding a list that is **mutated**,
  never rebound: LangChain runs tools inside `copy_context()`, so a `ContextVar.set()` performed inside a tool
  never reaches the caller. Mutating the shared list object does. (This was a real bug caught by the tests.)

### Agent — `langchain.agents.create_agent`

- `app/query_agent.py:52` — `create_agent(model, build_sql_tools(engine, settings), system_prompt=…)`.
- `app/query_agent.py:27` — `build_system_prompt()` introspects the live table via
  `sql_tools.column_names()` at **build time**, so the prompt carries the real column list on both SQLite and
  Postgres. It also states that `status` is one of `paid`/`pending`/`overdue`, that amounts are in the row's own
  `currency` (so do not sum across currencies), that "outstanding"/"unpaid" means `status != 'paid'`, and that
  the answer must be 1–3 sentences quoting real numbers with their currency.
- `app/query_agent.py:81` — `agent.invoke({"messages": [HumanMessage(question)]}, config={"recursion_limit": 12})`.
- `app/query_agent.py:98` — `sql_query_used = ";\n".join(get_executed_sql())`, i.e. every statement the agent
  actually executed, in order (including `describe_table`'s sample-row query). Rejected queries are never
  recorded.

### Seed — the extraction pipeline in action

- `app/seed.py:203-215` — with a key, each of the three raw samples goes through the real `extract_invoice`
  and is stored as `source="extracted"` with its `raw_text`. Without a key (or when the call fails) it falls back
  to the sample's known values as `source="seed-fallback"`, appends the provider message to `SeedReport.errors`
  and logs a warning. Startup therefore cannot be broken by the LLM.
- `app/main.py:25` — `_startup_seed()` runs `init_db()`, seeds only when the table is empty, and logs one line.
  A seed failure is logged with `logger.exception` and the API still comes up.

### Test fakes (no network anywhere in the suite)

- `tests/fakes.py:23` — `StructuredOutputFake.with_structured_output()` returns a `RunnableLambda` producing a
  fixed `Invoice` (or raising), which is enough for `build_extractor`'s `prompt | model` pipe.
- `tests/fakes.py:33` — `ToolCallingFake(GenericFakeChatModel)`. **`GenericFakeChatModel` inherits
  `BaseChatModel.bind_tools`, which raises `NotImplementedError`**, so `create_agent` cannot use it as-is; the
  subclass overrides `bind_tools` to return `self`. With that one line, scripted `AIMessage`s carrying
  `tool_calls` drive the real agent loop end to end.

---

## 3. Test summary

```
$ backend/.venv/Scripts/python -m pytest -q
........................................................................ [100%]
72 passed, 1 warning in 1.00s
```

| File | Tests | Covers |
|---|---:|---|
| `tests/test_validation.py` | 14 | every rule, the ±0.011 tolerance, `round_money`, and that all 3 raw-sample expectations validate clean |
| `tests/test_sql_tools.py` | 19 | `DELETE`/`UPDATE`/`DROP`/`PRAGMA`/`INSERT` rejected, CTE-smuggled `DELETE` rejected, `;` chaining rejected (including `SELECT 1; SELECT 2;`), `LIMIT` appended / existing `LIMIT` respected, write-word inside a string literal allowed, markdown rendering, `(no rows)`, SQL capture |
| `tests/test_extraction.py` | 8 | 503 path with no key, fixed-`Invoice` fake, prompt actually receives the raw text, notes computed from model output, 2 dp rounding, provider error → `ExtractionError`, non-`Invoice` result → `ExtractionError` |
| `tests/test_agent.py` | 7 | scripted tool loop → answer + `sql_query_used`, two statements joined by `";\n"`, refused write neither runs nor is recorded, no-SQL answer, model failure → `AgentError`, prompt carries the real columns |
| `tests/test_seed.py` | 9 | 20 rows (17 + 3), all rows valid, all 3 statuses present, overdue rows really past due (`today()` monkeypatched to 2026-08-21), samples stored as `seed-fallback` with `raw_text`, idempotency, `--force`, determinism, float rounding |
| `tests/test_api.py` | 15 | `/health`, `/invoices` (20 rows), extract → 503, chat → 503, `POST /invoices` → 201 + appears first in the list, suspicious draft saved but flagged, bad body → 422, duplicate → 409, `.txt` upload → 503, `.exe` → 415, >2 MB → 413, near-empty → 422, 404 uses the `{error}` envelope |

The one warning is `StarletteDeprecationWarning: Using httpx with starlette.testclient is deprecated; install
httpx2` — it comes from the pinned `httpx` in `requirements.txt`, not from app code.

---

## 4. Manual run transcript

```
$ cd backend && rm -f invoices.db
$ .venv/Scripts/python -m uvicorn app.main:app --port 8000
INFO:     Started server process [22756]
INFO:     Waiting for application startup.
INFO app: Starting on sqlite database, Claude not configured (LLM endpoints return 503)
INFO app: Startup seed: inserted 20 invoices, 17 generated, 0 extracted by Claude, 3 from known values, 0 flagged for review
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)

$ curl -s http://127.0.0.1:8000/health
{"ok":true,"database":"sqlite","llm_configured":false,"model":"claude-sonnet-5"}

$ curl -s http://127.0.0.1:8000/invoices        # 20 rows, newest first (head)
20 rows
HPS/45120        Halewood Print & Signage Ltd 2026-05-28  due 2026-06-27     999.60 GBP  paid     seed-fallback
BL-2026-0417     Brauer Logistik GmbH         2026-06-12  due 2026-07-12    1787.02 EUR  pending  seed-fallback
NW-2291          Northwind Analytics          2026-07-31  due 2026-08-30    7079.55 USD  pending  seed-fallback
CF-2026-1016     Cobalt Freight Services      2026-08-12  due 2026-09-26   14990.98 USD  pending  seed
VL-2026-1015     Verity Legal Partners        2026-07-27  due 2026-09-10    5434.74 EUR  pending  seed
sources: ['seed', 'seed-fallback']   statuses: ['overdue', 'paid', 'pending']

$ curl -s -i -X POST http://127.0.0.1:8000/chat \
    -H "Content-Type: application/json" -d '{"question":"What is the total outstanding balance?"}'
HTTP/1.1 503 Service Unavailable
{"error":"ANTHROPIC_API_KEY is not set"}

$ curl -s -i -X POST http://127.0.0.1:8000/invoices/extract \
    -H "Content-Type: application/json" -d '{"text":"INVOICE ACME-42  Date 2026-08-01  Total USD 120.00 ..."}'
HTTP/1.1 503 Service Unavailable
{"error":"ANTHROPIC_API_KEY is not set"}

$ curl -s -i -X POST http://127.0.0.1:8000/invoices -H "Content-Type: application/json" -d @draft.json
HTTP/1.1 201 Created

$ curl -s http://127.0.0.1:8000/invoices        # the new row is first
21 rows
MAN-1001         Ridgeway Catering Ltd        2026-08-14  due 2026-09-13     954.00 GBP  pending  uploaded
HPS/45120        Halewood Print & Signage Ltd 2026-05-28  due 2026-06-27     999.60 GBP  paid     seed-fallback
...

$ curl -s -X POST http://127.0.0.1:8000/invoices -d @draft.json   # replay the same invoice number
duplicate replay -> HTTP 409
{"error":"Invoice number 'MAN-1001' already exists."}

$ curl -s -X POST http://127.0.0.1:8000/invoices -d @draft2.json  # same draft, MAN-1002 — full body
HTTP 201
{
  "id": 22,
  "invoice_number": "MAN-1002",
  "vendor_name": "Ridgeway Catering Ltd",
  "subtotal": 795.0,
  "tax": 159.0,
  "total": 954.0,
  "currency": "GBP",
  "status": "pending",
  "needs_review": false,
  "review_notes": [],
  "source": "uploaded",
  "created_at": "2026-08-21T02:16:21.327644"
}

$ curl -s -X POST http://127.0.0.1:8000/invoices -d '{"invoice_number":"X"}'
HTTP 422
{"error":"Invalid request - vendor_name: Field required; invoice_date: Field required; currency: Field required; line_items: Field required; subtotal: Field required; tax: Field required; total: Field required"}

# server stopped
```

`python -m app.seed` on its own:

```
$ .venv/Scripts/python -m app.seed
inserted 20 invoices, 17 generated, 0 extracted by Claude, 3 from known values, 0 flagged for review
database: sqlite:///./invoices.db
rows now: 20
```

---

## 5. Deviations from the plan, and why

1. **`build_agent(engine, model, settings)`** — the plan wrote `build_agent(engine, model)`. It needs `settings`
   to pass `sql_row_limit` down to `run_sql`; threading it explicitly beats reaching for the global.
2. **`backend/pytest.ini` added** (not in the plan's file list) — `pythonpath = .` is what makes `import app`
   work when `pytest` is run from `backend/`. Two ini lines, no runtime effect.
3. **`tests/fakes.py` added** — the plan says `tests/…`; the two fakes are shared by `test_extraction.py` and
   `test_agent.py`, so they live in one module rather than being duplicated.
4. **`LLMNotConfigured` lives in `app/extraction.py`** and is imported by `query_agent.py` and the routers,
   rather than getting its own `errors.py`, to keep the Task A file list exactly as planned.
5. **409 on a duplicate `invoice_number`.** SPEC §4 lists 422/503/502 only. Silently accepting or 500-ing a
   duplicate would be worse; the body still uses the `{error}` envelope.
6. **The forbidden-keyword list is longer than the plan's.** The plan named
   `insert|update|delete|drop|alter|create|truncate|grant|attach|pragma`; `revoke, detach, replace, merge,
   vacuum, reindex, copy, call, do, execute, commit, rollback, savepoint, lock, refresh, analyze` are also
   blocked. Comments and quoted string literals are stripped before the scan so data containing those words is
   not mistaken for a write.
7. **`run_sql` returns guard/DB failures to the model as `"ERROR: …"` rather than raising.** That is the tool
   contract — the agent has to be able to read the refusal and rewrite its query. `guard_query()` itself raises
   `ReadOnlyViolation` and is tested directly, so nothing is swallowed.
8. **`line_items` / `review_notes` are `jsonb` in the migration but generic `JSON` in the ORM.** The plan forbids
   dialect-specific types outside `migrations/`. Postgres casts `json` → `jsonb` implicitly on write, so both
   paths work; note that `Base.metadata.create_all()` against a *fresh* Postgres database would create `json`
   columns instead of `jsonb` — apply `migrations/001_invoices.sql` first to get the intended type.
9. **`requirements.txt` still pins `langchain-community`.** Nothing imports it (SPEC §2 explicitly rejects it as
   sunset). Left untouched because it is a foundation file; **suggest deleting that line in Task C**.
10. **`ruff` is not installed** in `backend/.venv`, so "ruff-clean" was written to, not verified against, the
    linter.

### Small things worth knowing

- `created_at` comes back naive on SQLite (`2026-08-21T02:16:21.327644`) because SQLite has no `timestamptz`.
  On Postgres it carries the offset. The frontend should not assume a `Z` suffix.
- `LIMIT` is only appended when the statement contains no `LIMIT` at all, including in a subquery. That errs
  toward respecting the agent's own query; the `fetchmany(sql_row_limit)` cap is the real safety net.
- Status constants moved to the non-deprecated Starlette names (`HTTP_413_CONTENT_TOO_LARGE`,
  `HTTP_422_UNPROCESSABLE_CONTENT`) — the old ones warn on this version.

---

## 6. `DATABASE_URL` for Supabase — the exact format

`app/config.py` picks Postgres when `DATABASE_URL` starts with `postgresql`, otherwise it falls back to
`sqlite:///./invoices.db`. The driver installed is **psycopg 3**, so the scheme must be
`postgresql+psycopg://` — Supabase hands you a bare `postgresql://` URI, and you must change the scheme
yourself or SQLAlchemy will look for `psycopg2` and fail.

Supabase dashboard → **Project Settings → Database → Connection string → Session pooler → URI**, then:

```
DATABASE_URL=postgresql+psycopg://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

- `<project-ref>` is the 20-character project id; the username really is `postgres.<project-ref>`, not `postgres`.
- Use the **session pooler on port 5432**, not the transaction pooler on 6543 — SQLAlchemy's connection pool plus
  `pool_pre_ping` expects a session-level connection, and prepared statements break on the transaction pooler.
- URL-encode the password if it contains `@ : / ? # [ ] %` (e.g. `@` → `%40`).
- Direct (non-pooler) connections are IPv6-only on Supabase; the pooler host is the reliable choice.
- Then apply `backend/migrations/001_invoices.sql` in the Supabase SQL editor before first start, and seed with
  `.venv/Scripts/python -m app.seed`.

---

## 7. README-backend content (hand to Task C)

```
### Backend

    cd backend
    python -m venv .venv
    .venv/Scripts/activate            # Windows; source .venv/bin/activate elsewhere
    pip install -r requirements.txt
    cp .env.example .env              # optional: add ANTHROPIC_API_KEY and DATABASE_URL
    python -m uvicorn app.main:app --reload --port 8000

The first start creates the table and seeds it with 17 generated invoices plus 3 realistic raw
documents. With `ANTHROPIC_API_KEY` set, those 3 are run through the real extraction chain and stored
as `source="extracted"`; without a key they are stored from their known values as `source="seed-fallback"`,
and `/chat` + `/invoices/extract` + `/invoices/upload` answer `503 {"error": "ANTHROPIC_API_KEY is not set"}`.
Everything else works with no key at all.

Re-seed by hand:  python -m app.seed --force [--count N]
Run the tests:    python -m pytest -q          (SQLite temp file, no network)

Endpoints: GET /health, GET /invoices, POST /invoices/extract, POST /invoices/upload,
POST /invoices, POST /chat. Errors are always {"error": "..."} — 422 validation, 409 duplicate
invoice number, 413/415 upload problems, 503 no API key, 502 upstream LLM failure.

Database: leave DATABASE_URL empty for backend/invoices.db (SQLite). For Supabase use the session
pooler URI with the scheme rewritten to postgresql+psycopg:// and apply migrations/001_invoices.sql first.
```
