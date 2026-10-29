import assert from "node:assert/strict";
import { test } from "node:test";

import { PROVIDER_IDS } from "@/lib/providers/registry";
import {
  GATEWAY_TABS,
  isProviderTab,
  parseProviderPlace,
  PROVIDER_TABS,
  providerSettingsHref,
  withProviderTab,
  withProviderMethod,
  legacyProviderSettingsHref,
} from "@/lib/settings-links";

test("Personal → Coding agents has the agents first, then every provider whose key is no agent's", () => {
  assert.deepEqual(
    GATEWAY_TABS,
    PROVIDER_IDS.filter((id) => id !== "anthropic"),
  );
  assert.deepEqual(PROVIDER_TABS, ["claude", "codex", ...GATEWAY_TABS]);
});

test("?tab= opens only a tab there is", () => {
  for (const tab of PROVIDER_TABS) assert.equal(isProviderTab(tab), true);
  // Junk in the address bar, a repeated param, or none: the page picks a tab itself.
  for (const junk of [
    "",
    "Claude",
    "toString",
    "__proto__",
    ["claude"],
    undefined,
  ]) {
    assert.equal(isProviderTab(junk), false, String(junk));
    assert.equal(parseProviderPlace(junk), null, String(junk));
  }
});

test("a link to a tab opens that tab, and an agent's key opens that agent's API key", () => {
  assert.equal(
    providerSettingsHref("claude"),
    "/settings/coding-agents?tab=claude",
  );
  assert.equal(providerSettingsHref("zai"), "/settings/coding-agents?tab=zai");
  assert.equal(
    providerSettingsHref("anthropic"),
    "/settings/coding-agents?tab=claude&method=api-key",
  );
  assert.equal(
    providerSettingsHref("openai"),
    "/settings/coding-agents?tab=codex&method=api-key",
  );
  assert.equal(
    providerSettingsHref("codex", "chatgpt"),
    "/settings/coding-agents?tab=codex&method=chatgpt",
  );
  // A method is an agent's only.
  assert.equal(
    providerSettingsHref("zai", "api-key"),
    "/settings/coding-agents?tab=zai",
  );
});

test("a link from before agents had tabs still lands where its key now is", () => {
  assert.deepEqual(parseProviderPlace("anthropic"), {
    tab: "claude",
    method: "api-key",
  });
  assert.deepEqual(parseProviderPlace("openai"), {
    tab: "codex",
    method: "api-key",
  });
  assert.deepEqual(parseProviderPlace("claude"), { tab: "claude" });
});

test("?method= counts only on an agent's tab, and only for a way it has", () => {
  assert.deepEqual(parseProviderPlace("codex", "chatgpt"), {
    tab: "codex",
    method: "chatgpt",
  });
  assert.deepEqual(parseProviderPlace("claude", "chatgpt"), { tab: "claude" });
  assert.deepEqual(parseProviderPlace("openrouter", "api-key"), {
    tab: "openrouter",
  });
  assert.deepEqual(parseProviderPlace("claude", ["local"]), { tab: "claude" });
});

test("moving between tabs keeps the rest of the address and drops a link's method", () => {
  const url = new URL(
    "https://app.test/settings/providers?tab=claude&method=api-key&from=onboarding#keys",
  );
  assert.equal(
    withProviderTab(url, "codex"),
    "/settings/providers?tab=codex&from=onboarding#keys",
  );
  assert.equal(
    withProviderTab(new URL("https://app.test/settings/providers"), "claude"),
    "/settings/providers?tab=claude",
  );
  assert.equal(url.search, "?tab=claude&method=api-key&from=onboarding");
});

test("old Codex account links keep #328's active team scope; key/local/other-agent links stay personal", () => {
  const team = { personal: false };
  assert.equal(
    legacyProviderSettingsHref({ tab: "codex", from: "callback" }, team),
    "/settings/org/coding-agents?tab=codex&from=callback",
  );
  assert.equal(
    legacyProviderSettingsHref(
      { tab: "codex", method: "codex-account", from: ["one", "two"] },
      team,
    ),
    "/settings/org/coding-agents?tab=codex&method=codex-account&from=one&from=two",
  );
  for (const method of ["api-key", "chatgpt", "local"])
    assert.equal(
      legacyProviderSettingsHref({ tab: "codex", method }, team),
      `/settings/coding-agents?tab=codex&method=${method}`,
    );
  assert.equal(
    legacyProviderSettingsHref({ tab: "openai" }, team),
    "/settings/coding-agents?tab=openai",
  );
  assert.equal(
    legacyProviderSettingsHref({ tab: "claude", method: "subscription" }, team),
    "/settings/coding-agents?tab=claude&method=subscription",
  );
  for (const org of [null, undefined, { personal: true }])
    assert.equal(
      legacyProviderSettingsHref({ tab: "codex" }, org),
      "/settings/coding-agents?tab=codex",
    );
});

test("org Codex authentication cards retain query and hash context without changing personal choices", () => {
  const url = new URL(
    "https://app.test/settings/org/coding-agents?tab=claude&from=callback#auth",
  );
  assert.equal(
    withProviderMethod(url, "codex", "codex-account"),
    "/settings/org/coding-agents?tab=codex&from=callback&method=codex-account#auth",
  );
  assert.equal(
    withProviderMethod(url, "codex", "api-key"),
    "/settings/org/coding-agents?tab=codex&from=callback&method=api-key#auth",
  );
  assert.equal(url.searchParams.get("tab"), "claude");
});
