import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  captureFromCommand,
  captureFromMessage,
  isSlackResponseUrl,
  type MessageAction,
  parseTriageCommand,
  signLinkToken,
  slackPermalink,
  slackToMarkdown,
  verifyLinkToken,
  verifySlackSignature,
} from "@/lib/slack/slack";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";

function sign(body: string, timestamp: string) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

test("only a request signed with the app's secret, and recent, is Slack's", () => {
  const body = "command=%2Ftriage&text=hi";
  const ts = "1700000000";
  const ok = { secret, timestamp: ts, signature: sign(body, ts), body, nowSeconds: 1700000010 };
  assert.equal(verifySlackSignature(ok), true);
  assert.equal(verifySlackSignature({ ...ok, body: `${body}x` }), false);
  assert.equal(verifySlackSignature({ ...ok, secret: "other" }), false);
  assert.equal(verifySlackSignature({ ...ok, nowSeconds: 1700000000 + 301 }), false);
  assert.equal(verifySlackSignature({ ...ok, signature: null }), false);
  assert.equal(verifySlackSignature({ ...ok, timestamp: "abc" }), false);
});

test("a link token names its Slack user until it expires, and can't be altered", () => {
  const identity = { teamId: "T123", teamName: "acme", userId: "U456", userName: "ana" };
  const token = signLinkToken(identity, secret, 1000);
  assert.deepEqual(verifyLinkToken(token, secret, 2000), identity);
  assert.equal(verifyLinkToken(token, secret, 1000 + 10 * 60 * 1000 + 1), null);
  assert.equal(verifyLinkToken(token, "other", 2000), null);
  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ t: "T123", u: "UEVIL", exp: 9e15 })).toString("base64url");
  assert.equal(verifyLinkToken(`${forged}.${signature}`, secret, 2000), null);
  assert.equal(verifyLinkToken(`${payload}.${signature}.x`, secret, 2000), null);
  assert.equal(verifyLinkToken("garbage", secret, 2000), null);
});

test("Slack markup becomes Markdown, code left alone", () => {
  assert.equal(
    slackToMarkdown("*Login* is ~fine~ broken, see <https://ci.dev/1|run 1> cc <@U1|ana> in <#C1|eng> &amp; `<keep *this*>`"),
    "**Login** is ~~fine~~ broken, see [run 1](https://ci.dev/1) cc @ana in #eng & `<keep *this*>`",
  );
  assert.equal(slackToMarkdown("<!here> <https://x.dev>"), "@here https://x.dev");
});

test("a permalink is built from the payload, with its thread", () => {
  assert.equal(
    slackPermalink({ teamDomain: "acme", channelId: "C1", ts: "1712.000300" }),
    "https://acme.slack.com/archives/C1/p1712000300",
  );
  assert.equal(
    slackPermalink({ teamDomain: "acme", channelId: "C1", ts: "1712.000300", threadTs: "1711.000100" }),
    "https://acme.slack.com/archives/C1/p1712000300?thread_ts=1711.000100&cid=C1",
  );
  assert.equal(slackPermalink({ teamDomain: "evil.com/x", channelId: "C1", ts: "1.2" }), null);
});

const action = (over: Partial<MessageAction["message"]> = {}): MessageAction => ({
  team: { id: "T1", domain: "acme" },
  user: { id: "U9", username: "immad" },
  channel: { id: "C1", name: "eng" },
  message: { ts: "1712.000300", text: "*Login* flaky on Safari\nseen 3x", user: "U2", user_profile: { display_name: "ana" }, ...over },
  response_url: "https://hooks.slack.com/actions/T1/1/x",
});

test("a message becomes an item; messages in one thread share its ref", () => {
  const capture = captureFromMessage(action());
  assert.equal(capture.title, "Login flaky on Safari");
  assert.match(capture.body, /^\*\*Login\*\* flaky on Safari\nseen 3x\n\n— ana in #eng · \[View in Slack\]\(https:\/\/acme\.slack\.com/);
  assert.equal(capture.sourceRef, "slack:T1/C1/1712.000300");
  const reply = captureFromMessage(action({ ts: "1713.000100", thread_ts: "1712.000300" }));
  assert.equal(reply.sourceRef, capture.sourceRef);
  assert.equal(reply.author, "ana (#eng)");
});

test("/triage takes an owner/repo first word as the workspace", () => {
  assert.equal(parseTriageCommand("  "), null);
  assert.deepEqual(parseTriageCommand("acme/web fix the login"), { project: "acme/web", text: "fix the login" });
  assert.deepEqual(parseTriageCommand("fix the login"), { project: null, text: "fix the login" });
  assert.deepEqual(parseTriageCommand("acme/web"), { project: null, text: "acme/web" });
  const capture = captureFromCommand("fix the login", { channelName: "eng", userName: "ana" });
  assert.deepEqual([capture.title, capture.body, capture.author], ["fix the login", "", "@ana (#eng)"]);
});

test("replies go only to Slack's own hosts", () => {
  assert.equal(isSlackResponseUrl("https://hooks.slack.com/commands/T1/1/x"), true);
  assert.equal(isSlackResponseUrl("https://evil.com/hooks.slack.com"), false);
  assert.equal(isSlackResponseUrl("http://hooks.slack.com/x"), false);
  assert.equal(isSlackResponseUrl(null), false);
});
