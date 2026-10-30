/**
 * The GitHub-recognized identity used to credit the person prompting an
 * Outrunner session when the App pushes and opens its pull request.
 *
 * GitHub's numeric-id noreply address survives login renames and does not
 * expose the user's private email. Both values come from Supabase's
 * server-maintained GitHub identity, never writable user metadata.
 */
export function githubCoAuthor(user: {
  githubId: number | null;
  githubLogin: string;
  name: string;
}): string | null {
  const login = user.githubLogin.trim();
  if (!user.githubId || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return null;

  // A display name lives inside a commit trailer. Keep it to one line and
  // outside angle brackets so it cannot forge another trailer or its email.
  const name = user.name.replace(/[\r\n<>]+/g, " ").replace(/\s+/g, " ").trim() || login;
  return `${name} <${user.githubId}+${login}@users.noreply.github.com>`;
}
