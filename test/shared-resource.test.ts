import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedResource } from "@/lib/client/shared-resource";

/** A resource over a lookup the test answers by hand. */
function setup() {
  const pending: { resolve: (value: string[]) => void; reject: (error: Error) => void }[] = [];
  const resource = sharedResource<string[]>(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    [],
  );
  return { resource, pending };
}

test("until the first answer it holds the stand-in, loading", () => {
  const { resource } = setup();
  assert.deepEqual(resource.getSnapshot(), { status: "loading", value: [], error: null });
  assert.equal(resource.getServerSnapshot(), resource.getSnapshot());
});

test("the snapshot is the same object until something changes", async () => {
  // useSyncExternalStore re-renders forever on a new object each read.
  const { resource, pending } = setup();
  assert.equal(resource.getSnapshot(), resource.getSnapshot());
  const looking = resource.refresh();
  pending[0].resolve(["a"]);
  await looking;
  const ready = resource.getSnapshot();
  assert.equal(resource.getSnapshot(), ready);
  assert.deepEqual(ready, { status: "ready", value: ["a"], error: null });
});

test("a server render always gets the stand-in, whatever the page has since", async () => {
  const { resource, pending } = setup();
  const looking = resource.refresh();
  pending[0].resolve(["a"]);
  await looking;
  assert.deepEqual(resource.getServerSnapshot(), { status: "loading", value: [], error: null });
});

test("looks at the same time share one lookup", async () => {
  const { resource, pending } = setup();
  const both = Promise.all([resource.refresh(), resource.refresh(), resource.ensure()]);
  assert.equal(pending.length, 1);
  pending[0].resolve(["a"]);
  const [, , value] = await both;
  assert.deepEqual(value, ["a"]);
});

test("ensure answers from what is held, without looking again", async () => {
  const { resource, pending } = setup();
  const first = resource.ensure();
  pending[0].resolve(["a"]);
  assert.deepEqual(await first, ["a"]);
  assert.deepEqual(await resource.ensure(), ["a"]);
  assert.equal(pending.length, 1);
});

test("refresh looks again, and the last answer shows meanwhile", async () => {
  const { resource, pending } = setup();
  const first = resource.refresh();
  pending[0].resolve(["a"]);
  await first;
  const again = resource.refresh();
  assert.deepEqual(resource.getSnapshot(), { status: "ready", value: ["a"], error: null });
  pending[1].resolve(["a", "b"]);
  await again;
  assert.deepEqual(resource.getSnapshot().value, ["a", "b"]);
});

test("a failed look keeps the last answer and says why", async () => {
  const { resource, pending } = setup();
  const first = resource.refresh();
  pending[0].resolve(["a"]);
  await first;
  const failing = resource.refresh();
  pending[1].reject(new Error("agent down"));
  await failing;
  assert.deepEqual(resource.getSnapshot(), { status: "error", value: ["a"], error: "agent down" });
});

test("after a failure ensure looks again, and rejects if that fails too", async () => {
  const { resource, pending } = setup();
  const first = resource.ensure();
  pending[0].reject(new Error("offline"));
  await assert.rejects(first, /offline/);
  const second = resource.ensure();
  assert.equal(pending.length, 2);
  pending[1].resolve(["a"]);
  assert.deepEqual(await second, ["a"]);
});

test("invalidate keeps showing what is held until ensure looks again", async () => {
  const { resource, pending } = setup();
  const first = resource.ensure();
  pending[0].resolve(["a"]);
  await first;
  resource.invalidate();
  assert.deepEqual(resource.getSnapshot().value, ["a"]);
  const again = resource.ensure();
  assert.equal(pending.length, 2);
  pending[1].resolve(["b"]);
  assert.deepEqual(await again, ["b"]);
  assert.deepEqual(await resource.ensure(), ["b"]);
  assert.equal(pending.length, 2);
});

test("subscribers hear each change until they unsubscribe", async () => {
  const { resource, pending } = setup();
  let heard = 0;
  const unsubscribe = resource.subscribe(() => heard++);
  const first = resource.refresh();
  pending[0].resolve(["a"]);
  await first;
  assert.equal(heard, 1);
  unsubscribe();
  const second = resource.refresh();
  pending[1].resolve(["b"]);
  await second;
  assert.equal(heard, 1);
});

test("an invalidation during a lookup is not lost: that answer predates the change", async () => {
  const { resource, pending } = setup();
  const before = resource.refresh();
  resource.invalidate();
  const after = resource.ensure();
  assert.equal(pending.length, 2);
  pending[1].resolve(["new"]);
  pending[0].resolve(["old"]);
  await before;
  assert.deepEqual(await after, ["new"]);
  assert.deepEqual(resource.getSnapshot().value, ["new"]);
});
