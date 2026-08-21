-- lang-chain-app: the invoices table (SPEC section 3), Postgres / Supabase flavour.
-- Apply in the Supabase SQL editor. SQLite dev instances get the same shape from
-- Base.metadata.create_all() in app/db.py -- keep the two in sync when the model changes.

create table if not exists public.invoices (
    id             bigint generated always as identity primary key,
    invoice_number varchar(64)   not null,
    vendor_name    varchar(200)  not null,
    vendor_email   varchar(200),
    invoice_date   date          not null,
    due_date       date,
    status         varchar(16)   not null default 'pending',
    line_items     jsonb         not null default '[]'::jsonb,
    subtotal       numeric(12,2) not null,
    tax            numeric(12,2) not null default 0,
    total          numeric(12,2) not null,
    currency       varchar(3)    not null default 'USD',
    po_number      varchar(64),
    needs_review   boolean       not null default false,
    review_notes   jsonb         not null default '[]'::jsonb,
    source         varchar(20)   not null default 'seed',
    raw_text       text,
    created_at     timestamptz   not null default now()
);

create unique index if not exists ix_invoices_invoice_number on public.invoices (invoice_number);
create index if not exists ix_invoices_status on public.invoices (status);
create index if not exists ix_invoices_due_date on public.invoices (due_date);

-- The demo connects with the service/session-pooler role only (no RLS policies, see SPEC section 7).
