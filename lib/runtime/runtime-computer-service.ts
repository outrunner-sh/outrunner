/** Production wiring for lazy Runtime Computer provisioning. */
import { SMALL_BOX_CPU } from "@/lib/billing/hours";
import { isMetered, openInterval } from "@/lib/billing/metering-store";
import {
  claimRuntimeComputer,
  getRuntimeComputerByProject,
  readRuntimeComputerSecret,
  updateRuntimeComputer,
} from "@/lib/db/repositories";
import {
  ensureRuntimeComputer,
  type EnsureRuntimeComputerDependencies,
  type EnsureRuntimeComputerInput,
  type EnsuredRuntimeComputer,
  type RuntimeComputerProvisioner,
} from "@/lib/runtime/ensure-runtime-computer";

const dependencies: EnsureRuntimeComputerDependencies = {
  claim: claimRuntimeComputer,
  getByProject: getRuntimeComputerByProject,
  readSecret: readRuntimeComputerSecret,
  update: updateRuntimeComputer,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  // Cloud hours start when one of Outrunner's boxes does.
  started: async (computer, size) => {
    if (!isMetered(computer.provider) || !computer.daytonaSandboxId) return;
    await openInterval({
      computerId: computer.id,
      sandboxId: computer.daytonaSandboxId,
      cpu: size?.cpu ?? SMALL_BOX_CPU,
      at: new Date(),
    });
  },
};

export function ensureProjectRuntimeComputer(
  provider: RuntimeComputerProvisioner,
  input: EnsureRuntimeComputerInput,
): Promise<EnsuredRuntimeComputer> {
  return ensureRuntimeComputer(provider, input, dependencies);
}
