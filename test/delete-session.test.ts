import assert from "node:assert/strict";
import { test } from "node:test";

import { CONVERSATIONS } from "@/lib/session/conversation-cache";
import { deleteSession } from "@/lib/session/delete-session";

test("deleting a local session forgets its conversation, as a cloud one does", async () => {
  // Kept before there is a window, so nothing is scheduled against one.
  CONVERSATIONS.set("ws-local", { events: [], lastEventId: "10", seenIds: new Set(["10"]) });
  const sent: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    __RUNTIME_DESKTOP__: true,
    __TAURI__: {
      core: {
        invoke: (cmd: string, args?: Record<string, unknown>) => {
          sent.push(`${cmd} ${String(args?.path)}`);
          return Promise.resolve({});
        },
        Channel: class {},
      },
    },
  };
  await deleteSession("ws-local", { kind: "local-worktree" });
  assert.deepEqual(sent, ["local_agent_request /workspaces/ws-local/destroy"]);
  assert.equal(CONVERSATIONS.get("ws-local"), undefined);
});
