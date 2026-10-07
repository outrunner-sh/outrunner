import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { DaytonaBackend } from "@/lib/runtime/sandbox/daytona";

/** The Runtime Computer on Daytona sandboxes (RUNTIME_PROVIDER=daytona). */
export class DaytonaRuntimeProvider extends ComputerRuntimeProvider {
  constructor() {
    super("daytona", new DaytonaBackend());
  }
}
