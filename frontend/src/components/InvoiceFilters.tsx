import { useId } from "react";
import type { InvoiceSource, InvoiceStatus } from "../api/types";
import { SORT_OPTIONS, type InvoiceFilters as Filters } from "../lib/useInvoiceQuery";
import { SearchIcon } from "./icons";

interface InvoiceFiltersProps {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  onClear: () => void;
  /** Shows the clear button; sort alone does not count as a filter. */
  active: boolean;
}

const STATUS_OPTIONS: { value: InvoiceStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "paid", label: "Paid" },
  { value: "pending", label: "Pending" },
  { value: "overdue", label: "Overdue" },
];

// "seed-fallback" is deliberately absent: those rows are excluded while "seed" is selected.
const SOURCE_OPTIONS: { value: InvoiceSource | ""; label: string }[] = [
  { value: "", label: "Any" },
  { value: "seed", label: "seed" },
  { value: "extracted", label: "extracted" },
  { value: "uploaded", label: "uploaded" },
  { value: "imported", label: "imported" },
];

/** Search, status, needs-review, source and sort; every change resets to page 1 upstream. */
export function InvoiceFilters({ filters, onChange, onClear, active }: InvoiceFiltersProps) {
  const uid = useId();

  return (
    <div className="filters" role="group" aria-label="Search and filter invoices">
      <div className="filters__field filters__field--search">
        <label className="field__label" htmlFor={`${uid}-search`}>
          Search
        </label>
        <div className="search">
          <SearchIcon className="search__glyph" size={16} />
          <input
            id={`${uid}-search`}
            className="input search__input"
            type="text"
            value={filters.search}
            placeholder="Search vendor, invoice # or email"
            onChange={(event) => onChange({ search: event.target.value })}
          />
          {filters.search && (
            <button
              type="button"
              className="search__clear"
              aria-label="Clear search"
              onClick={() => onChange({ search: "" })}
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="filters__field">
        <label className="field__label" htmlFor={`${uid}-status`}>
          Status
        </label>
        <select
          id={`${uid}-status`}
          className="input select"
          value={filters.status}
          onChange={(event) => onChange({ status: event.target.value as InvoiceStatus | "" })}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value || "all"} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="filters__field">
        <label className="field__label" htmlFor={`${uid}-source`}>
          Source
        </label>
        <select
          id={`${uid}-source`}
          className="input select"
          value={filters.source}
          onChange={(event) => onChange({ source: event.target.value as InvoiceSource | "" })}
        >
          {SOURCE_OPTIONS.map((option) => (
            <option key={option.value || "any"} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="filters__field">
        <label className="field__label" htmlFor={`${uid}-sort`}>
          Sort
        </label>
        <select
          id={`${uid}-sort`}
          className="input select"
          value={filters.sortKey}
          onChange={(event) => onChange({ sortKey: event.target.value as Filters["sortKey"] })}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <label className={`toggle-pill${filters.needsReview ? " toggle-pill--on" : ""}`}>
        <input
          type="checkbox"
          className="toggle-pill__input"
          checked={filters.needsReview}
          onChange={(event) => onChange({ needsReview: event.target.checked })}
        />
        Needs review
      </label>

      {active && (
        <button type="button" className="btn btn--text filters__clear" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}
