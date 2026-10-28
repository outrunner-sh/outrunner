/**
 * A user who chose the Outrunner App to work on GitHub for them, with no way
 * to it for a repository (lib/github/identity.ts). Apart, so error responses
 * (lib/github/http.ts) can know it without the credential store.
 */

/** Why the App's token couldn't be had, and where that's put right. */
export type GitIdentityRefusal = "app_unconfigured" | "no_access" | "no_installation" | "suspended" | "unreachable";

export class GitIdentityError extends Error {
  readonly reason: GitIdentityRefusal;
  /** Where it's put right; null where the member can't (an admin can). */
  readonly href: string | null;

  constructor(reason: GitIdentityRefusal, message: string, href: string | null) {
    super(message);
    this.name = "GitIdentityError";
    this.reason = reason;
    this.href = href;
  }
}
