/** What lib/trackers/tokens.ts does its work with, on the server. */

import { setTimeout as sleep } from "node:timers/promises";

import { claimRefresh, disconnectIfUnchanged, loadTokenRow, releaseRefresh, storeRefreshedTokens } from "@/lib/db/trackers";
import { TrackerUnavailableError } from "@/lib/trackers/errors";
import { jiraConfig, refreshJiraToken } from "@/lib/trackers/jira";
import { linearConfig, refreshLinearToken } from "@/lib/trackers/linear";
import type { TokenDeps } from "@/lib/trackers/tokens";

export const tokenDeps: TokenDeps = {
  load: loadTokenRow,
  claim: claimRefresh,
  store: storeRefreshedTokens,
  release: releaseRefresh,
  disconnect: disconnectIfUnchanged,
  refresh: async (refreshToken, provider) => {
    if (provider === "jira") {
      const config = jiraConfig();
      if (!config) throw new TrackerUnavailableError("Jira isn't set up on this deployment.");
      return refreshJiraToken(config, refreshToken);
    }
    const config = linearConfig();
    if (!config) throw new TrackerUnavailableError("Linear isn't set up on this deployment.");
    return refreshLinearToken(config, refreshToken);
  },
  now: () => Date.now(),
  sleep: (ms) => sleep(ms).then(() => undefined),
};
