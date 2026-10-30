import assert from "node:assert/strict";
import { test } from "node:test";
import {
  desktopCodexTicket,
  readDesktopCodexTicket,
} from "@/lib/codex/desktop-ticket";
import { seal } from "@/lib/crypto/secret-box";

test("desktop connection tickets are bound to an account, attempt, scope and deployment, and expire", (t) => {
  const before = process.env.CREDENTIALS_ENCRYPTION_KEY;
  process.env.CREDENTIALS_ENCRYPTION_KEY = "ab".repeat(32);
  t.after(() => {
    if (before === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = before;
  });
  const claims = {
    user: "11111111-1111-4111-8111-111111111111",
    org: null,
    attempt: "22222222-2222-4222-8222-222222222222",
    origin: "https://app.outrunner.sh",
  };
  const encoded = desktopCodexTicket(claims);
  const read = readDesktopCodexTicket(encoded, claims.origin);
  assert.equal(read.user, claims.user);
  assert.equal(read.attempt, claims.attempt);
  assert.equal(read.org, null);
  assert.throws(() =>
    readDesktopCodexTicket(encoded, "https://another-deployment.test"),
  );
  assert.throws(() =>
    readDesktopCodexTicket(encoded, claims.origin, read.expires),
  );
  const parts = encoded.split(".");
  parts[3] = `${parts[3][0] === "a" ? "b" : "a"}${parts[3].slice(1)}`;
  assert.throws(() => readDesktopCodexTicket(parts.join("."), claims.origin));
  assert.throws(() =>
    readDesktopCodexTicket(
      seal(JSON.stringify({ ...read, purpose: "codex-inference" })),
      claims.origin,
    ),
  );
});
