import assert from "node:assert/strict";
import { test } from "node:test";

import { PROVIDER_IDS } from "@/lib/providers/registry";
import { isProviderTab, PROVIDER_TABS, providerSettingsHref } from "@/lib/settings-links";

test("Settings → Providers has Claude first, then every provider", () => {
  assert.deepEqual(PROVIDER_TABS, ["claude", ...PROVIDER_IDS]);
});

test("?tab= opens only a tab there is", () => {
  for (const tab of PROVIDER_TABS) assert.equal(isProviderTab(tab), true);
  // Junk in the address bar, a repeated param, or none: the page picks a tab itself.
  for (const junk of ["", "Claude", "toString", "__proto__", ["claude"], undefined]) {
    assert.equal(isProviderTab(junk), false, String(junk));
  }
});

test("a link to a tab opens that tab", () => {
  assert.equal(providerSettingsHref("claude"), "/settings/providers?tab=claude");
  assert.equal(providerSettingsHref("zai"), "/settings/providers?tab=zai");
});
