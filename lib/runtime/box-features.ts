/**
 * Making sure a box's agent can do something newer agents can (GET /health's
 * `features`), upgrading it in place first where its provider can — the way
 * session-auth makes sure it runs a session's agent.
 */

import { OutdatedComputerError } from "@/lib/runtime/session-auth";

/** The parts of the agent's client this needs, so it tests with a stand-in. */
export type FeatureClient = {
  /** What the agent says it can do; [] from one older than the list. */
  features(): Promise<string[]>;
  /** Bring the box's agent up to this release's, in place; absent where the
   *  provider can't. */
  upgrade?(): Promise<void>;
};

/** Throws an {@link OutdatedComputerError} saying the box can't `what`, when
 *  its agent lacks `feature` even after an upgrade. */
export async function requireFeature(client: FeatureClient, feature: string, what: string): Promise<void> {
  if ((await client.features()).includes(feature)) return;
  if (client.upgrade) {
    await client.upgrade();
    if ((await client.features()).includes(feature)) return;
  }
  throw new OutdatedComputerError(`This project's cloud computer can't ${what}.`);
}

/** A setup's capabilities stay fixed until an agent upgrade. Reuse one
 * health answer within that setup, never across sessions or upgrades. */
export function cachedFeatures(client: FeatureClient): FeatureClient {
  let snapshot: Promise<string[]> | undefined;
  return {
    features: () => snapshot ??= client.features(),
    ...(client.upgrade && { upgrade: async () => {
      try { await client.upgrade!(); }
      finally { snapshot = undefined; }
    } }),
  };
}
