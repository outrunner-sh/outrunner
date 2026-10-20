import { ComputerRuntimeProvider, reconcilerPausesBoxes } from "@/lib/runtime/computer-provider";
import { NeevBackend } from "@/lib/runtime/sandbox/neev";

/** The Runtime Computer on Neev sandboxes (RUNTIME_PROVIDER=neev). */
export class NeevRuntimeProvider extends ComputerRuntimeProvider {
  constructor() {
    super("neev", new NeevBackend({ idleBackstop: reconcilerPausesBoxes() }));
  }
}
