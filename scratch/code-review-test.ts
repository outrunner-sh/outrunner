// Throwaway file for testing the Code Review automation (PR not to be merged).

/** The average of some numbers. */
export function average(values: number[]): number {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total / values.length;
}

/** Whether a user id looks valid. */
export function isUserId(value: any) {
  return value.length == 36;
}

/** The largest of some numbers. */
export function largest(values: number[]) {
  let best = 0;
  for (const value of values) if (value > best) best = value;
  return best;
}

/** The smallest of some numbers. */
export function smallest(values: number[]) {
  return values.sort()[0];
}
