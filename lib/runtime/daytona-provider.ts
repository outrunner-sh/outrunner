import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { DaytonaBackend } from "@/lib/runtime/sandbox/daytona";

/** The Runtime Computer on Daytona sandboxes (RUNTIME_PROVIDER=daytona). */
export class DaytonaRuntimeProvider extends ComputerRuntimeProvider {
  constructor() {
    super("daytona", new DaytonaBackend());
  }
}

/** The key a user's own Daytona is reached on is missing or unreadable. */
export class NoDaytonaKeyError extends Error {
  constructor() {
    super("The stored Daytona credential is unavailable. Ask your deployment administrator to check runtime configuration.");
    this.name = "NoDaytonaKeyError";
  }
}

/** The Runtime Computer in a user's own Daytona account, on their key
 *  (Settings → Sandbox). `key` reads it when a box is first reached. */
export class UserDaytonaRuntimeProvider extends ComputerRuntimeProvider {
  constructor(key: () => Promise<string | null>) {
    super(
      "user-daytona",
      new DaytonaBackend({
        apiKey: async () => {
          const apiKey = await key();
          if (!apiKey) throw new NoDaytonaKeyError();
          return apiKey;
        },
      }),
    );
  }
}
