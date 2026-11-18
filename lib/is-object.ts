/** Whether a JSON value is an object (not null, not an array): a request
 *  body's nested field, checked before it's read. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
