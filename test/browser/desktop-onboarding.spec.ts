import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { desktop } from "./desktop-onboarding-fixture";

test("fresh desktop signup reuses signed-in Codex and carries the selected folder into the first session", async ({
  page,
}, info) => {
  const writes = await desktop(page);
  await page.goto("/?view=onboarding");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute(
    "data-ready",
    "true",
    { timeout: 20_000 },
  );
  await expect(
    page.getByRole("heading", { name: "Choose a coding agent" }),
  ).toBeVisible();
  await expect(page.getByText("Detected · Signed in")).toBeVisible();
  await page.getByRole("button", { name: /Codex.*Detected/ }).click();
  await expect(
    page.getByRole("button", { name: "On this Mac", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await mkdir(".context/desktop-onboarding", { recursive: true });
  await page.screenshot({
    path: `.context/desktop-onboarding/ready-${info.project.name}.png`,
  });
  await page
    .getByRole("button", { name: "Continue with Codex", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Choose a folder to work in" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose folder", exact: true })
    .click();
  const link = page.getByTestId("onboarding-destination");
  await expect(link).toHaveAttribute(
    "href",
    /target=local.*folder=%2FUsers%2Fada%2Fprojects%2Fdemo/,
  );
  expect(writes).toContainEqual({
    url: "/api/settings/agents",
    body: { agent: "codex", method: "local" },
  });
  expect(
    await page.evaluate(
      () => (window as unknown as { nativeCalls: string[] }).nativeCalls,
    ),
  ).not.toContain("local_codex_login");
  const href = await link.getAttribute("href");
  await page.goto(href!);
  await expect(
    page.getByRole("button", { name: /^Harness: Codex/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Harness: Codex/ }),
  ).toContainText("Native coding model");
  await expect(page.getByText("demo", { exact: true }).first()).toBeVisible();
});

for (const state of ["missing", "logged-out", "unknown"] as const)
  test(`desktop prepares ${state} Codex and confirms login before continuing`, async ({
    page,
  }) => {
    const writes = await desktop(page, state);
    await page.goto("/?view=onboarding");
    await expect(page.getByTestId("fixture-ready")).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 20_000 },
    );
    await page.getByRole("button", { name: /Codex/ }).click();
    await page
      .getByRole("button", {
        name:
          state === "missing" ? "Set up and continue" : "Sign in and continue",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: "Choose a folder to work in" }),
    ).toBeVisible();
    const calls = await page.evaluate(
      () => (window as unknown as { nativeCalls: string[] }).nativeCalls,
    );
    expect(calls).toContain("local_codex_login");
    expect(calls.includes("local_agent_setup")).toBe(state === "missing");
    expect(writes.filter((w) => w.url === "/api/settings/agents")).toHaveLength(
      1,
    );
  });

test("cloud ChatGPT connects in the app, waits for provider approval, then saves the cloud method", async ({
  page,
}, info) => {
  const writes = await desktop(page);
  await page.goto("/?view=onboarding");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute(
    "data-ready",
    "true",
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: /Codex/ }).click();
  await page.getByRole("button", { name: "In the cloud", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect ChatGPT account", exact: true })
    .click();
  await expect(page.getByText("ABCD-EFGHI", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("npx", { exact: false })).toHaveCount(0);
  await page.screenshot({
    path: `.context/desktop-onboarding/cloud-${info.project.name}.png`,
  });
  await page.evaluate(() => {
    (window as unknown as { approved: boolean }).approved = true;
  });
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /repositories/i }),
  ).toBeVisible();
  expect(writes).toContainEqual({
    url: "/api/settings/agents",
    body: { agent: "codex", method: "codex-account" },
  });
  expect(
    writes.filter((w) => w.url === "/api/settings/codex/desktop"),
  ).toHaveLength(1);
});

test("canceling cloud approval cannot continue or save an authentication choice", async ({
  page,
}) => {
  const writes = await desktop(page);
  await page.goto("/?view=onboarding");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute(
    "data-ready",
    "true",
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: /Codex/ }).click();
  await page.getByRole("button", { name: "In the cloud", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect ChatGPT account", exact: true })
    .click();
  await expect(page.getByText("ABCD-EFGHI", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("ABCD-EFGHI", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      writes.some(
        (w) =>
          w.url === "/api/settings/codex" &&
          (w.body as { action?: string })?.action === "cancel",
      ),
    )
    .toBe(true);
  expect(writes.filter((w) => w.url === "/api/settings/agents")).toHaveLength(
    0,
  );
});
