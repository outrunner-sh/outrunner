import { expect, test } from "@playwright/test";

test("admins connect and disconnect Claude at org scope without changing personal credentials", async ({
  page,
}) => {
  let connected = false;
  const changes: string[] = [];
  await page.route("**/api/**", async (route) => {
    const r = route.request();
    if (r.url().includes("/api/settings/claude"))
      throw new Error("Org settings must never save a personal token");
    if (r.url().includes("/api/orgs/org-1/claude")) {
      if (r.method() === "PUT") {
        expect(r.postDataJSON()).toEqual({
          token: "sk-ant-oat01-synthetic-org-token-1234",
        });
        connected = true;
        changes.push("PUT");
      }
      if (r.method() === "DELETE") {
        connected = false;
        changes.push("DELETE");
      }
      return route.fulfill({
        json: {
          connected,
          last4: connected ? "1234" : null,
          updatedAt: connected ? "2026-11-13T00:00:00Z" : null,
        },
      });
    }
    if (r.url().includes("scopes=1"))
      return route.fulfill({
        json: {
          user: "alice",
          orgs: [
            { id: "org-1", name: "neev ai", joinedAt: "2026-10-01T00:00:00Z", role: "admin" },
          ],
          activeOrg: "org-1",
        },
      });
    if (r.url().includes("/api/settings/codex"))
      return route.fulfill({
        json: {
          connected: true,
          reconnect: false,
          pending: null,
          updatedAt: null,
        },
      });
    return route.fulfill({
      json: {
        missions: [],
        notifications: [],
        standings: {},
        ids: [],
        allowance: null,
      },
    });
  });
  await page.goto("/settings/org/coding-agents?view=agent-keys");
  await expect(
    page.getByText("claude setup-token", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByPlaceholder("Paste the token from claude setup-token")
    .fill("sk-ant-oat01-synthetic-org-token-1234");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("····1234")).toBeVisible();
  await expect(page.getByText("The organization’s Claude plan")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    page.getByPlaceholder("Paste the token from claude setup-token"),
  ).toBeVisible();
  expect(changes).toEqual(["PUT", "DELETE"]);
  await page.getByRole("tab", { name: "Codex", exact: false }).click();
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("tab")).toBe("codex");
});

test("members see organization status but cannot connect or disconnect Claude", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => {
    if (route.request().url().includes("scopes=1"))
      return route.fulfill({
        json: {
          user: "alice",
          orgs: [
            { id: "org-1", name: "outrunner", joinedAt: "2026-10-01T00:00:00Z", role: "member" },
          ],
          activeOrg: "org-1",
        },
      });
    if (route.request().url().includes("/api/settings/codex"))
      return route.fulfill({
        json: {
          connected: false,
          reconnect: false,
          pending: null,
          updatedAt: null,
        },
      });
    return route.fulfill({
      json: {
        missions: [],
        notifications: [],
        standings: {},
        ids: [],
        allowance: null,
      },
    });
  });
  await page.goto("/settings/org/coding-agents?view=agent-keys&state=member");
  await expect(
    page
      .getByText("Only organization admins can change shared credentials.")
      .first(),
  ).toBeVisible();
  await expect(
    page.getByPlaceholder("Paste the token from claude setup-token"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true }),
  ).toHaveCount(0);
});
