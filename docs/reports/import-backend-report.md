# Structured-file import — backend report

Date: 2026-08-21 · Spec: `docs/SPEC.md` · Builds on `docs/reports/backend-report.md`
Status: **complete**, `pytest -q` → **168 passed** (73 before, 95 new), live-verified against Supabase Postgres with a real `ANTHROPIC_API_KEY`.

The feature: a user uploads **any** CSV / JSON / XLSX export whose column names are not ours
(`Supplier, Inv No, Bill Date, Pay By, Amount Due, VAT, Net, Ccy, State`). The backend parses it,
asks Claude which source column feeds which `Invoice` field, applies that mapping **deterministically**,
validates every resulting invoice, and returns a preview. A second endpoint inserts the confirmed drafts.

The division of labour is the point: **Claude decides what the columns mean, code decides what the
values are.** No amount, date or status is ever produced by the model.

---

## 1. Files delivered

All paths relative to `backend/`.

| File | Lines | What it does |
|---|---:|---|
| `app/file_parsing.py` | 231 | `parse_tabular()` → `ParsedTable(headers, rows, filename, flattened)`; CSV / JSON / XLSX readers; `UnsupportedFile`, `EmptyFile`, `FileTooLarge` |
| `app/column_mapping.py` | 369 | `heuristic_mapping()`, **`llm_mapping()` (the LangChain call)**, `choose_mapping()`, `build_mapper()`, `MappingError` |
| `app/importing.py` | 434 | `parse_money()`, `parse_date()`, `parse_status()`, `parse_line_items_cell()`, `apply_mapping()`, `collect_warnings()`, `build_preview()` |
| `app/routers/invoices.py` | 197 (+76) | new `POST /invoices/import` and `POST /invoices/bulk` |
| `tests/fixture_files.py` | 35 | `read_fixture()` and `build_weird_xlsx()` (openpyxl at test time — no binary committed) |
| `tests/fixtures/vendor_export.csv` | 5 | 4 summary rows: `$`-formatted amount, empty `Pay By`, `Settled` state, DMY dates |
| `tests/fixtures/line_items_export.csv` | 6 | 2 invoices × 3 and 2 lines, **no totals at all** (they must be derived) |
| `tests/fixtures/erp_export.json` | 31 | array of objects with nested `vendor: {name, email}` and a `lines` array |
| `tests/test_file_parsing.py` | 128 | 16 tests |
| `tests/test_column_mapping.py` | 233 | 17 tests |
| `tests/test_importing.py` | 291 | 48 tests |
| `tests/test_import_api.py` | 184 | 14 tests |
| `tests/fakes.py` | 69 (+21) | new `StructuredValueFake` — `with_structured_output` for any schema |

Unchanged: `app/schemas.py` (the import types were already there), `app/main.py`, `app/validation.py`,
`app/seed.py`, `requirements.txt` (`openpyxl`, `python-dateutil` already pinned).

---

## 2. How the LangChain mapping call is built

The one call that matters is `build_chat_model(settings).with_structured_output(ColumnMapping)` behind
a `ChatPromptTemplate` — the same shape as the extraction chain, but the schema is a *mapping*, not an
invoice.

| Where | What |
|---|---|
| `app/column_mapping.py:281` | `MAPPING_SYSTEM_PROMPT` — "You map spreadsheet columns onto an invoice schema. Use the exact header strings. Return null for fields the file does not have. Decide granularity from whether rows repeat an invoice number with different line descriptions. Infer currency_default from symbols, locale or vendor country when there is no currency column. date_format from the sample dates." |
| `app/column_mapping.py:291` | `build_mapper(settings, model=None)` — reuses `build_chat_model()` from `app/extraction.py:51`, so a missing key raises `LLMNotConfigured` before any network call |
| `app/column_mapping.py:294` | `ChatPromptTemplate.from_messages([("system", MAPPING_SYSTEM_PROMPT), ("human", "{payload}")])` |
| `app/column_mapping.py:295` | `prompt \| chat.with_structured_output(ColumnMapping)` |
| `app/column_mapping.py:298` | `_payload()` — the header list plus **up to 5 sample rows** as JSON. Passed as a *single template variable* so the JSON braces are never read as f-string placeholders |
| `app/column_mapping.py:309` | `_sanitise()` — every column name the model returns must be a real header (see below) |
| `app/column_mapping.py:337` | `llm_mapping()` — provider/parse failures are wrapped in `MappingError`, never swallowed |
| `app/column_mapping.py:355` | `choose_mapping()` — Claude when configured, heuristics otherwise |

### Keeping the model honest (`_sanitise`)

`ColumnMapping` guarantees the *shape* of the answer, not its *truth*: Claude can still name a column
that does not exist. So every returned column name is checked against the real headers:

1. exact header match → keep;
2. otherwise a normalised, case-insensitive match → repair it, and say so in `notes`
   (`"Matched po_number to the column 'PO Ref' (the model wrote 'po ref')."`);
3. otherwise → set the field to `None` and say so
   (`"Dropped total: 'Grand Total' is not a column in this file."`).

`currency_default` gets the same treatment: anything that is not a 3-letter ISO code is dropped with a note.

### The mapper is never allowed to fail the upload

`choose_mapping()` catches `MappingError` / `LLMNotConfigured`, falls back to `heuristic_mapping()`, and
**prepends the error to the mapping notes** so the reason is visible in the preview instead of hidden:

```
notes[0] = "Claude column mapping failed: 529 overloaded"
```

`mapping_source` in the response is then `"heuristic"`, and `model` is `null`. A 529 from Anthropic
degrades the quality of the mapping; it does not cost the user their upload.

### The heuristic twin

`heuristic_mapping()` (`app/column_mapping.py:256`) is a full offline implementation of the same
contract, used without a key and as the fallback. It scores every (target, header) pair on
**word-boundary** matches against a synonym table, then greedily assigns one-to-one, best score first:

| Shape | Score |
|---|---|
| normalised header == synonym (`Inv No` ≡ `inv no`) | `100 + len` |
| header tokens *start with* the synonym (`Total Incl. Tax` → `total`) | `70 + len` |
| header tokens *end with* the synonym (`PO Ref` → `ref`) | `60 + len` |
| synonym appears mid-header | `50 + len` |
| cells parse as a JSON array → `line_items_json` | `95` |

Tokenising rather than substring-matching is what makes `Total Incl. Tax` a total and not a tax column,
and `Line Total` a line amount and not the invoice total (its exact `line total` match at 109 beats the
suffix match `total` at 65).

The **bare `amount` ambiguity** is resolved after the greedy pass (`app/column_mapping.py:179`): `amount`
is excluded from both candidate lists, and then assigned to `total` if no invoice-level total column was
found, or to `line_item_amount` if one was — with the reasoning recorded in `notes`.

---

## 3. Parser rules

### File parsing (`app/file_parsing.py`)

| Format | Rules |
|---|---|
| CSV/TSV | `csv.Sniffer` over the first 8 KB restricted to `,;\t\|`, falling back to `,`; UTF-8 **BOM stripped** (`utf-8-sig`); fully empty rows skipped; blank headers become `column_N`, duplicates get a ` (2)` suffix so no column is silently lost |
| JSON | an array of objects, **or** an object with exactly one array-valued key, **or** a single object ⇒ one row. Nested dicts flatten to dotted keys (`vendor.name`); lists stay as JSON text for the line-item unpacker; rows are squared off so every row has every column |
| XLSX | `openpyxl`, `data_only=True`, `read_only=True`, first sheet, **first non-empty row = headers**. Datetimes become ISO dates, integral floats lose the trailing `.0` |

Limits: **2 MB** (`MAX_FILE_BYTES`) and **2 000 rows** (`MAX_ROWS`) → `FileTooLarge`. Not one of those
extensions → `UnsupportedFile`. Parsed but no data rows → `EmptyFile`. A non-UTF-8 or malformed file
raises `FileParseError` with the underlying message attached — nothing is guessed around.

### Cell parsing (`app/importing.py`)

| Function | Rules |
|---|---|
| `parse_money` (`:65`) | strips currency symbols, 3-letter codes, spaces, NBSP; `(1,234.50)` ⇒ negative; **European detection**: a comma followed by exactly two digits at the end, and later than any dot, means `1.234,50 → 1234.50`; otherwise commas are thousands marks. Unreadable ⇒ `None`, never `0.0` |
| `parse_date` (`:98`) | ISO fast-path (`YYYY-MM-DD`, also from `... 00:00:00`); a bare 8-digit number is `YYYYMMDD` and any other bare number is **rejected** (so `1234` is not parsed as 12:34); otherwise `dateutil.parser.parse` with `dayfirst`/`yearfirst` taken from the mapping's `date_format`. Unreadable ⇒ `None` |
| `parse_status` (`:129`) | `unpaid`/`not paid` ⇒ pending (checked first, so "unpaid" is not read as "paid"); `paid\|settled\|closed\|complete` ⇒ paid; `overdue\|late\|past due` ⇒ overdue; anything else, including empty ⇒ pending |
| `parse_line_items_cell` (`:187`) | a JSON array of objects with flexible keys (`desc`/`qty`/`rate`/`line_total` all work), or `Description x 3 @ 250.00` text lines |

`date_format` is sniffed from the mapped date columns (`app/column_mapping.py:216`): all-ISO ⇒ `ISO`;
otherwise **a day part over 12 decides** DMY, a month part over 12 decides MDY, and a genuinely
ambiguous file stays `unknown` and is parsed leniently. `03/08/2026` alone is ambiguous — it is
`28/08/2026` elsewhere in the same column that proves the file is day-first.

### Conversion (`app/importing.py:296`)

Grouping: `line_item` granularity groups by normalised invoice number in **first-seen order**; rows with
an empty number are skipped and counted in `warnings`. `invoice` granularity is one draft per row.
Invoice-level fields take the first non-empty value in the group.

Every derivation appends one sentence to `import_notes` (informational — not a validation failure):

| Missing | Derived as | Note |
|---|---|---|
| tax | `0` | "No tax column in the file; tax recorded as 0." |
| subtotal | sum of line amounts, else `total − tax` | "Subtotal was not in the file; summed 3 line amount(s) to 1000.00." |
| total | `subtotal + tax` | "Total was not in the file; used subtotal + tax = 1000.00." |
| invoice number | `IMPORT-<filename-stem>-<row>` | "No invoice number in the file; generated IMPORT-ops-export-2." |

Line items come from the line-item columns (when at least two are mapped), else from a packed
`line_items_json` cell, else a single synthesized line **only if a description column exists** —
otherwise `line_items` stays empty and `validate_invoice` flags it. A summary-only export therefore
lands as `needs_review: true` with "No line items were extracted.", which is the honest answer.

An unreadable invoice date falls back to today's date **and** adds a `review_notes` entry, so an invented
value can never pass as an imported one. Currency is the row's currency cell (code or symbol), else the
mapping's `currency_default`, else `USD`.

Finally `round_money` → `derive_status` → `validate_invoice`, exactly as the extraction path does.
`source_rows` is 1-based with the header as row 1, so the first data row is **2**.

---

## 4. API

| Method & path | Body | Response |
|---|---|---|
| `POST /invoices/import` | multipart `file` (.csv/.tsv/.json/.xlsx ≤ 2 MB) | `ImportPreview` — 415 unsupported, 413 too large, 422 empty/unparseable. **No write.** |
| `POST /invoices/bulk` | `BulkCreateRequest { invoices: InvoiceDraft[] }` (1–500) | `BulkCreateResponse { created, skipped }`, **201** |

`POST /invoices/bulk` (`app/routers/invoices.py:137`) re-validates every draft server-side through
`to_row(invoice, notes, "imported", raw_text=None)` — the preview is a suggestion, not a trusted payload.
Invoice numbers already in the database, or repeated inside the batch, go to `skipped` **with a reason**
rather than failing the whole batch; the inserts are one transaction per batch.

---

## 5. Live transcript (real key, Supabase Postgres)

```
$ curl -F file=@tests/fixtures/vendor_export.csv http://127.0.0.1:8000/invoices/import
HTTP 200 in 5.2s
```

Claude mapped, from headers it had never seen:

```json
{
  "granularity": "invoice",
  "invoice_number": "Inv No",   "vendor_name": "Supplier",
  "invoice_date": "Bill Date",  "due_date": "Pay By",
  "currency": "Ccy",            "status": "State",
  "subtotal": "Net",            "tax": "VAT",       "total": "Amount Due",
  "po_number": "PO Ref",        "date_format": "DMY",
  "notes": [
    "Each row is a distinct invoice number, so granularity is invoice-level.",
    "Dates are in DD/MM/YYYY order based on values like 28/08/2026.",
    "Amount Due contains currency symbols in some rows but is treated as the total field.",
    "Ccy column provides explicit currency codes, so no default is needed."
  ]
}
```

`mapping_source: "claude"`, `model: "claude-sonnet-5"`, `row_count: 4`, `unmapped_columns: []`.
The four previewed invoices (dates resolved day-first, `$1,234.50` → `1234.5`, `Settled` → `paid`):

```
NG-8801  Northgate Supply Co.      2026-08-03  due 2026-09-02  USD 1234.5/0.0/1234.5  pending  rows=[2]
BP-8802  Bluepeak Software Ltd     2026-08-28  due None        USD 2000.0/400.0/2400.0 paid    rows=[3]
MF-8803  Marlowe Facilities Group  2026-07-15  due 2026-08-14  EUR 880.0/105.6/985.6  overdue  rows=[4]
CF-8804  Cobalt Freight Services   2026-06-20  due 2026-07-20  USD 450.0/54.0/504.0   paid     rows=[5]
warnings: ["4 of 4 invoice(s) need review before saving."]   (no line items in a summary export)
```

Posting those four to `/invoices/bulk`:

```
HTTP 201 | created: 4 | skipped: 0
  id=21 NG-8801 ... source=imported needs_review=True
  id=22 BP-8802 ... source=imported needs_review=True
  id=23 MF-8803 ... source=imported needs_review=True
  id=24 CF-8804 ... source=imported needs_review=True
```

Re-posting the identical batch:

```
HTTP 201 | created: 0 | skipped: 4
  {"invoice_number": "NG-8801", "reason": "An invoice with this number already exists."}   (×4)
```

And the line-item CSV, where Claude had to spot the grouping itself:

```
source: claude | granularity: line_item | rows: 5 -> invoices: 2
notes: ["Rows repeat invoice numbers with different line items, so granularity is line_item.",
        "Date format inferred as ISO (YYYY-MM-DD) from sample dates.",
        "No currency column present; defaulted to USD based on vendor naming and lack of other locale cues."]

LI-3001 Aster Cloud Hosting     USD sub=1000.0 tax=0.0 total=1000.0 lines=3 rows=[2,3,4] review=False
LI-3002 Harbourline Print Works USD sub=675.0  tax=0.0 total=675.0  lines=2 rows=[5,6]   review=False
import_notes: ["No tax column in the file; tax recorded as 0.",
               "Subtotal was not in the file; summed 3 line amount(s) to 1000.00.",
               "Total was not in the file; used subtotal + tax = 1000.00."]
```

Claude's mapping matched the heuristic mapping on all four fixtures — which is the reassuring outcome:
the offline path is a real fallback, not a stub.

---

## 6. Tests — 95 new, `pytest -q` → 168 passed

No network: `llm_mapping` and `choose_mapping` are driven by `StructuredValueFake`
(`tests/fakes.py:33`), which duck-types `with_structured_output` for any schema and can also raise.

- `test_file_parsing.py` (16) — each reader; BOM; semicolon sniffing; blank/duplicate headers; the three
  JSON shapes; XLSX cell typing; and every error (415 / 422 / 413 / non-UTF-8).
- `test_column_mapping.py` (17) — heuristic mapping asserted field-by-field on all four fixtures; both
  sides of the bare-`amount` ambiguity; symbol-derived currency; DMY/MDY/unknown date sniffing;
  `llm_mapping` with a mapping that names a **non-existent column** (dropped with a note) and a
  wrong-case one (repaired with a note); a bad `currency_default`; `MappingError` wrapping;
  `choose_mapping` falling back to heuristics when the fake raises, with the error kept in `notes[0]`.
- `test_importing.py` (48) — table-driven `parse_money` / `parse_date` / `parse_status`
  (`"$1,234.50"`, `"(200.00)"`, `"1.234,50"`, `"28/08/2026"` DMY vs `"08/28/2026"` MDY, and the same
  `"03/08/2026"` reading as 3 Aug or 8 Mar depending on the hint, `"Settled"`); line-item grouping into
  2 invoices with 3/2 lines and subtotals 1000.00/675.00; derivations and their `import_notes`;
  the generated invoice number; the synthesized line; the invented-date review note; `source_rows`.
- `test_import_api.py` (14) — a preview for each of the four fixtures (`mapping_source == "heuristic"`
  with no key, correct `row_count`, correct invoices); `.exe` ⇒ 415; empty and header-only CSV ⇒ 422;
  oversized ⇒ 413; bulk creates 4 rows with `source == "imported"`; re-posting ⇒ all 4 skipped as
  duplicates; a mixed batch ⇒ partial; an in-batch duplicate ⇒ skipped; an empty list ⇒ 422.

---

## 7. Limits and known trade-offs

- **2 MB / 2 000 rows / 500 invoices per bulk call.** The row cap is checked while reading, so a
  runaway file is rejected before it is fully materialised.
- **The sample sent to Claude is 5 rows.** A file whose first five rows are unrepresentative (e.g. the
  currency only appears from row 200) may get a worse `currency_default`. The per-row currency column
  always wins over the default, so this only affects files with no currency column at all.
- **One column, one target.** The greedy assignment is one-to-one, so a file that legitimately reuses one
  column for two fields will leave the lower-scoring target unmapped (and it will be derived).
- **An unreadable invoice date becomes today's date.** `Invoice.invoice_date` is non-optional, so there is
  no "unknown" to store; the row is flagged in `review_notes` instead. If the schema ever allows a null
  invoice date, this fallback should go.
- **`derive_status` runs on import**, so an unpaid row past its due date is stored as `overdue` even when
  the file said `pending`. That matches the extraction path.
- **XLSX formulas** are read as their cached values (`data_only=True`); a workbook saved by a tool that
  never cached results will show empty cells rather than formulas.
- **No dry-run/undo on bulk.** Duplicates are skipped, but there is no way to roll back a batch after the
  fact other than deleting the rows.
