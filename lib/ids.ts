const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` can be a row id. Checked before an id from a URL reaches a
 * uuid-typed column: Postgres rejects anything else with an error (22P02),
 * which would surface as a 500 rather than "not found".
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
