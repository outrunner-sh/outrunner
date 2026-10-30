import { tauriCore, forgetOutrunnerModels } from "@/lib/desktop/local-runtime";

export type CodexConnectProgress =
  | { state: "preparing" }
  | { state: "waiting"; url: string; code: string }
  | { state: "done" | "ended" }
  | { state: "error"; message: string };

async function json(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? "Couldn't connect Codex. Try again.");
  return data;
}

export async function connectDesktopCodex(
  orgId: string | undefined,
  signal: AbortSignal,
  progress: (value: CodexConnectProgress) => void,
): Promise<void> {
  const core = tauriCore();
  if (!core)
    throw new Error("Open the Outrunner desktop app to connect Codex.");
  const query = orgId ? `?org=${encodeURIComponent(orgId)}` : "";
  const { attempt, bearer } = await json(
    `/api/settings/codex/desktop${query}`,
    { action: "begin" },
  );
  const cancel = async () => {
    await Promise.allSettled([
      core.invoke("connect_codex_cancel", { attempt }),
      json(`/api/settings/codex${query}`, { action: "cancel", attempt }),
    ]);
  };
  const aborted = () => void cancel();
  signal.addEventListener("abort", aborted, { once: true });
  try {
    signal.throwIfAborted();
    await core.invoke("connect_codex_start", { attempt, bearer });
    const deadline = Date.now() + 610_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const next = (await core.invoke("connect_codex_poll", {
        attempt,
      })) as CodexConnectProgress;
      signal.throwIfAborted();
      if (next.state === "error") throw new Error(next.message);
      if (next.state === "ended")
        throw new Error("Codex sign-in was canceled. Try again.");
      progress(next);
      if (next.state === "done") {
        forgetOutrunnerModels();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Codex sign-in expired. Try again.");
  } catch (error) {
    await cancel();
    if (typeof error === "string" && /not found|not allowed/i.test(error)) {
      throw new Error(
        "Update the Outrunner desktop app to connect Codex without a terminal.",
      );
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", aborted);
    await core.invoke("connect_codex_cancel", { attempt }).catch(() => {});
  }
}
