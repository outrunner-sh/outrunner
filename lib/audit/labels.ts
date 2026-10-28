/** How the audit log names a person it records something about: their
 *  login, else their name or email, as they were at the time. */

import { people } from "@/lib/db/org-members";

export async function personLabel(userId: string): Promise<string> {
  const person = (await people([userId]).catch(() => new Map())).get(userId);
  return person?.login || person?.name || person?.email || userId;
}
