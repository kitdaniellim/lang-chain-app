import { useId } from "react";
import { PAGE_SIZES } from "../lib/useInvoiceQuery";

interface TablePagerProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

/** Footer pager: the visible range, page size, and the two step buttons. */
export function TablePager({ page, pageSize, total, onPageChange, onPageSizeChange }: TablePagerProps) {
  const uid = useId();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="pager">
      <p className="pager__range" aria-live="polite">
        <span className="numeric">
          {first}-{last} of {total}
        </span>
        <span className="visually-hidden">
          , page {page} of {pages}
        </span>
      </p>

      <div className="pager__size">
        <label className="field__label" htmlFor={`${uid}-size`}>
          Rows
        </label>
        <select
          id={`${uid}-size`}
          className="input select select--compact"
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      <button type="button" className="btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        Previous
      </button>
      <button
        type="button"
        className="btn"
        disabled={page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </button>
    </div>
  );
}
