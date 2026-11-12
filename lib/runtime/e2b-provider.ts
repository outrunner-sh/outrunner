import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { E2bBackend } from "@/lib/runtime/sandbox/e2b";

/** The Runtime Computer on our own E2B's sandboxes (RUNTIME_PROVIDER=e2b). */
export class E2bRuntimeProvider extends ComputerRuntimeProvider {
  constructor() {
    super("e2b", new E2bBackend());
  }
}
