import { z } from "zod";
import { open, seal } from "@/lib/crypto/secret-box";
import { memberRole } from "@/lib/db/orgs";
import { optionalEnv } from "@/lib/env";
import { readClaudeSlot, tokenRevision } from "@/lib/claude/store";
import {
  authorizeClaude,
  ClaudeAccessError,
  type ClaudeGrant,
  type ClaudeRef,
} from "@/lib/claude/access";

const refSchema = z.object({
  kind: z.enum(["personal", "org"]),
  id: z.uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
const schema = z.object({
  purpose: z.literal("claude-inference"),
  user: z.uuid(),
  org: z.uuid(),
  primary: refSchema,
  fallback: refSchema.optional(),
});
export function readClaudeGrant(bearer: string): ClaudeGrant {
  try {
    return schema.parse(JSON.parse(open(bearer)));
  } catch {
    throw new ClaudeAccessError();
  }
}
export async function authorizeClaudeGrant(grant: ClaudeGrant, ref: ClaudeRef) {
  return authorizeClaude(grant, ref, {
    member: memberRole,
    async read(r) {
      const row = await readClaudeSlot(r.kind, r.id);
      if (!row) return null;
      try {
        return {
          revision: tokenRevision(row.ciphertext),
          token: open(row.ciphertext),
        };
      } catch {
        return null;
      }
    },
  });
}

/** Cloud team sessions get a revocable broker grant. Provider tokens stay on
 * the server. Local sessions and personal-only sessions retain their login. */
export async function claudeAccountForSession(
  user: string,
  org: string,
): Promise<string | null> {
  if (!(await memberRole(org, user))) return null;
  const [savedOwn, savedShared] = await Promise.all([
    readClaudeSlot("personal", user),
    readClaudeSlot("org", org),
  ]);
  // A damaged or unreadable credential must not make a working org account
  // disappear from the model menu. Provider auth failures still fail closed.
  const usable = (row: typeof savedOwn) => {
    try {
      return row && open(row.ciphertext) ? row : null;
    } catch {
      return null;
    }
  };
  const own = usable(savedOwn);
  const shared = usable(savedShared);
  const ref = (
    kind: ClaudeRef["kind"],
    id: string,
    row: NonNullable<typeof own>,
  ): ClaudeRef => ({ kind, id, revision: tokenRevision(row.ciphertext) });
  if (!shared) return null;
  const grant: ClaudeGrant = {
    purpose: "claude-inference",
    user,
    org,
    primary: own ? ref("personal", user, own) : ref("org", org, shared),
    ...(own && shared ? { fallback: ref("org", org, shared) } : {}),
  };
  const origin = optionalEnv("RUNTIME_BASE_URL");
  if (!origin)
    throw new Error(
      "RUNTIME_BASE_URL is required for organization Claude sessions",
    );
  return Buffer.from(
    JSON.stringify({
      url: new URL("/api/runtime/claude", origin).toString(),
      bearer: seal(JSON.stringify(grant)),
    }),
  ).toString("base64url");
}
