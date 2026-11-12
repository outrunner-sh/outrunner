import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { ModalBackend, type ModalToken } from "@/lib/runtime/sandbox/modal";
import { SandboxSetupError } from "@/lib/runtime/sandbox-setup-error";

/** The token a user's own Modal is reached on is missing or unreadable. */
export class NoModalTokenError extends SandboxSetupError {
  constructor() {
    super("The stored Modal credential is unavailable. Ask your deployment administrator to check runtime configuration.");
    this.name = "NoModalTokenError";
  }
}

/** The Runtime Computer in a user's own Modal account, on their token
 *  (Settings → Sandbox). `token` reads it when a box is first reached. */
export class UserModalRuntimeProvider extends ComputerRuntimeProvider {
  constructor(token: () => Promise<ModalToken | null>) {
    super(
      "user-modal",
      new ModalBackend({
        token: async () => {
          const found = await token();
          if (!found) throw new NoModalTokenError();
          return found;
        },
        // Loaded when a box is first deployed to: storage is a server-only
        // module, which a test of this provider doesn't need.
        stash: async (data) => (await import("@/lib/runtime/storage/box-uploads")).stashForBox(data),
      }),
    );
  }
}
