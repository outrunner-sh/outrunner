import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesktopCodexHandler } from "@/lib/codex/desktop-handler";
import type { Owner } from "@/lib/auth/owner";

const owner: Owner = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Ada",
  email: null,
  githubLogin: "ada",
  githubId: null,
  avatarUrl: null,
};
const attempt = "22222222-2222-4222-8222-222222222222";
const grant = {
  purpose: "desktop-codex-connect" as const,
  user: owner.id,
  org: null,
  attempt,
  origin: "https://app.outrunner.sh",
  expires: Date.now() + 600000,
};

test("the desktop ticket cannot change actor, scope or attempt, or start/disconnect a connection", async () => {
  const seen: unknown[] = [];
  const handler = createDesktopCodexHandler({
    ticket: () => grant,
    owner: async (id) => (id === owner.id ? owner : null),
    sessionOwner: async () => owner.id,
    manage: async (_request, actor, org, body) => {
      seen.push({ actor: actor.id, org, body });
      return Response.json({ connected: true });
    },
  });
  const request = (method: string, data?: unknown) =>
    new Request("https://app.outrunner.sh/api/desktop/codex?org=other", {
      method,
      headers: { authorization: "Bearer synthetic-ticket" },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  assert.equal(
    (
      await handler(
        request("PUT", {
          attempt: "another-attempt",
          user: "another-user",
          org: "another-org",
          tokens: { synthetic: true },
        }),
      )
    ).status,
    200,
  );
  assert.deepEqual(seen[0], {
    actor: owner.id,
    org: null,
    body: { attempt, tokens: { synthetic: true } },
  });
  await handler(
    request("POST", { action: "begin", attempt: "another-attempt" }),
  );
  assert.deepEqual(seen[1], {
    actor: owner.id,
    org: null,
    body: { action: "cancel", attempt },
  });
  assert.equal((await handler(request("DELETE"))).status, 405);
  assert.equal(seen.length, 2);
});

test("canceled/replaced attempts and changed desktop accounts cannot keep polling", async () => {
  for (const pending of [
    null,
    { id: "other", mine: true },
    { id: attempt, mine: false },
  ]) {
    const handler = createDesktopCodexHandler({
      ticket: () => grant,
      owner: async () => owner,
      sessionOwner: async () => owner.id,
      manage: async () => Response.json({ pending }),
    });
    assert.equal(
      (
        await handler(
          new Request("https://app.outrunner.sh/api/desktop/codex", {
            headers: { authorization: "Bearer ticket" },
          }),
        )
      ).status,
      403,
    );
  }
  const handler = createDesktopCodexHandler({
    ticket: () => grant,
    owner: async () => owner,
    sessionOwner: async () => "another-account",
    manage: async () => {
      throw new Error("must not manage after account switch");
    },
  });
  assert.equal(
    (
      await handler(
        new Request("https://app.outrunner.sh/api/desktop/codex", {
          headers: {
            authorization: "Bearer ticket",
            cookie: "signed-in=changed",
          },
        }),
      )
    ).status,
    403,
  );
});
