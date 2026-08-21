# Import file — Frontend report

Date: 2026-08-21 · Backend contract: `backend/app/schemas.py` § "structured-file import"

A third tab in the Add-invoice drawer: pick a `.csv` / `.json` / `.xlsx` export, let LangChain map its
columns onto the `Invoice` schema, review what came back, then create the rows you keep.
Nothing is stored until the user presses **Import**.

## Files

| File | Change |
|---|---|
| `frontend/src/api/types.ts` | Added `RowGranularity`, `DateFormatHint`, `ColumnMapping`, `ImportedDraft`, `ImportPreview`, `BulkCreateRequest`, `SkippedInvoice`, `BulkCreateResponse`; `InvoiceSource` now includes `"imported"` |
| `frontend/src/api/client.ts` | `importFile(file)` → `POST /invoices/import` (multipart `file`), `bulkCreate(invoices)` → `POST /invoices/bulk`; both honour `VITE_USE_MOCK` |
| `frontend/src/api/mock.ts` | `MOCK_IMPORT_PREVIEW` fixture + `mockApi.importFile` / `mockApi.bulkCreate` |
| `frontend/src/components/ImportPanel.tsx` | **New** — the whole import flow (picker → mapping card → preview table → bulk create → result) |
| `frontend/src/components/AddInvoiceDrawer.tsx` | Third tab, three-way panel switch, wide-drawer variant, import-aware footer |
| `frontend/src/components/InvoiceTable.tsx` | `imported` source tag |
| `frontend/src/App.tsx` | A missing API key no longer disables **Add invoice** (import works without one) |
| `frontend/src/styles/app.css` | `.drawer--wide`, `.import*`, `.mapping*`, `.review--info`, `.model-chip--muted`, `.cell-ccy` |
| `frontend/src/test/setup.ts` | jsdom shim for `HTMLDialogElement.showModal`/`close` |
| `frontend/src/__tests__/AddInvoiceDrawer.test.tsx` | **New** — 2 tests over the import tab |

The panel lives in its own component because the drawer was already ~500 lines; the drawer keeps it
mounted (`hidden` when another tab is active) so switching tabs never throws away a mapped preview,
and remounts it with a `key` bump when the drawer resets.

## The flow

1. **Pick a file** — `accept=".csv,.json,.xlsx"`, 2 MB guard client-side (the server enforces it too).
   The chosen name and size are echoed under the picker.
2. **Map columns with LangChain** — calls `importFile`. While it runs the button reads
   *Mapping columns…* and a dot-pulse says *Reading `<filename>`…*. Failures render the server's
   `{error}` message verbatim in an error bubble (`role="alert"`) — 413 / 415 / 422 all land there.
3. **Mapping card**
   - Badge: `Mapped by Claude (<model>)` (accent) or `Mapped heuristically (no API key)` (muted),
     from `mapping_source` / `model`.
   - Two-column table **Invoice field ← Source column**. `granularity` renders first as a sentence
     ("One row per invoice" / "One row per line item, grouped by invoice number"); every non-null
     column field follows in schema order; `currency_default` renders as
     `GBP (assumed — no currency column)` and `date_format` as `DMY — day/month/year`.
     Null fields are simply absent.
   - **Unmapped columns** and the mapper's **Mapping notes** as muted bullet lists; `warnings`
     as a separate amber notice.
4. **Preview table** — one row per `ImportedDraft`: checkbox (all ticked), invoice #, vendor, date,
   total + currency code, `StatusPill`, `ReviewBadge` with its notes when `needs_review`, and a
   neutral `<details>` whose summary is `ⓘ rows 2–4` (`row 7` for a single row, an explicit list when
   non-contiguous) expanding to `import_notes` such as *"Subtotal derived as total − tax"*.
   The header checkbox toggles all (indeterminate when partial).
5. **Import N of M** — `bulkCreate(selected.map(d => ({ ...d.invoice })))`, then a result panel
   **Created N · Skipped M** listing each skip reason, and `onSaved()` refreshes the invoice table.
   The drawer stays open so the result is readable.

## States handled

| State | UI |
|---|---|
| No file chosen | Map button disabled |
| File > 2 MB | Local error bubble before any request |
| Mapping in flight | Button label + dot-pulse with the filename |
| Mapping failed | `notice--error` with the server's `{error}` |
| Heuristic mapping (no key) | Muted badge, everything else identical |
| 0 selected | Import button disabled, label `Import 0 of 3` |
| Import in flight | Button reads *Importing…* and is disabled |
| Import failed | `notice--error`, preview kept so the user can retry |
| Import done | `Created N · Skipped M` (amber when anything was skipped) + skip reasons |

## Accessibility

- The tab is a real `role="tab"` with `aria-selected` / `aria-controls`, in the existing tablist;
  its panel is `role="tabpanel"` + `aria-labelledby`, hidden (not unmounted) when inactive.
- Mapping table: `<th scope="col">` headers and `<th scope="row">` for each invoice-field name,
  plus a visually-hidden `<caption>`.
- Preview table: visually-hidden `<caption>`, `<th scope="row">` for the invoice number, and every
  checkbox labelled — `aria-label="Include MTL-4820"`, `aria-label="Include all invoices"`.
- A visually-hidden `role="status" aria-live="polite"` region announces
  *"Mapped 3 invoices from ledger-export-aug.csv"* and *"Created 3 invoices, skipped 0."*.
- Status is carried by the pill label, not colour; the info disclosure is a native `<details>`
  (keyboard-operable) and its neutral styling keeps it distinct from the amber review badge.
- The drawer is wider on this tab (`.drawer--wide`, 980 px) so the 7-column preview does not
  collapse when a disclosure is open.

## Mock fixture

`MOCK_IMPORT_PREVIEW` is a line-item-granularity ledger export: 7 rows → 3 invoices
(`MTL-4820` rows 2–4, `KF-2026-118` rows 5–6 with `needs_review` + 2 notes, `WC-0912` row 7),
a mapping with nulls (`vendor_email`, `currency`, `subtotal`, `po_number`, `line_items_json`),
`currency_default: "GBP"`, `date_format: "DMY"`, two mapper notes, one unmapped column
(`Cost Centre`) and two warnings. `mockApi.bulkCreate` mirrors the server: it creates what it can
with `source: "imported"` and skips invoice numbers already stored, so re-importing the same file
shows the skip path.

## Verification

```
npm run typecheck   tsc -b — clean
npm test            2 files, 4 tests passed (InvoiceTable 2, AddInvoiceDrawer 2)
npm run build       tsc -b && vite build — 27 modules, dist/assets 222.71 kB JS / 15.59 kB CSS
npm run lint        oxlint — 1 pre-existing warning in App.tsx (set-state-in-effect), untouched
```

`src/__tests__/AddInvoiceDrawer.test.tsx` mocks `../api/client` with `vi.mock` (+ `importActual`
so `ApiError` stays real) and drives the real drawer: clicks the **Import file** tab, uploads a
CSV, presses **Map columns with LangChain**, then asserts the Claude badge, the mapping rows
(`Rows`, `Invoice number → Inv No`, `Vendor → Supplier`, `Line quantity → Qty`, `Currency default`,
`Date format`), the absence of a `PO number` row, the `Cost Centre` unmapped entry, the
needs-review badge with its notes and `rows 5–6`, and the selection count going
`Import 3 of 3` → `Import 2 of 3` → `Import 3 of 3` → `Import 0 of 3` (disabled).

jsdom does not implement `HTMLDialogElement.showModal`, so `src/test/setup.ts` shims it —
test-only, production code untouched.

### Manual run (Playwright, `VITE_USE_MOCK=true`, `npx vite --port 5176 --strictPort`)

- Add invoice → **Import file** → chose `ledger-export-aug.csv` → **Map columns with LangChain**.
- Mapping card, unmapped column, mapper notes, warnings, and the 3-row preview all render;
  live region announced *Mapped 3 invoices from ledger-export-aug.csv*.
- **Import 3 of 3** → `Created 3 · Skipped 0`, table refreshed with three `imported` rows.
- Pressing it again → `Created 0 · Skipped 3` with "An invoice with this number already exists."
  for each — the duplicate path renders as designed.

Screenshots:

- `docs/reports/screenshots/import-tab-mock.png` — the whole tab: picker, mapping table, unmapped
  column, notes, warnings, preview with an open review badge and an open `rows 2–4` disclosure.
- `docs/reports/screenshots/import-result-mock.png` — the skipped-duplicates result panel.
- `docs/reports/screenshots/import-tab-real.png` — see below.

### Against the real backend

Re-ran the same flow with `VITE_USE_MOCK=false VITE_API_URL=http://127.0.0.1:8000` on port 5176
against the live API (Postgres, `llm_configured: true`), uploading a 2-row CSV with the headers
`Supplier,Inv No,Bill Date,Pay By,Amount Due,Ccy,State`:

- `POST /invoices/import` returned a Claude mapping — `Rows: One row per invoice`,
  `Inv No / Supplier / Bill Date / Pay By / Ccy / State / Amount Due`, `Date format: DMY`,
  three mapper notes and one warning ("2 of 2 invoice(s) need review before saving").
  No unmapped columns, so that section correctly does not render.
- Both rows previewed with `row 2` / `row 3` disclosures carrying the real derivations
  ("No tax column in the file; tax recorded as 0.", "Subtotal was not in the file; derived it as
  total minus tax.") and a `Needs review (1)` badge each ("No line items were extracted.").
- **Import 2 of 2** → `POST /invoices/bulk` → `Created 2 · Skipped 0`; `GET /invoices` shows
  ids 25–26 with `source: "imported"`, and the table re-rendered them with the `imported` tag.

Screenshot: `docs/reports/screenshots/import-tab-real.png`.
Both dev servers were stopped afterwards; the API on :8000 was left running.

## Known nits

- `App.tsx` no longer disables **Add invoice** when `/health` reports no key: import maps
  heuristically without one, and the drawer already explains that extraction is unavailable on the
  Paste/Upload tabs. An unreachable API still disables the button.
- The preview table gets tight when several disclosures are open at once; the drawer widens to
  980 px on this tab to compensate, but a very long `import_notes` list still stretches its row.
- The import panel keeps its state while the drawer is open (deliberate — a mapping costs an LLM
  call) and is thrown away when the drawer closes.
- No client-side editing of imported drafts: rows are included or excluded, not corrected. Editing
  belongs on the extraction tabs, and the server re-validates every row anyway.
