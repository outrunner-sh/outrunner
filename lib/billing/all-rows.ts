/** Paged reads, with no client of their own: what a query that could pass
 *  PostgREST's row cap reads through. */

/** Rows per page: PostgREST answers at most its max-rows (1000 by default),
 *  so a read that could be longer is paged. */
const PAGE_ROWS = 1000;

/** Every row a query matches, a page at a time, in a stable order (`page`
 *  orders by id and takes the range). */
export async function allRows<Row>(
  page: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_ROWS) return rows;
  }
}
