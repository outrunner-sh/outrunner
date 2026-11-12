import type { E2bTemplateState, StoredE2b } from "@/lib/db/credentials";
import { requireEnv } from "@/lib/env";
import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { SandboxSetupError } from "@/lib/runtime/sandbox-setup-error";
import { E2bBackend, type E2bConnection } from "@/lib/runtime/sandbox/e2b";
import { relayKey, USER_E2B_RELAY_PREFIX } from "@/lib/runtime/sandbox/relay-ticket";

/**
 * How long a box in a user's E2B runs before E2B pauses it on its own: an
 * hour, the longest every E2B plan allows (Hobby's limit), pushed back out
 * while the box is in use. Outrunner's own idle pause comes first anyway.
 */
export const USER_BOX_TIMEOUT_MS = 60 * 60 * 1000;

/** The key a user's own E2B is reached on is missing or unreadable. */
export class NoE2bKeyError extends SandboxSetupError {
  constructor() {
    super("Add your E2B API key in Settings → Sandbox to run sessions on your own E2B.");
    this.name = "NoE2bKeyError";
  }
}

/** Outrunner's box template isn't ready in the user's E2B, so no new box can
 *  be made there yet: what to do depends on where it is. */
export class E2bTemplateNotReadyError extends SandboxSetupError {
  constructor(state: Exclude<E2bTemplateState, "ready">, error: string | null = null) {
    super(
      state === "building"
        ? "Your E2B is still being set up: Outrunner's box template is building in your account, which takes a few minutes. Try again shortly."
        : state === "outdated"
          ? "Outrunner's tools were updated, so its box template is being rebuilt in your E2B. Try again in a few minutes."
          : state === "failed"
            ? `Outrunner's box template failed to build in your E2B${error ? ` (${error})` : ""}. Rebuild it in Settings → Sandbox.`
            : "Outrunner's box template isn't built in your E2B yet. Reconnect it in Settings → Sandbox.",
    );
    this.name = "E2bTemplateNotReadyError";
  }
}

/** How a user's E2B is reached: E2B's cloud (no URLs), routed by host, or
 *  their self-hosted E2B, routed by header with browsers through this
 *  server's user-E2B relay. Their network is theirs, so no guest MTU is set. */
export function userE2bConnection(stored: StoredE2b): E2bConnection {
  return {
    apiKey: stored.apiKey,
    apiUrl: stored.apiUrl ?? undefined,
    sandboxUrl: stored.sandboxUrl ?? undefined,
    guestMtu: null,
    timeoutMs: USER_BOX_TIMEOUT_MS,
    relay: { prefix: USER_E2B_RELAY_PREFIX, key: relayKey(requireEnv("CREDENTIALS_ENCRYPTION_KEY"), "user-e2b") },
  };
}

/** The template a new box in the user's E2B starts from: Outrunner's, built
 *  in their account. Throws until it's ready. */
export function userE2bTemplate(stored: StoredE2b): string {
  if (stored.template !== "ready" || !stored.templateId) {
    throw new E2bTemplateNotReadyError(stored.template === "ready" ? "none" : stored.template, stored.templateError);
  }
  return stored.templateId;
}

/** The Runtime Computer in a user's own E2B, on their key (Settings →
 *  Sandbox). `e2b` reads it when a box is first reached, once per provider;
 *  a self-hosted E2B's hosts are checked to be public then, as they were
 *  when saved, since a name can point anywhere later. Best effort for the
 *  calls made from here (the SDK's, control calls, previews): each resolves
 *  the name again as it connects, so DNS that answers public for the check
 *  and private after (rebinding) gets past it. The browser relay, a long-
 *  lived connection, resolves public-only as it connects (server.ts). */
export class UserE2bRuntimeProvider extends ComputerRuntimeProvider {
  constructor(e2b: () => Promise<StoredE2b | null>) {
    let read: Promise<StoredE2b> | null = null;
    const stored = (): Promise<StoredE2b> => {
      read ??= e2b().then(async (found) => {
        if (!found) throw new NoE2bKeyError();
        const { assertPublicHost } = await import("@/lib/runtime/user-e2b-checks");
        await Promise.all([found.apiUrl, found.sandboxUrl].filter((url): url is string => !!url).map(assertPublicHost));
        return found;
      });
      // A read that failed is tried again next time.
      read.catch(() => {
        read = null;
      });
      return read;
    };
    super(
      "user-e2b",
      new E2bBackend({
        connection: async () => userE2bConnection(await stored()),
        template: async () => userE2bTemplate(await stored()),
      }),
    );
  }
}
