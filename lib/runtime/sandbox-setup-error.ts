/**
 * A user's own sandbox (Settings → Sandbox) can't take a new box until they
 * fix its setup: a missing key, a disconnected account, a template still
 * building. Its message says what to do; callers answer it as a 409, not an
 * outage.
 */
export class SandboxSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxSetupError";
  }
}
