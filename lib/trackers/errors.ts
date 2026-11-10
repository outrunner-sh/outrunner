/** What any tracker's token and API calls can come to. */

export type TrackerTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  refreshExpiresAt: Date | null;
};

/** The tracker refused a refresh: the grant is gone for good. */
export class TrackerRevokedError extends Error {}
/** The tracker answered a call with 401. Not the same thing: the token may have just
 *  been rotated. lib/trackers/tokens.ts finds out which. */
export class TrackerUnauthorizedError extends Error {}
/** The tracker didn't answer as it should: worth retrying. */
export class TrackerUnavailableError extends Error {}
/** The tracker answered, and won't ever take this: the session or issue is gone, or out of
 *  reach. Retrying only keeps asking. */
export class TrackerRefusedError extends Error {}
