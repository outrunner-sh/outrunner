import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { canSendEmail, emailStatus, sendEmail } from "@/lib/email/send";

const saved = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of [["RESEND_API_KEY", saved.key], ["EMAIL_FROM", saved.from]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("email is configured only with both RESEND_API_KEY and EMAIL_FROM", () => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  assert.equal(emailStatus(), "not_configured");
  process.env.RESEND_API_KEY = "re_test";
  assert.equal(emailStatus(), "not_configured");
  assert.equal(canSendEmail(), false);
  process.env.EMAIL_FROM = "Outrunner <hello@outrunner.sh>";
  assert.equal(emailStatus(), "configured");
  assert.equal(canSendEmail(), true);
});

test("sendEmail sends the HTML alongside the text, and only the text when there's none", async () => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "Outrunner <hello@outrunner.sh>";
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  assert.equal(await sendEmail({ to: ["a@b.co"], subject: "S", text: "T", html: "<p>T</p>" }), true);
  assert.equal(await sendEmail({ to: ["a@b.co"], subject: "S", text: "T" }), true);
  assert.deepEqual(bodies[0], { from: "Outrunner <hello@outrunner.sh>", to: ["a@b.co"], subject: "S", text: "T", html: "<p>T</p>" });
  assert.equal("html" in bodies[1], false);
});

test("/api/health reports email only in its bearer-token section", () => {
  const route = readFileSync(path.join(process.cwd(), "app/api/health/route.ts"), "utf8");
  // In `configured`, which only the full report (after the bearer check) carries.
  assert.match(route, /const configured = \{[\s\S]*?\n\s+email: emailStatus\(\),[\s\S]*?\n {2}\};/);
  // Anyone without the token gets `ok` and `build`, nothing else.
  const anonymous = route.match(/if \(!cronSecret \|\| !bearerMatches\([^\n]*\{\n([\s\S]*?)\n {2}\}/)?.[1] ?? "";
  assert.equal(anonymous.trim(), "return NextResponse.json({ ok, build }, { status: ok ? 200 : 503 });");
  const full = route.slice(route.indexOf("probeCodexSchema()"));
  assert.match(full, /\n\s+configured,\n/);
});
