import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { ModalBackend, type ModalToken } from "@/lib/runtime/sandbox/modal";

/** The token a user's own Modal is reached on is missing or unreadable. */
export class NoModalTokenError extends Error {
  constructor() {
    super("Add your Modal token in Settings → Sandbox, or switch to Outrunner's sandbox.");
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
      }),
    );
  }
}
