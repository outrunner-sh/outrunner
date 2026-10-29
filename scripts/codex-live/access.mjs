/** Issue a fresh, single-use launcher link; invalidate old launcher sessions. */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { root } from "./env.mjs";
const token = randomBytes(32).toString("base64url");
const ticket = {
  hash: createHash("sha256").update(token).digest("hex"),
  session: randomBytes(32).toString("base64url"),
  expires: Date.now() + 24 * 60 * 60_000,
};
writeFileSync(root + "/access.json", JSON.stringify(ticket), { mode: 0o600 });
const { origin } = JSON.parse(readFileSync(root + "/preview.json", "utf8"));
// Test-only bootstrap secret stays in a private handoff file, never logs/PRs.
writeFileSync(
  root + "/owner-link.txt",
  origin + "/__test#access=" + token + "\n",
  { mode: 0o600 },
);
console.log(
  "Fresh single-use owner link saved privately to " +
    root +
    "/owner-link.txt (valid 24h). Previous launcher sessions are invalid.",
);
