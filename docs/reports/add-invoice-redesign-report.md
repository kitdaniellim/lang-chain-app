# Add invoice: one-flow redesign

Design read: a redesign (overhaul) of an internal finance tool's intake flow for accounts-payable
users, Linear-style calm operational language, existing plain-CSS tokens plus native CSS
transitions, no new libraries. Dials: `DESIGN_VARIANCE 4 / MOTION_INTENSITY 4 / VISUAL_DENSITY 5`.
Preset: `minimalist-ui`, arbitrated by the `/ui-taste` router.

## What changed

The drawer had three tabs (Paste text, Upload file, Import file), a per-field extraction form and an
"Extract with LangChain" button. It now has one surface and one decision.

| Before | After |
| --- | --- |
| Three tabs, two of which called different endpoints | One dashed dropzone, one endpoint (`POST /invoices/ingest`) |
| A textarea for pasted invoice text | Removed. Files only |
| "Extract with LangChain" button | Selecting or dropping a file starts the work |
| A spinner and the words "Calling the model" | A file row, a phase status line, and a skeleton on the real column grid |
| 11 form inputs plus an editable line-item table | The previewed rows, rendered with the invoice table's own cells |
| "Import 2 of 3" in the import tab, "Save invoice" elsewhere | One footer button: "Save invoice" / "Save 3 invoices" / "Save 2 of 3" |

### Files

Added: `src/components/IngestDropzone.tsx`, `src/components/IngestPreviewTable.tsx`,
`src/components/InvoiceCells.tsx`, `src/components/icons.tsx`.
Rewritten: `src/components/AddInvoiceDrawer.tsx`, `src/__tests__/AddInvoiceDrawer.test.tsx`.
Removed: `src/components/ImportPanel.tsx`, plus the `extractFromText` / `extractFromFile` /
`saveInvoice` / `importFile` client calls, the `ExtractRequest` / `ExtractResponse` /
`ImportPreview` types, the `mockApi.extract` / `save` / `importFile` fakes, and roughly 170 lines of
CSS for the tabs, the field form and the old import panel.
Edited: `src/api/client.ts` (`ingestFile`, `bulkCreate(invoices, source)`), `src/api/types.ts`
(`IngestPreview`, `IngestSource`), `src/api/mock.ts` (`mockApi.ingest` branches on extension),
`src/components/InvoiceTable.tsx` and `src/components/ReviewBadge.tsx` (shared cells),
`src/lib/format.ts`, `src/styles/tokens.css`, `src/styles/app.css`, `index.html`.

`InvoiceCells` / `InvoiceHeaderCells` is the single definition of the six shared columns. The stored
table appends a Source column, the preview prepends a checkbox column, and both render the same
vendor, reference, dates, money, status pill and needs-review disclosure, in the same `.invoices`
styling. What you see in the preview is what lands in the table.

## Motion and CSS review

| Before | After | Why |
| --- | --- | --- |
| `animation: drawer-in var(--dur) var(--ease)` (180 ms, generic curve) | `var(--dur-drawer)` 300 ms with `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` | Drawers sit in the 200-500 ms band; the iOS curve is what makes a panel feel like it is being pulled, not faded |
| No `:active` state on any button | `.btn:active:not(:disabled) { transform: scale(0.97) }`, `transform 120ms var(--ease-out)` | Buttons must answer the press; 120 ms is inside the 100-160 ms feedback band |
| Reduced motion only shortened `--dur` to 1 ms, leaving the translateX keyframe | `drawer-fade` (opacity only, 160 ms) under `prefers-reduced-motion: reduce`; `--stagger` collapses to 0 | Reduced motion means gentler, not absent: the fade still explains that a panel arrived |
| A generic 3-dot spinner labelled "Calling the model" | Skeleton rows on the real column widths plus a phase line ("Reading file", then "Claude is mapping the columns") | A skeleton shaped like the answer removes the layout jump when the answer lands, and the phases are driven by the request lifecycle, not by a fake progress bar |
| Preview rows appeared all at once | `row-in`: `opacity 0 -> 1`, `translateY(4px) -> 0`, 160 ms `--ease-out`, first 6 rows staggered 30 ms each, rest instant | Stagger reads as rows arriving rather than a block being pasted; capping at 6 keeps a 50-row import from feeling slow |
| Import tab widened the drawer only when the tab was selected | `.drawer--wide` from the moment a file is accepted, width changed instantly (never transitioned) | `width` is a layout property; the change is folded into the state change the user just triggered, so it reads as a response, not an animation |
| Drag-over feedback did not exist | `border-color` to accent plus `transform: translateY(-1px)` | A 1 px lift is a transform, not a glow, and does not repaint the panel |
| `transition: background, border-color` on `.btn` | Same, with `transform` named explicitly | Never `transition: all`; every property is listed |
| Save button had no in-place progress | `.spinner`, 14 px, `animation: spin 640ms linear`, plus the label "Saving" | Constant motion takes `linear`; the label carries the meaning, the ring only reinforces it |

No animation starts from `scale(0)`, none uses `ease-in`, nothing animates `width`, `height`, `top`
or `left`, and the three keyframe animations (`drawer-in`, `row-in`, `spin`, plus the pre-existing
`shimmer`) all run once per occasional, non-keyboard interaction, so keyframes are safe here;
everything hover- or press-triggered uses transitions so it can be interrupted.

## Taste pre-flight

- **Em-dash sweep**: zero em-dash and zero en-dash characters in `src/` and `index.html`, confirmed
  by a `grep` over both. Fixed along the way:
  `formatDate`'s empty-date marker (now `-`), the `<title>`, the chat empty state, four mock line
  descriptions, the date-format labels, the "rows 5-6" source label and the spacing token comment.
  One string still shows a dash-free but awkward `invoice(s)`: it is a backend warning string from
  `app/importing.py`, not frontend copy.
- **Contrast**: dropzone text `--text` on `--surface-2` and the hint `--muted` on `--surface-2`
  measure about 7:1. The dashed edge uses a new `--border-dashed: #626d7d` token at about 3.1:1
  against `--surface-2`, clearing the 3:1 floor for a UI boundary (`--border-strong` was 1.8:1 and
  would have failed). "Saved 1 invoice." uses `--ok` at well over 4.5:1.
- **Targets**: the dropzone is a 208 px button; every checkbox is a 16 px box centred in a 44 px
  `<label class="check">`; "Choose a different file" and both footer buttons keep `min-height:
  var(--tap)` (44 px).
- **Focus**: verified in Chromium. Tabbing into the drawer focuses the dropzone, then the footer
  buttons; `:focus-visible` yields `2px solid rgb(158, 203, 255)` on each.
- **Reduced motion**: verified with `emulateMedia({ reducedMotion: 'reduce' })`. The drawer's
  computed `animation-name` becomes `drawer-fade` at 160 ms, `--dur`/`--dur-press`/`--dur-enter`/
  `--dur-drawer` all collapse to 1 ms and `--stagger` to 0 ms, so the row stagger, the shimmer and
  the save spinner stop.
- **Labelled controls**: the hidden file input carries `aria-label="Invoice file"`, each row
  checkbox is `Include <invoice number>`, the header checkbox is `Include all invoices`, the phase
  line and the summary are mirrored into a `role="status" aria-live="polite"` region, and both
  tables keep a visually hidden `<caption>`.
- **Icons**: Tabler `upload` and `file-description` outlines, inlined in `icons.tsx` at one stroke
  weight (1.5) because the project has no icon dependency and the brief forbids new libraries. No
  hand-drawn shapes, no emoji.
- **Copy**: sentence case, no exclamation marks, no filler verbs. "Claude is reading the invoice"
  and "Claude is mapping the columns" name the literal work rather than dressing it up.

## Verified against the real backend

Dev server on 5176 against `http://127.0.0.1:8000` (Postgres, `llm_configured: true`,
claude-sonnet-5), driven through the Playwright MCP.

- `odd_export.json` (German export, 3 invoices): mapped by Claude, previewed as `RE-2026-0881`
  Overdue, `RE-2026-0902` Paid, `RE-2026-0917` Overdue with "Needs review (2)". The mapping
  disclosure shows `Beleg.Nummer`, `Lieferant.Firma`, `Betrag.Brutto`, the `EUR` currency default,
  `DMY` and the status translation `offen -> pending, bezahlt -> paid, überfällig -> overdue`.
- `thornbury-invoice.txt` (created for this pass, in `.playwright-mcp/`): extracted to
  `TW-2026-3475`, THORNBURY WELDING SUPPLIES, GBP 934.56, Pending, with the source text kept in the
  collapsed disclosure. Saving it wrote the row with `source: "uploaded"`, the summary switched to
  "Saved 1 invoice.", the table behind refreshed from 31 to 32 invoices and the drawer closed
  itself. Two earlier passes saved `TW-2026-3318` and `TW-2026-3402` the same way.

Screenshots: `docs/reports/screenshots/add-invoice-dropzone.png`, `-processing.png`, `-result.png`,
`-saved.png`. The processing and saved shots were captured by holding the real states open from the
page (a fetch delay and a patched auto-close timer); the states themselves are unmodified.

## Notes

- `POST /invoices/import`, `/invoices/extract`, `/invoices/upload` and `POST /invoices` are still
  live on the backend but no longer called by this frontend.
- Drafts stay read-only in the preview, as asked: the only per-row affordances are the include
  checkbox and the notes disclosure. Editing a bad extraction still means fixing the source file.
- `npm run typecheck`, `npm test` (9 tests, 2 files) and `npm run build` are green. `npx oxlint`
  reports one pre-existing warning in `App.tsx` unrelated to this work.
