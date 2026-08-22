# lang-chain-app

Invoice extraction and natural-language querying with LangChain. Drop an invoice or an export in any format and
Claude structures it; ask questions about the data and a LangChain agent answers with SQL it shows you.

**Stack:** Python 3.12 · FastAPI · SQLAlchemy · `langchain` 1.x · `langchain-anthropic` (`claude-sonnet-5`) · React 19 ·
Vite · TypeScript · Supabase Postgres (SQLite fallback).

## Run it

```bash
npm run setup   # once: Python venv + backend deps, frontend deps, creates .env
npm run dev     # API on http://127.0.0.1:8000, UI on http://localhost:5173
```

That is the whole setup. It works offline with no keys: 20 seeded invoices, the table, filters and search.

Requirements: Node 20+ and Python 3.12+ on your PATH.

### Turn on Claude (extraction + chat)

Put an API key from <https://console.anthropic.com> (Settings, API Keys; usage is billed per token and is separate
from a Claude Pro/Max subscription) into the root `.env`:

```ini
ANTHROPIC_API_KEY=sk-ant-...
```

Restart `npm run dev`. Run `npm run seed` if you want the three raw sample invoices re-seeded through the real
extractor.

### Use Supabase instead of SQLite (optional)

1. Create a project, then run `backend/migrations/001_invoices.sql` in its SQL editor.
2. Connect, Connection string, **Session pooler**: copy the URI exactly as shown (the host carries the project's
   region), change the scheme to `postgresql+psycopg://`, and put it in the root `.env`:
   ```ini
   DATABASE_URL=postgresql+psycopg://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
3. Restart `npm run dev`. The header chip switches to Postgres and the seed runs once if the table is empty.

## What it does

| In the UI | Under the hood |
|---|---|
| **Invoices table** with search, status / source / sort filters, a needs-review toggle and pagination | `GET /invoices?q=&status=&needs_review=&source=&sort=&order=&page=&page_size=` |
| **Add invoice**: drop a PDF, text, CSV, JSON or Excel file; extraction starts on its own; rows preview in the table format; Save | `POST /invoices/ingest` routes documents to `with_structured_output(Invoice)` and exports to a Claude-filled `ColumnMapping`; `POST /invoices/bulk` saves |
| **Needs review** badge | deterministic validation after extraction: line sums, subtotal + tax = total, due date after issue date, currency |
| **Chat with our Agent**: questions like "Which invoices are overdue?" with a **view query** disclosure | `create_agent` + three `@tool`s (`list_tables`, `describe_table`, read-only `run_sql`); every executed statement is returned as `sql_query_used` |

Design principle: the model does language work (reading a messy document, mapping foreign column names, writing
SQL); arithmetic, dates and safety are deterministic code. `needs_review` is never the model's opinion and the
agent can only run a single `SELECT`.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | create `backend/.venv`, install Python and npm dependencies, create `.env` from `.env.example` (safe to re-run) |
| `npm run dev` | start both servers with prefixed logs; Ctrl-C stops both |
| `npm test` | backend pytest (174 tests, no network) then frontend typecheck + Vitest |
| `npm run seed` | wipe and re-seed the configured database |
| `npm run dev:backend` / `npm run dev:frontend` | one side only |

## Where the LangChain pieces live

| Feature | File |
|---|---|
| Pydantic `Invoice` schema as the extraction contract (field descriptions are the instructions) | `backend/app/schemas.py` |
| `ChatPromptTemplate` + `with_structured_output(Invoice)` | `backend/app/extraction.py` |
| Column mapping of arbitrary exports with `with_structured_output(ColumnMapping)`, incl. status-vocabulary translation | `backend/app/column_mapping.py` |
| Deterministic application of a mapping (money, dates, grouping, derivations as `import_notes`) | `backend/app/importing.py` |
| `@tool` SQL tools with a read-only guard and executed-SQL capture | `backend/app/sql_tools.py` |
| `create_agent` with a schema-introspected system prompt | `backend/app/query_agent.py` |
| Deterministic validation and status derivation | `backend/app/validation.py` |
| Seed: Faker data plus three raw documents through the real extractor | `backend/app/seed.py` |
| Testing LLM code without the network (structured-output and tool-calling fakes) | `backend/tests/fakes.py` |

## API

| Method & path | Body | Response |
|---|---|---|
| `GET /health` | | `{ok, database, llm_configured, model}` |
| `GET /invoices` | query params above | `{items, total, page, page_size}` |
| `POST /invoices/ingest` | multipart `file` (.pdf .txt .md .csv .json .xlsx, 2 MB) | `{kind, invoices[], mapping, mapping_source, warnings, raw_text}` |
| `POST /invoices/bulk` | `{invoices[], source}` | `{created[], skipped[]}` (201) |
| `POST /chat` | `{question}` | `{answer, sql_query_used}` |

Also available: `POST /invoices/extract` (`{text}`), `POST /invoices/upload`, `POST /invoices/import`, `POST /invoices`.
Errors are JSON `{error}`: 422 validation, 413/415 upload limits, 503 no API key, 502 upstream model failure.

## Layout

```
.env           the only config file (copy of .env.example); never committed
scripts/       setup, dev, test, seed (plain Node, no dependencies)
backend/app/   config, db, models, schemas, validation, extraction, column_mapping, importing,
               file_parsing, sql_tools, query_agent, seed, routers/, main
backend/tests/ pytest suite; backend/migrations/001_invoices.sql for Supabase
frontend/src/  api/, components/, lib/, styles/ (plain CSS tokens, dark theme)
docs/          SPEC.md, PLAN.md, reports/ (build reports and screenshots)
```

## Troubleshooting

- **Extraction or chat says the key is missing**: set `ANTHROPIC_API_KEY` in `.env` (repo root) and restart.
- **`tenant/user postgres.<ref> not found`**: the pooler host's region does not match the project; copy the host from
  the Supabase Connect dialog.
- **`db.<ref>.supabase.co` does not resolve**: the direct host is IPv6-only; use the session pooler URI.
- **Port 5173 is busy**: Vite picks the next free port and prints it; the API allows any localhost origin.
- **Fresh data**: `npm run seed` (or delete `backend/invoices.db` when on SQLite).

The earlier TypeScript LangGraph pipeline demo is preserved at git tag `ts-langgraph-demo`.
