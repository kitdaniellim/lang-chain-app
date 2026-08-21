# Task B — Frontend report

Date: 2026-08-21 · Spec `docs/SPEC.md` §4–§5 · Plan `docs/PLAN.md` Task B

React 19 + Vite 8 + TypeScript 6, scaffolded with `npm create vite@latest frontend -- --template react-ts`.
No UI framework, no CSS framework — plain CSS on a token set, one system font stack, dark theme.

## Files

| File | What it holds |
|---|---|
| `frontend/src/api/types.ts` | Wire types mirroring `backend/app/schemas.py` 1:1, snake_case kept (no remapping) |
| `frontend/src/api/client.ts` | `fetchJson<T>`, `ApiError(status, message)`, one function per endpoint, `VITE_USE_MOCK` switch |
| `frontend/src/api/mock.ts` | 6 `InvoiceOut` fixtures + canned health/extract/chat/save responses |
| `frontend/src/lib/format.ts` | `formatMoney` / `formatDate` / `formatQuantity` / `parseNumber` |
| `frontend/src/App.tsx` | Shell, invoice fetch, 30 s health poll, drawer + chat wiring |
| `frontend/src/components/HealthChip.tsx` | Database kind + "Claude: ready / key missing" |
| `frontend/src/components/InvoiceTable.tsx` | Toolbar (count, Add invoice) + semantic `<table>` |
| `frontend/src/components/StatusPill.tsx` | paid / pending / overdue pill |
| `frontend/src/components/ReviewBadge.tsx` | Needs-review badge, notes in a `<details>` |
| `frontend/src/components/AddInvoiceDrawer.tsx` | `<dialog>` drawer: Paste / Upload tabs, extract, editable preview, save |
| `frontend/src/components/ChatPanel.tsx` | Suggestion chips, thread, `view query` disclosure, pending + error bubbles |
| `frontend/src/styles/tokens.css` | Palette, 4 px spacing scale, type scale, radii, motion |
| `frontend/src/styles/app.css` | All component styles |
| `frontend/src/__tests__/InvoiceTable.test.tsx` | Vitest + Testing Library smoke test |
| `frontend/src/test/setup.ts` | jest-dom matchers + `cleanup()` |
| `frontend/src/vite-env.d.ts` | Types for `VITE_API_URL` / `VITE_USE_MOCK` |
| `frontend/.env.example` | `VITE_API_URL=http://127.0.0.1:8000`, `VITE_USE_MOCK=false` |
| `frontend/vite.config.ts` | React plugin, dev port 5173, Vitest (jsdom) config |
| `frontend/README.md` | Replaced the Vite boilerplate with the real run instructions |

Removed from the scaffold: `src/App.css`, `src/index.css`, `src/assets/`.

## Component tree

```
App                                  health poll (30 s), invoice fetch, refresh-after-save
├── <header>
│   ├── mock-data chip               only when VITE_USE_MOCK=true
│   ├── HealthChip                   database kind · Claude ready / key missing
│   └── chat toggle                  visible below 900 px only
├── <main>
│   └── InvoiceTable                 toolbar + <table>
│       ├── StatusPill               paid / pending / overdue
│       └── ReviewBadge              <details> → <ul> of review_notes
├── <aside> ChatPanel                4 suggestion chips, thread, textarea
│   └── <details> "view query"       rendered only when sql_query_used is non-empty
└── AddInvoiceDrawer                 <dialog aria-modal> — tabs, extract, editable draft, save
```

## API contract

Verified against `backend/app/schemas.py` and the routers written by Task A:

- `GET /health` → `HealthResponse`
- `GET /invoices` → `InvoiceOut[]`
- `POST /invoices/extract` `{text}` → `ExtractResponse` (`invoice`, `needs_review`, `review_notes`, `model`)
- `POST /invoices/upload` multipart field **`file`** → `ExtractResponse`
- `POST /invoices` `InvoiceDraft` (+ `raw_text`) → `InvoiceOut`, 201
- `POST /chat` `{question}` → `{answer, sql_query_used}`

Errors: `ApiError` reads the server's `{"error": "..."}` body (`main.py` maps `HTTPException` and
`RequestValidationError` to that shape) and falls back to `Request failed with status N`. A failed
`fetch` (backend down) becomes `ApiError(0, "Cannot reach the API at …")`.

Guards mirroring the server: text ≥ 20 chars before extract, upload ≤ 2 MB, `accept=".txt,.md,.pdf"`.
Nothing is optimistic — every mutation is followed by a `GET /invoices` refetch.

## States handled

| Surface | Loading | Empty | Error |
|---|---|---|---|
| Invoice table | shimmer skeleton rows; "refreshing…" on refetch | "No invoices yet" + how to add one | `role="alert"` panel + **Try again** |
| Health chip | "Checking API…" | — | "API unreachable" (red dot, message in `title`) |
| Extract | button → "Extracting…" + animated pending indicator | — | `notice--error` with the server message |
| Save | button → "Saving…" | — | `notice--error` (422 validation text included) |
| Chat | "Thinking…" indicator | "No questions yet — pick a suggestion…" | red bubble with the server message + `(HTTP 503)` / `(HTTP 502)` |
| No API key | — | — | Add invoice disabled + inline reason; drawer + chat inputs disabled with a `role="status"` note |

## Accessibility

- Semantic HTML: `<header>` / `<main>` / `<aside>`, `<table>` with `<caption>`, `<th scope="col">` per
  column and `<th scope="row">` for the vendor cell, `<dialog aria-modal="true">` for the drawer
  (native focus trap, Esc-to-close, focus returned to the trigger).
- `aria-live="polite"` on the chat thread, the health chip and the invoice count.
- Every input has a real `<label>`; line-item inputs use visually-hidden labels ("Line 2 quantity").
- Tabs use `role="tablist"` / `role="tab"` + `aria-selected` + `aria-controls`; the chat toggle uses
  `aria-expanded` / `aria-controls`.
- Visible focus ring on everything (`:focus-visible`, 2 px, 2 px offset). Buttons are ≥ 44 px tall
  (`--tap`); chips are 36 px by design as secondary shortcuts.
- Status is carried by the pill **label**, not colour alone; the review badge is a keyboard-operable
  `<details>`, not a hover-only tooltip.
- Money uses `font-variant-numeric: tabular-nums`; the status cell reserves height so the badge causes
  no layout shift.
- `prefers-reduced-motion: reduce` zeroes `--dur` and disables the drawer, skeleton and pending
  animations.
- Layout: fixed-height app shell above 900 px (each column scrolls on its own, no page scrollbars);
  below 900 px it stacks and the chat collapses behind the toggle.

## Formatting

`Intl.NumberFormat(undefined, { style: "currency", currency })`, memoised per code, falling back to
`1,234.50 XYZ` when the code is not three letters or `Intl` rejects it. Dates via `Intl.DateTimeFormat`
(`Aug 12, 2026`); a bare `YYYY-MM-DD` is parsed as local midnight so it never shifts a day; `null`
renders as an em dash.

## Verification

```
$ npx tsc -b                       # exit 0
$ npx tsc --noEmit -p tsconfig.app.json
                                   # exit 0
$ npm run build
  ✓ 26 modules transformed.
  dist/index.html                   0.65 kB │ gzip:  0.38 kB
  dist/assets/index-C4i6wDq7.css   14.39 kB │ gzip:  3.47 kB
  dist/assets/index-CJvBflwm.js   213.21 kB │ gzip: 66.11 kB
  ✓ built in 97ms

$ npm test
  Test Files  1 passed (1)
       Tests  2 passed (2)

$ npx oxlint
  1 warning (see "Known nits")
```

Test coverage: `InvoiceTable` renders the needs-review row (badge, note text, `Overdue` pill) and the
full pill census (2 paid / 2 pending / 2 overdue, exactly 1 needs-review badge, `Total` column header).

### Manual run (Playwright, `VITE_USE_MOCK=true`)

- `docs/reports/screenshots/frontend-mock.png` — table with the six fixtures, an expanded
  needs-review badge showing both notes, and a chat exchange with `view query` open on the SQL.
- `docs/reports/screenshots/frontend-mock-drawer.png` — Add-invoice drawer after "Extract with
  LangChain": model chip, validation result, editable fields, editable line-items table with a live
  "lines total", subtotal/tax/total.
- End-to-end in mock mode: extract → edit → **Save invoice** → drawer closes → table refetches and the
  count goes 6 → 7. No console errors.

The dev server ran on **5174**, not 5173: an unrelated Node process already held `::1:5173` and was
left alone. Note that the backend's default `CORS_ORIGINS` only lists `:5173`, so for real-backend dev
either free 5173 or add the port to `backend/.env`.

## Known nits

- `oxlint` reports one `react(set-state-in-effect)` warning for the mount-time invoice fetch in
  `App.tsx`. It is the standard fetch-on-mount pattern (the `setState` calls happen after `await`);
  left as-is rather than contorting the code.
- The real backend was not listening on `:8000` while this task ran, so `GET /invoices` was only
  exercised against the mock. The contract was verified by reading `schemas.py`, `routers/invoices.py`,
  `routers/chat.py` and `main.py` instead; paths, the multipart field name `file`, the 201 on create
  and the `{error}` error shape all match.
- Clearing the required invoice-date field in the drawer sends an empty string and relies on the
  server's 422 (surfaced inline). Client-side field validation was deliberately not added — the spec
  makes the server the validator.
