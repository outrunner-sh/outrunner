import assert from "node:assert/strict";
import { test } from "node:test";

import { namePreviewHost, PREVIEW_HOST_HEADER, PREVIEW_HOST_SIGNATURE_HEADER } from "../cloudflare/preview-host.ts";
import {
  previewCookieName,
  previewDomainOf,
  previewOrigin,
  safeReturnPath,
  slugFromHost,
  type PreviewDomain,
} from "@/lib/previews/host";
import { edgeHostSignature, edgeHostSigned } from "@/lib/previews/tokens";

const APP = "https://app.outrunner.sh";
const SLUG = "abcdefghij0123456789";
const OTHER_SLUG = "zyxwvutsrq9876543210";
const DOMAIN: PreviewDomain = { host: "outrunner-preview.com", secure: true };

test("previews are off without a domain, or with one that isn't", () => {
  assert.equal(previewDomainOf({ RUNTIME_BASE_URL: APP }).ok, false);
  assert.equal(previewDomainOf({ RUNTIME_BASE_URL: APP, RUNTIME_PREVIEW_DOMAIN: "not a domain" }).ok, false);
  assert.equal(previewDomainOf({ RUNTIME_PREVIEW_DOMAIN: "outrunner-preview.com" }).ok, false, "no app to sign in at");
});

test("a preview domain on the app's own site is refused", () => {
  // The app's host itself, a subdomain of it, and a sibling under its site:
  // each could set cookies the app reads, or ride its SameSite ones.
  for (const domain of ["app.outrunner.sh", "preview.app.outrunner.sh", "preview.outrunner.sh", "outrunner.sh"]) {
    const found = previewDomainOf({ RUNTIME_BASE_URL: APP, RUNTIME_PREVIEW_DOMAIN: domain });
    assert.equal(found.ok, false, domain);
  }
});

test("a domain of its own is served, as https, written any reasonable way", () => {
  for (const written of ["outrunner-preview.com", "*.outrunner-preview.com", ".Outrunner-Preview.com."]) {
    const found = previewDomainOf({ RUNTIME_BASE_URL: APP, RUNTIME_PREVIEW_DOMAIN: written });
    assert.deepEqual(found, { ok: true, domain: DOMAIN }, written);
  }
});

test("development serves previews on localhost, over http", () => {
  const found = previewDomainOf({ RUNTIME_BASE_URL: "http://localhost:3000", RUNTIME_PREVIEW_DOMAIN: "localhost:3000" });
  assert.deepEqual(found, { ok: true, domain: { host: "localhost:3000", secure: false } });
  if (!found.ok) return;
  assert.equal(previewOrigin(SLUG, found.domain), `http://${SLUG}.localhost:3000`);
  assert.equal(previewCookieName(found.domain), "outrunner-preview");
  assert.equal(slugFromHost(`${SLUG}.localhost:3000`, found.domain), SLUG);
  assert.equal(slugFromHost(`${SLUG}.localhost:4000`, found.domain), null);
});

test("a host is a preview's only as exactly one slug before the domain", () => {
  assert.equal(slugFromHost(`${SLUG}.outrunner-preview.com`, DOMAIN), SLUG);
  assert.equal(slugFromHost(`${SLUG.toUpperCase()}.Outrunner-Preview.com.`, DOMAIN), SLUG);
  assert.equal(slugFromHost(`${SLUG}.outrunner-preview.com:443`, DOMAIN), SLUG);
  for (const host of [
    "outrunner-preview.com",
    "app.outrunner.sh",
    `x.${SLUG}.outrunner-preview.com`,
    `${SLUG}.outrunner-preview.com.evil.com`,
    `${SLUG}evil-outrunner-preview.com`,
    `short.outrunner-preview.com`,
    `${SLUG}.outrunner-preview.com:8443`,
    "",
  ]) {
    assert.equal(slugFromHost(host, DOMAIN), null, host);
  }
  assert.equal(slugFromHost(undefined, DOMAIN), null);
});

test("the session cookie is a __Host- cookie on https", () => {
  assert.equal(previewCookieName(DOMAIN), "__Host-outrunner-preview");
  assert.equal(previewOrigin(SLUG, DOMAIN), `https://${SLUG}.outrunner-preview.com`);
});

test("a visitor is only ever sent back to a path on the preview itself", () => {
  assert.equal(safeReturnPath("/callback?code=1&state=2"), "/callback?code=1&state=2");
  for (const bad of [null, "", "https://evil.com/", "//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "/a\\b", "evil", "/__outrunner/wake"]) {
    assert.equal(safeReturnPath(bad), "/", String(bad));
  }
});

test("the Worker names a preview's host to the container, signed as the server checks it, and no one else can", async () => {
  const KEY = "worker-credentials-key";
  const host = `${SLUG}.outrunner-preview.com`;
  const preview = await namePreviewHost(new Request(`https://${host}/x`), "outrunner-preview.com", KEY);
  assert.equal(preview.headers.get(PREVIEW_HOST_HEADER), host);
  const signature = preview.headers.get(PREVIEW_HOST_SIGNATURE_HEADER) ?? undefined;
  // The Worker (Web Crypto) and the server (node:crypto) sign alike.
  assert.equal(signature, edgeHostSignature(KEY, host));
  assert.equal(edgeHostSigned(KEY, host, signature), true);
  assert.equal(edgeHostSigned(KEY, `${OTHER_SLUG}.outrunner-preview.com`, signature), false, "not for another host");
  assert.equal(edgeHostSigned("another-key", host, signature), false);
  assert.equal(edgeHostSigned(KEY, host, undefined), false);

  const spoofed = new Request("https://app.outrunner.sh/api/x", {
    headers: { [PREVIEW_HOST_HEADER]: host, [PREVIEW_HOST_SIGNATURE_HEADER]: signature ?? "" },
  });
  for (const passed of [await namePreviewHost(spoofed, "outrunner-preview.com", KEY), await namePreviewHost(spoofed, undefined, KEY)]) {
    assert.equal(passed.headers.has(PREVIEW_HOST_HEADER), false);
    assert.equal(passed.headers.has(PREVIEW_HOST_SIGNATURE_HEADER), false);
  }
  // Without the key it names nothing: the proxy goes by the Host.
  const unkeyed = await namePreviewHost(new Request(`https://${host}/x`), "outrunner-preview.com", undefined);
  assert.equal(unkeyed.headers.has(PREVIEW_HOST_HEADER), false);

  const app = new Request("https://app.outrunner.sh/");
  assert.equal(await namePreviewHost(app, "outrunner-preview.com", KEY), app, "the app's requests pass as they are");
});
