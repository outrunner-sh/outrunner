import { randomBytes } from "node:crypto";

import type {
  ProvisionedComputer,
  ProvisionComputerInput,
} from "@/lib/runtime/computer-provider";
import type { ComputerScope } from "@/lib/runtime/computer-scope";
import type { BoxResources } from "@/lib/runtime/sandbox/backend";
import type { ProviderName, RuntimeComputer, RuntimeComputerStatus } from "@/lib/runtime/types";

const POLL_INTERVAL_MS = 500;
const PROVISION_WAIT_MS = 3 * 60_000;

export type RuntimeComputerProvisioner = {
  /** Recorded on the computer, so a later session knows which provider has it. */
  readonly name: ProviderName;
  provisionComputer(input: ProvisionComputerInput): Promise<ProvisionedComputer>;
  /** Delete a box, and pause one, for a box provisioned here that couldn't
   *  be recorded: nothing else knows of it. Best effort (never throws). */
  destroyComputer?(sandboxId: string): Promise<void>;
  pauseComputer?(sandboxId: string): Promise<void>;
};

type Claim = (input: {
  scope: ComputerScope;
  agentSecret: string;
  /** The plan's cap on the owner's running boxes, enforced where the claim
   *  is atomic; null when none applies. */
  maxLiveComputers: number | null;
}) => Promise<{ computer: RuntimeComputer; shouldProvision: boolean }>;

export type EnsureRuntimeComputerDependencies = {
  claim: Claim;
  /** The box of the scope, as it is now. */
  get: (scope: ComputerScope) => Promise<RuntimeComputer | null>;
  readSecret: (computerId: string) => Promise<string | null>;
  update: (
    id: string,
    patch: {
      status?: RuntimeComputerStatus;
      daytonaSandboxId?: string | null;
      provider?: ProviderName;
      agentBaseUrl?: string | null;
      provisionTimings?: RuntimeComputer["provisionTimings"];
      errorMessage?: string | null;
      touchActive?: boolean;
    },
  ) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** A box this request made or brought back is running, with `cpu` vCPUs
   *  where known: where its cloud hours start. A failure here is logged; it
   *  never fails the provision. */
  started?: (computer: RuntimeComputer, cpu: number | undefined) => Promise<void>;
};

export type EnsureRuntimeComputerInput = {
  /** Whose box: a workspace's own, or a project's shared one from before. */
  scope: ComputerScope;
  repoFullName: string;
  githubToken?: string;
  sessionEnv?: Record<string, string>;
  /** CPU and memory, if a box is made now (one already there keeps its own). */
  size?: BoxResources;
  /** The project's box that ended on its own, for a provider that brings one
   *  back on the disk it left (ProvisionComputerInput.previousSandboxId). */
  previousSandboxId?: string;
  /** The plan's cap on the owner's running boxes, enforced by the claim in
   *  the database; null or unset when none applies. */
  maxLiveComputers?: number | null;
};

export type EnsuredRuntimeComputer = {
  computer: RuntimeComputer;
  /** True only for the request that performed the external provision. */
  provisioned: boolean;
  /** Server-only secret for the immediately following agent control calls. */
  agentSecret: string;
};

/**
 * Find or lazily provision the Runtime Computer of a scope: a workspace's own
 * box, or a project's shared one from before (lib/runtime/computer-scope.ts).
 *
 * The database RPC atomically elects exactly one request to own provision.
 * Non-owners wait on the durable row rather than starting duplicate Daytona
 * boxes. A unique index is deliberately retained as a second,
 * database-enforced line of defence.
 */
export async function ensureRuntimeComputer(
  provider: RuntimeComputerProvisioner,
  input: EnsureRuntimeComputerInput,
  deps: EnsureRuntimeComputerDependencies,
): Promise<EnsuredRuntimeComputer> {
  const agentSecret = randomBytes(32).toString("hex");
  const claim = await deps.claim({
    scope: input.scope,
    agentSecret,
    maxLiveComputers: input.maxLiveComputers ?? null,
  });

  if (!claim.shouldProvision) {
    const computer = await waitForReadyComputer(input.scope, deps);
    const persistedSecret = await deps.readSecret(computer.id);
    if (!persistedSecret) {
      throw new Error("Runtime Computer secret is missing after provisioning.");
    }
    return { computer, provisioned: false, agentSecret: persistedSecret };
  }

  // The claim cleared the row's box. The one that ended goes back on it while
  // it's brought back: it holds the sessions, and a row that names it keeps it
  // from the orphaned-box sweep (lib/runtime/orphan-boxes.ts), even if this
  // server stops before the provision is done.
  let provisioned: ProvisionedComputer | null = null;
  try {
    if (input.previousSandboxId) {
      await deps.update(claim.computer.id, { daytonaSandboxId: input.previousSandboxId });
    }
    provisioned = await provider.provisionComputer({
      secret: agentSecret,
      repoFullName: input.repoFullName,
      githubToken: input.githubToken,
      sessionEnv: input.sessionEnv,
      size: input.size,
      previousSandboxId: input.previousSandboxId,
    });
    await deps.update(claim.computer.id, {
      status: "ready",
      daytonaSandboxId: provisioned.sandboxId,
      provider: provider.name,
      agentBaseUrl: provisioned.agentBaseUrl,
      provisionTimings: provisioned.timings,
      errorMessage: null,
      touchActive: true,
    });
    const computer = await deps.get(input.scope);
    if (!computer || computer.status !== "ready" || !computer.daytonaSandboxId) {
      throw new Error("Runtime Computer was not persisted as ready.");
    }
    // The box's own size first: a resumed box keeps the one it was made at.
    await deps.started?.(computer, provisioned.cpu ?? input.size?.cpu).catch((error: unknown) =>
      console.error(`Could not start metering Runtime Computer ${computer.id}`, error),
    );
    return { computer, provisioned: true, agentSecret };
  } catch (error) {
    // A box made but never recorded as ready (the write failed, or the row
    // moved on meanwhile) was otherwise left running with no row naming it.
    // One brought back in place is stopped again, as the row says below.
    if (provisioned) await letGo(provider, provisioned.sandboxId, input.previousSandboxId);
    const errorMessage = "Runtime Computer provisioning failed. Check Runtime setup and try again.";
    await deps.update(
      claim.computer.id,
      input.previousSandboxId
        ? // Still the box that ended, so the next try restores from it again
          // rather than starting over without its sessions.
          { status: "stopped", daytonaSandboxId: input.previousSandboxId, errorMessage }
        : { status: "error", errorMessage },
    ).catch((updateError: unknown) =>
      console.error("Could not save Runtime Computer failure state", updateError),
    );
    throw error;
  }
}

/** Let go of a box this request provisioned but couldn't record: deleted, or
 *  paused when it is the ended box brought back in place (its sessions are
 *  on it). Logged, never thrown: the provision's own failure is the one to
 *  report. */
async function letGo(
  provider: RuntimeComputerProvisioner,
  sandboxId: string,
  previousSandboxId: string | undefined,
): Promise<void> {
  try {
    if (sandboxId === previousSandboxId) await provider.pauseComputer?.(sandboxId);
    else await provider.destroyComputer?.(sandboxId);
  } catch (error) {
    console.error(`Could not let go of box ${sandboxId}, provisioned but not recorded`, error);
  }
}

async function waitForReadyComputer(
  scope: ComputerScope,
  deps: EnsureRuntimeComputerDependencies,
): Promise<RuntimeComputer> {
  const deadline = deps.now() + PROVISION_WAIT_MS;
  while (true) {
    const computer = await deps.get(scope);
    if (!computer) {
      throw new Error("Runtime Computer claim disappeared before provisioning completed.");
    }
    if (computer.status === "ready" && computer.daytonaSandboxId) return computer;
    if (computer.status === "error" || computer.status === "stopped") {
      throw new Error("Runtime Computer provisioning did not complete.");
    }
    if (deps.now() >= deadline) {
      throw new Error("Timed out waiting for Runtime Computer provisioning.");
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}
