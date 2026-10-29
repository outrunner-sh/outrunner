/** Stable cursors keep deletions in earlier pages from skipping later rows. */
export type LearningCursor = { created_at: string; id: string };

export function learningPageFilter(cursor: LearningCursor): string {
  return `created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`;
}

export async function learningPages<T extends LearningCursor>(
  read: (cursor: LearningCursor | null, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: LearningCursor | null = null;
  for (;;) {
    const page = await read(cursor, 500);
    rows.push(...page);
    if (page.length < 500) return rows;
    cursor = page[page.length - 1];
  }
}
