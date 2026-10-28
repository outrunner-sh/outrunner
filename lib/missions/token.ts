/**
 * The token a Mission's agent calls its tools with (app/api/missions/mcp):
 * minted each time the Mission's box is set up, written into that box's MCP
 * config, and kept here only as its sha256 (mission_tokens), one a Mission.
 * It names the Mission and nothing else, so its tools reach only that
 * Mission's Runners and notes.
 */

import { createHash, randomBytes } from "node:crypto";

/** Where the hashes are kept; the database's in mission-store.ts. */
export type MissionTokenStore = {
  /** Replace the Mission's token with this one. */
  save(missionId: string, tokenHash: string): Promise<void>;
  /** The Mission a token's hash belongs to, or null. */
  find(tokenHash: string): Promise<string | null>;
};

const PREFIX = "orm_";

export function hashMissionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A new token for the Mission; the one it had stops working. */
export async function mintMissionToken(missionId: string, store: MissionTokenStore): Promise<string> {
  const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  await store.save(missionId, hashMissionToken(token));
  return token;
}

/** The Mission a presented token is for, or null for one that isn't any's. */
export async function missionForToken(token: string | null | undefined, store: MissionTokenStore): Promise<string | null> {
  if (!token || !token.startsWith(PREFIX) || token.length > 200) return null;
  return store.find(hashMissionToken(token));
}
