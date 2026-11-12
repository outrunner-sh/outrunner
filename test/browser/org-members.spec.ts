import { expect, test, type Page } from "@playwright/test";

// The real members component with its API stubbed: resending a pending
// invite, with and without email configured.

async function open(page: Page, email: boolean) {
  const resends: string[] = [];
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.route("**/api/orgs/org-1/invites/*/resend", (route) => {
    resends.push(route.request().url());
    return route.fulfill({ json: { invite: {}, link: "http://127.0.0.1:3100/invite/or_inv_rotated", emailed: email } });
  });
  await page.goto(`/settings/org/members?view=members${email ? "&email=1" : ""}`);
  await expect(page.getByText("grace@neev.ai")).toBeVisible();
  return resends;
}

test("without email: a note says so, and Resend shows the new link to copy", async ({ page }, info) => {
  const resends = await open(page, false);
  await expect(page.getByText(/won't be emailed until RESEND_API_KEY and EMAIL_FROM/)).toBeVisible();
  await expect(page.getByText(/waiting, expires in 5 days/)).toBeVisible();
  await expect(page.getByText(/expired: resend it for a new link/)).toBeVisible();
  if (info.project.name === "desktop") await page.screenshot({ path: ".context/org-members-pending.png", fullPage: true });
  await page.getByRole("button", { name: "Resend" }).first().click();
  await expect(page.getByText(/Send grace@neev.ai this new link. The old one no longer works/)).toBeVisible();
  await expect(page.getByLabel("Invite link")).toHaveValue("http://127.0.0.1:3100/invite/or_inv_rotated");
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
  expect(resends).toEqual([expect.stringContaining("/api/orgs/org-1/invites/inv-1/resend")]);
  if (info.project.name === "desktop") await page.screenshot({ path: ".context/org-members-resent-link.png", fullPage: true });
});

test("with email: no note, and Resend says it was emailed", async ({ page }) => {
  await open(page, true);
  await expect(page.getByText(/won't be emailed until/)).toHaveCount(0);
  await page.getByRole("button", { name: "Resend" }).first().click();
  await expect(page.getByText("Emailed grace@neev.ai a new link. The old one no longer works.")).toBeVisible();
  await expect(page.getByLabel("Invite link")).toHaveCount(0);
});
