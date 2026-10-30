import assert from "node:assert/strict";
import { test } from "node:test";

import { provideAndSaveSecrets, SecretAnswer } from "@/lib/session/provide-secrets";

test("cloud secrets are saved automatically, including answers from old clients", async () => {
  for (const legacy of [{}, { save: false }, { save: true }]) {
    const answer = SecretAnswer.parse({ keys: ["APP_TOKEN"], values: { APP_TOKEN: "dummy-test-token" }, ...legacy });
    const order: string[] = [];
    const result = await provideAndSaveSecrets(answer, {
      provide: async (delivered) => {
        assert.equal("save" in delivered, false);
        order.push("provided");
      },
      save: async (values) => {
        assert.deepEqual(values, { APP_TOKEN: "dummy-test-token" });
        order.push("saved");
      },
      saveError: () => "Couldn't save to the project.",
    });
    assert.deepEqual(order, ["provided", "saved"]);
    assert.deepEqual(result, { result: "provided", saved: true });
    assert.equal(JSON.stringify(result).includes("dummy-test-token"), false);
  }
});

test("an expired or invalid request cannot change project secrets", async () => {
  await assert.rejects(provideAndSaveSecrets({ keys: ["APP_TOKEN"], values: { APP_TOKEN: "dummy" } }, {
    provide: async () => { throw new Error("expired"); },
    save: async () => { assert.fail("must not save"); },
    saveError: () => "Couldn't save.",
  }), /expired/);
});

test("skipping or providing no values does not save anything", async () => {
  for (const answer of [{ keys: ["APP_TOKEN"], skipped: true }, { keys: ["APP_TOKEN"], values: {} }]) {
    let delivered = false;
    assert.deepEqual(await provideAndSaveSecrets(answer, {
      provide: async () => { delivered = true; },
      save: async () => { assert.fail("must not save"); },
      saveError: () => "Couldn't save.",
    }), { result: "provided" });
    assert.equal(delivered, true);
  }
});

test("a project save failure reports partial success without losing session delivery or exposing values", async () => {
  let delivered = false;
  const result = await provideAndSaveSecrets({ keys: ["APP_TOKEN"], values: { APP_TOKEN: "dummy-test-token" } }, {
    provide: async () => { delivered = true; },
    save: async () => { throw new Error("database details"); },
    saveError: () => "The session has them, but they weren't saved to the project.",
  });
  assert.equal(delivered, true);
  assert.deepEqual(result, { result: "provided", saved: false, saveError: "The session has them, but they weren't saved to the project." });
});
