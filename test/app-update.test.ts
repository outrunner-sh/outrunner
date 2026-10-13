import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { onUpdateReady, restartToUpdate, waitingUpdate } from "@/lib/desktop/app-update";

type Handler = (event: { payload: unknown }) => void;
const g = globalThis as { window?: unknown };
afterEach(() => {
  delete g.window;
});

/** Stand in for the Mac app's bridge. */
function inTheMacApp(invoke: (cmd: string) => Promise<unknown>) {
  const handlers: Handler[] = [];
  const unlistened: string[] = [];
  let resolveListen: () => void = () => {};
  const listening = new Promise<void>((resolve) => (resolveListen = resolve));
  g.window = {
    __RUNTIME_DESKTOP__: true,
    __TAURI__: {
      core: { invoke },
      event: {
        listen: async (event: string, handler: Handler) => {
          await listening;
          handlers.push(handler);
          return () => unlistened.push(event);
        },
      },
    },
  };
  return { handlers, unlistened, resolveListen };
}

test("outside the Mac app there's no update to offer", async () => {
  assert.equal(await waitingUpdate(), null);
  onUpdateReady(() => assert.fail("no app to hear from"))();
  await assert.rejects(restartToUpdate(), /Mac app/);
});

test("the installed version waiting for a restart is offered; none, or an older app, is not", async () => {
  inTheMacApp(async () => "0.5.0");
  assert.equal(await waitingUpdate(), "0.5.0");
  inTheMacApp(async () => null);
  assert.equal(await waitingUpdate(), null);
  inTheMacApp(async () => {
    throw new Error("Command update_status not found");
  });
  assert.equal(await waitingUpdate(), null);
});

test("an update that finishes installing shows up, until the sidebar stops listening", async () => {
  const app = inTheMacApp(async () => null);
  const seen: string[] = [];
  const stop = onUpdateReady((version) => seen.push(version));
  app.resolveListen();
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.handlers[0]({ payload: "0.5.1" });
  app.handlers[0]({ payload: 42 });
  assert.deepEqual(seen, ["0.5.1"]);
  stop();
  assert.deepEqual(app.unlistened, ["update-ready"]);
});

test("stopping before the app answers still stops listening", async () => {
  const app = inTheMacApp(async () => null);
  const stop = onUpdateReady(() => assert.fail("stopped already"));
  stop();
  app.resolveListen();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(app.unlistened, ["update-ready"]);
});

test("Update asks the app to restart into it", async () => {
  const calls: string[] = [];
  inTheMacApp(async (cmd) => {
    calls.push(cmd);
    return null;
  });
  await restartToUpdate();
  assert.deepEqual(calls, ["restart_to_update"]);
});
