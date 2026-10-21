import assert from "node:assert/strict";
import { test } from "node:test";

import { databaseNotUpdated } from "@/lib/http/database-not-updated";

test("a save refused for a missing table or column says the database needs updating", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    for (const code of ["PGRST205", "42P01", "PGRST204", "42703"]) {
      const response = databaseNotUpdated({ code, message: "relation does not exist" }, "a setup");
      assert.equal(response?.status, 503, code);
      assert.match((await response!.json()).error, /database is updated/);
    }
  } finally {
    console.error = original;
  }
});

test("any other failure is left to the caller", () => {
  assert.equal(databaseNotUpdated({ code: "23505" }, "a setup"), null);
  assert.equal(databaseNotUpdated(new Error("network down"), "a setup"), null);
});
