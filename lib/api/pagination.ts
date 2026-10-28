/**
 * Pages of a list, as every list in the public API answers:
 *
 *   { "data": [...], "page": 1, "per_page": 20, "total": 42, "total_pages": 3, "has_more": true }
 *
 * `page` counts from 1; `per_page` is 20 unless asked, at most 100.
 */

export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

export type PageRequest = { page: number; perPage: number };

/** The page asked for in a query, or the reason it can't be read. */
export function pageRequest(params: URLSearchParams): PageRequest | string {
  const page = whole(params.get("page"), 1);
  const perPage = whole(params.get("per_page"), DEFAULT_PER_PAGE);
  if (page === null || page < 1) return "`page` must be a whole number from 1.";
  if (perPage === null || perPage < 1 || perPage > MAX_PER_PAGE) {
    return `\`per_page\` must be a whole number from 1 to ${MAX_PER_PAGE}.`;
  }
  return { page, perPage };
}

function whole(value: string | null, fallback: number): number | null {
  if (value === null || value === "") return fallback;
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}

export type Page<T> = {
  data: T[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  has_more: boolean;
};

/** One page of `items`, which hold the whole list. */
export function paginate<T>(items: readonly T[], { page, perPage }: PageRequest): Page<T> {
  return pageOf(items.slice((page - 1) * perPage, page * perPage), items.length, { page, perPage });
}

/** A page whose items were read for it alone, out of `total`. */
export function pageOf<T>(data: T[], total: number, { page, perPage }: PageRequest): Page<T> {
  const totalPages = Math.ceil(total / perPage);
  return { data, page, per_page: perPage, total, total_pages: totalPages, has_more: page < totalPages };
}
