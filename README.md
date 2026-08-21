# lang-chain-app — invoice extraction + natural-language querying with LangChain

A demo web app that shows two LangChain capabilities over invoice data, end to end:

1. **Structured extraction** — paste or upload a raw invoice (text or PDF) and Claude fills a Pydantic `Invoice`
   schema through `model.with_structured_output(Invoice)`. Deterministic validation then checks the arithmetic and
   dates and flags anything suspicious as **needs review**.
2. **Natural-language querying** — a LangChain agent (`create_agent` + three SQL tools) answers questions like
   *"How much have we spent with each vendor?"* against the database and **shows the SQL it ran** in a collapsible
   "view query" panel. Nothing is hidden: the demo is about what LangChain does under the hood.

Stack: **Python 3.12 · FastAPI · SQLAlchemy** backend, **React 19 · Vite · TypeScript** frontend,
**Supabase Postgres** (SQLite fallback for offline dev), `langchain` 1.x, `langchain-anthropic` (`claude-sonnet-5`),
`langgraph`.

> The previous TypeScript/LangGraph pipeline demo that lived in this repo is preserved under the git tag
> `ts-langgraph-demo`.

---

## 1. Quickstart (works without any keys)

```bash
# backend
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows   (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
copy .env.example .env            # edit later: ANTHROPIC_API_KEY, DATABASE_URL
uvicorn app.main:app --reload --port 8000

# frontend (second terminal)
cd frontend
npm install
npm run dev                       # http://localhost:5173 (Vite picks the next free port if 5173 is busy)
```

On first start the backend creates the schema (SQLite file `backend/invoices.db` when `DATABASE_URL` is empty) and
seeds **20 invoices**: 17 generated with Faker (12 fictional vendors, 1–8 line items, USD/EUR/GBP/PHP, a mix of
paid / pending / overdue, one deliberately inconsistent so the *needs review* badge is visible) plus **3 realistic
raw invoice texts**. With an `ANTHROPIC_API_KEY` those three go through the real extraction pipeline and are stored
as `source = extracted` (with their `raw_text`); without a key they are inserted from known values as
`seed-fallback` so the table is never empty.

The header chip tells you what mode you're in (`SQLite` / `Postgres`, `Claude: ready` / `key missing`). Extraction and
chat return a clear `503 {"error": "ANTHROPIC_API_KEY is not set"}` until the key exists; everything else works.

## 2. Adding the Anthropic API key

The API is billed per token from the Anthropic Console — **a Claude Pro/Max subscription does not include API access**.

1. Sign in at <https://console.anthropic.com> → **Settings → Billing** → add a payment method or a few dollars of
   credits (Sonnet 5 is roughly $3 / $15 per million input / output tokens; one chat question costs a fraction of a cent).
2. **Settings → API Keys → Create Key**, copy it once.
3. `backend/.env`:
   ```ini
   ANTHROPIC_API_KEY=sk-ant-...
   ANTHROPIC_MODEL=claude-sonnet-5
   ```
4. Restart uvicorn. Delete `backend/invoices.db` (or run `python -m app.seed --force`) if you want the three raw
   samples re-seeded through the real extractor.

`.env` is gitignored. Never commit or paste the key.

## 3. Using Supabase

1. Create a project at <https://supabase.com/dashboard> (or let the Supabase MCP do it).
2. Apply `backend/migrations/001_invoices.sql` in the SQL editor (it creates `invoices` with `jsonb` columns and the
   indexes; `create_all` would also work but the migration is the source of truth for Postgres).
3. **Connect → Connection string → Session pooler** (port 5432, IPv4-friendly), copy the URI **exactly as shown** —
   the host encodes the region the project actually lives in (e.g. `aws-0-ap-northeast-1`) and must not be edited —
   then change its scheme to `postgresql+psycopg://`. URL-encode the password if it contains special characters:
   ```ini
   DATABASE_URL=postgresql+psycopg://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
4. Restart uvicorn — the health chip switches to `Postgres` and the seed runs once if the table is empty.

The backend connects with the database role directly (no RLS, no anon key) — fine for a demo, not for multi-tenant use.

## 4. What you can do in the UI

- **Invoice table** — vendor, invoice #, date, due date, total in the invoice's currency, status pill
  (paid / pending / overdue), **Needs review** badge that expands to the validation notes, and the row's source
  (`seed`, `seed (fallback)`, `extracted`, `uploaded`).
- **Add invoice** — paste text or upload `.txt` / `.md` / `.pdf` → *Extract with LangChain* → review and edit the
  extracted fields and line items, read the validation notes → *Save invoice*.
- **Ask about the invoices** (right sidebar) — type a question or click a suggestion. Each answer has a
  **view query** disclosure showing every SQL statement the agent executed.

Questions the agent handles well: *How much have we spent with each vendor?* · *Which invoices are overdue?* ·
*What's the total outstanding balance?* · *Show me all invoices over $1000* · *Which vendor do we owe the most?*

## 5. Architecture

```
 React (Vite)                          FastAPI                                   Claude (langchain-anthropic)
 ┌──────────────────┐   GET /invoices  ┌──────────────────────────────────┐
 │ InvoiceTable     │◄────────────────►│ routers/invoices.py              │
 │ AddInvoiceDrawer │  POST /invoices/ │   extraction.py ─ prompt | model.with_structured_output(Invoice) ──► claude-sonnet-5
 │                  │  extract|upload  │   validation.py ─ deterministic checks → needs_review + notes
 │                  │  POST /invoices  │   seed.py ─ Faker + 3 raw samples through the extractor
 │ ChatPanel        │   POST /chat     │ routers/chat.py                  │
 │  └ view query    │◄────────────────►│   query_agent.py ─ create_agent(model, tools, system_prompt) ──► claude-sonnet-5
 └──────────────────┘                  │   sql_tools.py ─ @tool list_tables / describe_table / run_sql (read-only, SQL captured)
                                       └──────────────┬───────────────────┘
                                                      │ SQLAlchemy
                                         Supabase Postgres  (or SQLite fallback)
```

**Design principle:** the model does language work (reading a messy document, writing SQL, phrasing the answer);
arithmetic, date logic and safety are deterministic code. `needs_review` is never the model's opinion, and the
agent can only ever run a single `SELECT`.

## 6. Where each LangChain feature lives

| Feature | Where | What to look at |
|---|---|---|
| Pydantic schema as the extraction contract | `backend/app/schemas.py` `Invoice` | `Field(description=…)` texts are sent to the model as instructions |
| `with_structured_output` | `backend/app/extraction.py` | `prompt \| ChatAnthropic(...).with_structured_output(Invoice)` |
| `ChatPromptTemplate` | `backend/app/extraction.py` | system prompt: copy values, never recompute totals, ISO dates, currency inference |
| Deterministic validation after extraction | `backend/app/validation.py` | line sum, subtotal+tax, due ≥ invoice date, currency, derived `overdue` |
| `@tool` functions | `backend/app/sql_tools.py` | `list_tables`, `describe_table`, `run_sql` closed over one SQLAlchemy engine |
| Read-only SQL guard | `backend/app/sql_tools.py` `guard_query` | single statement, whole-statement keyword scan (CTE writes rejected), `LIMIT` enforced, Postgres `statement_timeout` |
| SQL capture for transparency | `backend/app/sql_tools.py` `executed_sql` | a `ContextVar` list that is mutated (tools run in a copied context) |
| `create_agent` (LangChain 1.x agent loop on LangGraph) | `backend/app/query_agent.py` | system prompt built from live schema introspection; `recursion_limit` 12 |
| `sql_query_used` in the API | `backend/app/query_agent.py` → `POST /chat` | every executed statement, joined; rendered in the UI's "view query" |
| Extraction in the seed | `backend/app/seed.py` | three raw documents through the real pipeline when a key exists |
| Testing LLM code without network | `backend/tests/fakes.py` | structured-output fake, scripted tool-calling fake for the agent loop |

## 7. API

| Method & path | Body | Response |
|---|---|---|
| `GET /health` | — | `{ok, database, llm_configured, model}` |
| `GET /invoices` | — | `InvoiceOut[]` newest first |
| `POST /invoices/extract` | `{text}` | `{invoice, needs_review, review_notes, model}` (no write) |
| `POST /invoices/upload` | multipart `file` (.txt/.md/.pdf ≤ 2 MB) | same as extract |
| `POST /invoices` | `InvoiceDraft` (+ optional `raw_text`) | `InvoiceOut` (201); 409 on duplicate invoice number |
| `POST /chat` | `{question}` | `{answer, sql_query_used}` |

Errors are JSON `{error}`: 422 validation, 413/415 upload limits, 503 no API key, 502 upstream model failure.

## 8. Project layout

```
backend/
  app/            config, db, models, schemas, validation, extraction, sql_tools, query_agent, seed, routers/, main
  migrations/     001_invoices.sql (Supabase / Postgres DDL)
  tests/          pytest (73 tests, SQLite, no network)
  requirements.txt  .env.example
frontend/
  src/api/        types mirrored from schemas.py, client, mock (VITE_USE_MOCK=true for UI work without a backend)
  src/components/ HealthChip, InvoiceTable, StatusPill, ReviewBadge, AddInvoiceDrawer, ChatPanel
  src/styles/     tokens + app CSS (dark theme, accessible)
docs/             SPEC.md, PLAN.md, reports/ (build reports + screenshots)
```

## 9. Tests

```bash
cd backend && .venv\Scripts\python -m pytest -q     # 73 passed
cd frontend && npm run typecheck && npm test && npm run build
```

## 10. Troubleshooting

- **Chat/extract say the key is missing** — `backend/.env` must contain `ANTHROPIC_API_KEY`; restart uvicorn.
- **CORS error in the browser** — any `localhost`/`127.0.0.1` port is allowed by default; if you serve the frontend
  elsewhere add it to `CORS_ORIGINS`.
- **Supabase connection refused** — use the *session pooler* URI on port 5432 with the `postgresql+psycopg://` scheme.
- **`FATAL: (ENOTFOUND) tenant/user postgres.<ref> not found`** — the pooler host's region doesn't match the project's
  region; copy the host from the dashboard's Connect dialog instead of typing it.
- **`db.<ref>.supabase.co` does not resolve** — the direct host is IPv6-only; that's why the pooler URI is used.
- **I want fresh seed data** — delete `backend/invoices.db` (SQLite) or run `python -m app.seed --force`.
