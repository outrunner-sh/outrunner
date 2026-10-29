/** Claim a queued action synchronously so drains and double clicks cannot race it. */
export async function runQueuedAction<T>(gate: { current: boolean }, steps: {
  take(): T | null;
  interrupt(): Promise<void>;
  send(prompt: T): Promise<unknown>;
  restore(prompt: T): void;
  settled(): void;
}): Promise<void> {
  if (gate.current) return;
  gate.current = true;
  let prompt: T | null = null;
  try {
    prompt = steps.take();
    if (prompt === null) return;
    await steps.interrupt();
    await steps.send(prompt);
  } catch (error) {
    if (prompt !== null) steps.restore(prompt);
    throw error;
  } finally {
    gate.current = false;
    steps.settled();
  }
}
