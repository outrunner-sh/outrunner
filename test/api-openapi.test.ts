import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { API_OPERATIONS, openApiSpec, operationId } from "@/lib/api/openapi";

const V1 = path.join(process.cwd(), "app/api/v1");

/** Every route under app/api/v1, as "METHOD /path" with `{param}`s. */
function routedOperations(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") {
        const route = "/" + path.relative(V1, dir).split(path.sep).join("/");
        const apiPath = route.replace(/\[(\w+)\]/g, "{$1}");
        const source = readFileSync(full, "utf8");
        for (const [, method] of source.matchAll(/^export (?:async )?function (GET|POST|PATCH|PUT|DELETE)\b/gm)) {
          found.push(`${method} ${apiPath}`);
        }
      }
    }
  };
  walk(V1);
  return found.sort();
}

test("the spec names every route the API has, and no other", () => {
  const described = API_OPERATIONS.map((op) => `${op.method} ${op.path}`).sort();
  assert.deepEqual(described, routedOperations());
});

test("operation ids are unique and read as calls", () => {
  const ids = API_OPERATIONS.map(operationId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(operationId({ method: "POST", path: "/workspaces/{id}/plan/approve", summary: "", tag: "" }), "postWorkspacesIdPlanApprove");
  assert.equal(operationId({ method: "GET", path: "/skills/search", summary: "", tag: "" }), "getSkillsSearch");
});

test("the document is OpenAPI 3.1 with path parameters, bodies and the key", () => {
  const spec = openApiSpec("https://app.outrunner.sh/") as {
    openapi: string;
    servers: { url: string }[];
    paths: Record<string, Record<string, { parameters?: { name: string; in: string }[]; requestBody?: { content: Record<string, unknown> }; security?: unknown[] }>>;
  };
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.servers[0].url, "https://app.outrunner.sh/api/v1");
  const answer = spec.paths["/workspaces/{id}/answer"].post;
  assert.deepEqual(answer.parameters?.map((p) => [p.name, p.in]), [["id", "path"]]);
  assert.ok(answer.requestBody?.content["application/json"]);
  assert.ok(spec.paths["/attachments"].post.requestBody?.content["multipart/form-data"]);
  assert.deepEqual(spec.paths["/openapi.json"].get.security, []);
});
