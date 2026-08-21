# lang-chain-app — Invoice extraction + natural-language query demo

Date: 2026-08-21 · Supersedes the TypeScript LangGraph demo (tag `ts-langgraph-demo`).

## 1. Goal

A demo web app that showcases two LangChain capabilities over invoice data:

1. **Structured extraction** — raw invoice text (pasted or uploaded) → a validated `Invoice` schema via
   `ChatAnthropic(...).with_structured_output(Invoice)` (Claude Sonnet), with deterministic validation that
   flags anything suspicious as *needs review*.
2. **Natural-language querying** — a LangChain agent with SQL tools answers questions about the invoices
   ("How much have we spent with each vendor?", "Which invoices are overdue?", "Total outstanding balance?",
   "Show me all invoices over $1000") and **shows the SQL it ran**.

Stack: **Python 3.12 + FastAPI** backend, **React + Vite + TypeScript** frontend, **Supabase Postgres**
(SQLite fallback for offline dev), `langchain` 1.x, `langchain-anthropic` (`claude-sonnet-5`), `langgraph`.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Database | Supabase Postgres via `DATABASE_URL` (session pooler); `sqlite:///./invoices.db` when unset | user asked for Supabase; SQLAlchemy keeps both working with one code path |
| SQL agent tooling | own `@tool`s (`list_tables`, `describe_table`, `run_sql`) + `langchain.agents.create_agent` | `langchain-community` (SQLDatabaseToolkit) is being sunset; own tools give a read-only guard and exact SQL capture |
| Model | `claude-sonnet-5` (user named "Claude Sonnet"); env `ANTHROPIC_MODEL` overrides | |
| Structured output | `with_structured_output(Invoice)` (tool-calling method) | spec requirement |
| No API key | app runs: table, seed (Faker), upload preview disabled with a clear 503 `{error:"ANTHROPIC_API_KEY is not set"}` | user may not have a key yet |
| Seed | 15–20 Faker invoices + 3 realistic raw texts run through the real extractor when a key exists (recorded `source="extracted"`), else inserted from their known values with `source="seed-fallback"` | spec: "show the extraction pipeline in action" |
| Validation | deterministic: line items sum to subtotal, subtotal+tax=total (±0.011), due ≥ invoice date, required fields, currency ISO-3 → `needs_review` + `review_notes[]` | carried over from the previous app's design principle |
| Chat | single-turn; response `{answer, sql_query_used}`; SQL shown in a collapsible "view query" | spec |

## 3. Data model (`invoices` table)

| column | type | notes |
|---|---|---|
| id | integer pk | |
| invoice_number | text unique | |
| vendor_name | text | |
| vendor_email | text null | |
| invoice_date | date | |
| due_date | date null | |
| status | text | `paid` \| `pending` \| `overdue` |
| line_items | json | `[{description, quantity, unit_price, amount}]` |
| subtotal | numeric(12,2) | |
| tax | numeric(12,2) | |
| total | numeric(12,2) | |
| currency | text(3) | |
| po_number | text null | |
| needs_review | boolean | set by validation |
| review_notes | json | `string[]` |
| source | text | `seed` \| `extracted` \| `seed-fallback` \| `uploaded` |
| raw_text | text null | original text for extracted/uploaded rows |
| created_at | timestamptz | |

`backend/migrations/001_invoices.sql` creates it on Supabase; SQLite uses `Base.metadata.create_all`.

## 4. Backend API (`backend/app`)

| Method & path | Body | Response |
|---|---|---|
| `GET /health` | — | `{ok, database: "postgres"\|"sqlite", llm_configured: bool, model}` |
| `GET /invoices` | — | `InvoiceOut[]` newest first |
| `POST /invoices/extract` | `{text}` | `ExtractResponse { invoice: InvoiceDraft, needs_review, review_notes, model }` — no write |
| `POST /invoices/upload` | multipart `file` (.txt/.md/.pdf ≤ 2 MB) | same as extract (text pulled via `pypdf` for PDFs) |
| `POST /invoices` | `InvoiceDraft` (+ optional `raw_text`) | `InvoiceOut` (201); re-validated server-side |
| `POST /chat` | `{question}` | `{answer, sql_query_used}`; 503 when no key |

Errors are JSON `{error}`; 422 validation, 503 LLM not configured, 502 upstream LLM failure (message included).

## 5. Frontend (`frontend/`)

- Main area: invoice table — vendor, invoice #, date, due, total + currency, status pill, **needs review** badge (with the notes on hover/expand), source. Toolbar: count, "Add invoice".
- "Add invoice" drawer: paste text **or** upload file → "Extract with LangChain" → editable preview of the extracted fields + line items + validation notes → "Save".
- Right sidebar: chat panel — question input, answers as a thread, each answer with a collapsible **view query** `<details>` showing `sql_query_used`; suggested questions as chips; disabled state with a hint when `/health` reports no key.
- Plain CSS with a small token set; dark theme; accessible (labels, focus, `aria-live` for answers, 44 px targets).

## 6. Testing

Backend `pytest` (SQLite, no network): validation rules; seed without a key (17 Faker rows + 3 fallback rows, all valid); API contract for every endpoint; extraction and agent against `GenericFakeChatModel`/scripted tool-calling fakes (the agent loop, read-only guard rejecting `DELETE`, SQL capture). Frontend: `tsc` + `vite build`; a smoke test of the table rendering with Vitest + Testing Library if time allows.

## 7. Out of scope

Auth, multi-user, invoice editing after save, RLS policies (service connection only), streaming chat.
