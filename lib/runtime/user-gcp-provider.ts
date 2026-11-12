import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import type { GcpConnection } from "@/lib/runtime/gcp/config";
import { GcpBackend } from "@/lib/runtime/sandbox/gcp";
import { SandboxSetupError } from "@/lib/runtime/sandbox-setup-error";
export class NoGcpConnectionError extends SandboxSetupError {
  constructor() { super("Connect Google Cloud using outrunner sandbox connect gcp, then select it in Sandbox settings."); this.name = "NoGcpConnectionError"; }
}
export class UserGcpRuntimeProvider extends ComputerRuntimeProvider {
  constructor(ownerId: string, connection: () => Promise<GcpConnection | null>) { super("user-gcp", new GcpBackend(ownerId, connection)); }
}
