import assert from "node:assert/strict";
import { test } from "node:test";

import { apiError, codeFor, errorFromRoute } from "@/lib/api/errors";
import { snakeKeys } from "@/lib/api/serialize";

test("every refusal has the same envelope", async () => {
  const response = apiError(404, "Workspace not found.");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: "not_found", message: "Workspace not found.", status: 404 } });
  assert.equal(codeFor(409), "conflict");
  assert.equal(codeFor(502), "upstream_unavailable");
  assert.equal(codeFor(418), "internal");
});

test("an app route's refusal keeps its sentence and its settings link", async () => {
  const route = Response.json({ error: "Connect Claude first.", settingsHref: "/settings/providers" }, { status: 409 });
  const response = await errorFromRoute(route, "https://app.example");
  assert.deepEqual(await response.json(), {
    error: { code: "conflict", message: "Connect Claude first.", status: 409, settings_url: "https://app.example/settings/providers" },
  });
});

test("a route that said nothing gets a plain sentence", async () => {
  const response = await errorFromRoute(new Response("oops", { status: 502 }));
  const body = (await response.json()) as { error: { message: string; code: string } };
  assert.equal(body.error.code, "upstream_unavailable");
  assert.match(body.error.message, /couldn't/);
});

test("records passed on whole are snake_case at every depth", () => {
  assert.deepEqual(snakeKeys({ pullRequest: { headBranch: "x", checks: [{ conclusionState: 1 }] } }), {
    pull_request: { head_branch: "x", checks: [{ conclusion_state: 1 }] },
  });
});
