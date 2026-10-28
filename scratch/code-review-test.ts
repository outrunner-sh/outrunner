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
