/** Chat lifecycle steps with explicit recovery and selection boundaries. */
export async function startChatOnBox(steps: {
  ready(recreated: boolean): Promise<void>;
  start(): Promise<unknown>;
  recreate(): Promise<void>;
  missing(error: unknown): boolean;
}): Promise<void> {
  try {
    await steps.ready(false);
    await steps.start();
  } catch (error) {
    if (!steps.missing(error)) throw error;
    await steps.recreate();
    await steps.ready(true);
    await steps.start();
  }
}

/** Keep the source composer mounted until the question has been accepted. */
export async function askSideChat<T>(steps: {
  create(): Promise<T>;
  send(chat: T): Promise<boolean>;
  remove(chat: T): Promise<void>;
  pick(chat: T): void;
}): Promise<boolean> {
  const chat = await steps.create();
  let sent = false;
  try {
    sent = await steps.send(chat);
    if (sent) steps.pick(chat);
    return sent;
  } finally {
    if (!sent) await steps.remove(chat).catch((error: unknown) => console.warn("Couldn't remove an empty side chat", error));
  }
}

/** A missing source must not prevent reopening a chat on a replacement box. */
export async function createChatWithSourceFallback(
  create: (withSource: boolean) => Promise<unknown>,
  hasSource: boolean,
  missing: (error: unknown) => boolean,
): Promise<void> {
  try { await create(hasSource); }
  catch (error) {
    if (!hasSource || !missing(error)) throw error;
    await create(false);
  }
}
