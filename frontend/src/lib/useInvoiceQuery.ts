// Owns the invoice list: filters, sorting, paging and the fetch that follows them.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, listInvoices } from "../api/client";
import type { InvoiceOut, InvoiceSortField, InvoiceSource, InvoiceStatus, SortOrder } from "../api/types";

/** UI sort choices flattened into the backend's (sort, order) pair. */
export const SORT_OPTIONS = [
  { value: "newest", label: "Newest", sort: "created_at", order: "desc" },
  { value: "invoice_date", label: "Invoice date", sort: "invoice_date", order: "desc" },
  { value: "due_date", label: "Due date", sort: "due_date", order: "asc" },
  { value: "total_desc", label: "Total high-low", sort: "total", order: "desc" },
  { value: "total_asc", label: "Total low-high", sort: "total", order: "asc" },
  { value: "vendor", label: "Vendor A-Z", sort: "vendor_name", order: "asc" },
] as const satisfies readonly {
  value: string;
  label: string;
  sort: InvoiceSortField;
  order: SortOrder;
}[];

export type SortKey = (typeof SORT_OPTIONS)[number]["value"];

export const PAGE_SIZES = [10, 25, 50] as const;

export const DEFAULT_PAGE_SIZE = 25;

/** "" means "no filter" for the two selects, which keeps them plain <select> values. */
export interface InvoiceFilters {
  search: string;
  status: InvoiceStatus | "";
  needsReview: boolean;
  source: InvoiceSource | "";
  sortKey: SortKey;
}

const SEARCH_DEBOUNCE_MS = 250;

interface CommittedQuery {
  q: string;
  status: InvoiceStatus | "";
  needsReview: boolean;
  source: InvoiceSource | "";
  sortKey: SortKey;
  page: number;
  pageSize: number;
}

const INITIAL_QUERY: CommittedQuery = {
  q: "",
  status: "",
  needsReview: false,
  source: "",
  sortKey: "newest",
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Unexpected error";
}

function isFiltered(query: Pick<CommittedQuery, "q" | "status" | "needsReview" | "source">): boolean {
  return Boolean(query.q || query.status || query.needsReview || query.source);
}

export interface InvoiceQueryController {
  items: InvoiceOut[];
  total: number;
  /** Total with no filters applied, so the count line can read "12 of 32 invoices". */
  baseTotal: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: string | null;
  filters: InvoiceFilters;
  filtersActive: boolean;
  setFilter: (patch: Partial<InvoiceFilters>) => void;
  clearFilters: () => void;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  refresh: () => void;
  /** Refetch and jump to page 1 when the newest rows would be there anyway. */
  refreshAfterSave: () => void;
}

export function useInvoiceQuery(): InvoiceQueryController {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<CommittedQuery>(INITIAL_QUERY);
  const [nonce, setNonce] = useState(0);

  const [items, setItems] = useState<InvoiceOut[]>([]);
  const [total, setTotal] = useState(0);
  const [baseTotal, setBaseTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Typing commits after a pause; committing also drops back to page 1.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === query.q) return;
    const timer = window.setTimeout(() => {
      setQuery((current) => ({ ...current, q: trimmed, page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, query.q]);

  useEffect(() => {
    const controller = new AbortController();
    const option = SORT_OPTIONS.find((entry) => entry.value === query.sortKey) ?? SORT_OPTIONS[0];

    async function load() {
      setLoading(true);
      try {
        const page = await listInvoices(
          {
            page: query.page,
            page_size: query.pageSize,
            q: query.q || undefined,
            status: query.status || undefined,
            needs_review: query.needsReview ? true : undefined,
            source: query.source || undefined,
            sort: option.sort,
            order: option.order,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setItems(page.items);
        setTotal(page.total);
        if (!isFiltered(query)) setBaseTotal(page.total);
        setError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(messageOf(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [query, nonce]);

  const setFilter = useCallback((patch: Partial<InvoiceFilters>) => {
    if ("search" in patch) setSearch(patch.search ?? "");
    const { search: _search, ...rest } = patch;
    if (Object.keys(rest).length === 0) return;
    // Any filter or sort change starts again from the first page.
    setQuery((current) => ({ ...current, ...rest, page: 1 }));
  }, []);

  const clearFilters = useCallback(() => {
    setSearch("");
    setQuery((current) => ({
      ...current,
      q: "",
      status: "",
      needsReview: false,
      source: "",
      page: 1,
    }));
  }, []);

  const setPage = useCallback((page: number) => {
    setQuery((current) => (current.page === page ? current : { ...current, page }));
  }, []);

  const setPageSize = useCallback((size: number) => {
    setQuery((current) => (current.pageSize === size ? current : { ...current, pageSize: size, page: 1 }));
  }, []);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const refreshAfterSave = useCallback(() => {
    setQuery((current) =>
      current.sortKey === "newest" && current.page !== 1 ? { ...current, page: 1 } : current,
    );
    setNonce((value) => value + 1);
  }, []);

  const filters = useMemo<InvoiceFilters>(
    () => ({
      search,
      status: query.status,
      needsReview: query.needsReview,
      source: query.source,
      sortKey: query.sortKey,
    }),
    [search, query.status, query.needsReview, query.source, query.sortKey],
  );

  return {
    items,
    total,
    baseTotal,
    page: query.page,
    pageSize: query.pageSize,
    loading,
    error,
    filters,
    filtersActive: Boolean(search.trim()) || isFiltered(query),
    setFilter,
    clearFilters,
    setPage,
    setPageSize,
    refresh,
    refreshAfterSave,
  };
}
