import assert from "node:assert/strict";
import { test } from "node:test";

import { emailHtml, escapeHtml } from "@/lib/email/html";
import { inviteMessage, joinRequestMessage } from "@/lib/orgs/emails";

test("escapeHtml makes markup and quotes text", () => {
  assert.equal(escapeHtml(`<b class="x">Tom & 'Jerry'</b>`), "&lt;b class=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/b&gt;");
});

test("the layout: a document with the wordmark as text, inline styles, no remote images or stylesheets", () => {
  const html = emailHtml({
    preheader: "Hello",
    heading: "Join Acme",
    body: ["One.", "Two."],
    action: { label: "Accept invite", url: "https://app.outrunner.sh/invite/or_inv_abc" },
    footer: ["Small print."],
  });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, />Outrunner<\/td>/);
  assert.doesNotMatch(html, /<img|<link|<style|<script/i);
  assert.match(html, /<a href="https:\/\/app\.outrunner\.sh\/invite\/or_inv_abc" target="_blank" style="[^"]+">Accept invite<\/a>/);
  // Outlook's VML button opens the same link.
  assert.match(html, /<v:roundrect[^>]+href="https:\/\/app\.outrunner\.sh\/invite\/or_inv_abc"/);
  for (const text of ["Hello", "Join Acme", "One.", "Two.", "Small print."]) assert.ok(html.includes(text), text);
  assert.match(html, /color:#18181b/);
  assert.match(html, /background-color:#ffffff/);
});

test("no button for a link that isn't an absolute http(s) URL", () => {
  for (const url of ["javascript:alert(1)", "/settings/org/members", "data:text/html,hi"]) {
    const html = emailHtml({ heading: "H", body: ["B"], action: { label: "Go", url } });
    assert.doesNotMatch(html, /<a |roundrect/, url);
    assert.ok(!html.includes(url), url);
  }
});

test("the invite escapes its org's and inviter's names, in HTML and nowhere else", () => {
  const message = inviteMessage({
    orgName: `<script>alert("x")</script>`,
    inviter: `Eve & "friends"`,
    link: `https://app.outrunner.sh/invite/or_inv_a"b`,
    days: 7,
  });
  assert.doesNotMatch(message.html, /<script>/);
  assert.ok(message.html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(message.html.includes("Eve &amp; &quot;friends&quot;"));
  // A quote in the link can't end the href.
  assert.doesNotMatch(message.html, /href="[^"]*"b/);
  // The plain text is the fallback, as written.
  assert.ok(message.text.includes(`Eve & "friends" invited you to join <script>alert("x")</script> on Outrunner.`));
  assert.ok(message.text.includes("https://app.outrunner.sh/invite/or_inv_a\"b"));
  assert.match(message.text, /works for 7 days/);
  assert.equal(message.subject, `Eve & "friends" invited you to <script>alert("x")</script> on Outrunner`);
  assert.match(message.html, />Accept invite<\/a>/);
});

test("the request to join escapes the asker's email and links to the members page", () => {
  const message = joinRequestMessage({
    orgName: "Acme",
    domain: "acme.dev",
    email: `x<img src=y>@acme.dev`,
    link: "https://app.outrunner.sh/settings/org/members",
  });
  assert.doesNotMatch(message.html, /<img/);
  assert.ok(message.html.includes("x&lt;img src=y&gt;@acme.dev"));
  assert.match(message.html, /href="https:\/\/app\.outrunner\.sh\/settings\/org\/members"[^>]*>Review request<\/a>/);
  assert.match(message.text, /Approve or decline it under Settings → Org → Members: https:\/\/app\.outrunner\.sh\/settings\/org\/members/);
});
