/**
 * Build the E2B template Outrunner's boxes start from (RUNTIME_PROVIDER=e2b):
 * box/Dockerfile at the BOX_TOOLS pins, Small-sized, named for the image tag
 * (lib/runtime/sandbox/e2b.ts's default OUTRUNNER_E2B_TEMPLATE), on the E2B that
 * OUTRUNNER_E2B_API_KEY / OUTRUNNER_E2B_API_URL / OUTRUNNER_E2B_SANDBOX_URL name.
 *
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs scripts/e2b-template.ts
 *
 * OUTRUNNER_E2B_GUEST_MTU, where the host network needs it, is set in the build VM too.
 * Re-run after box/Dockerfile or BOX_TOOLS changes (the tag changes with them).
 */

import { requireEnv } from "@/lib/env";
import { e2bTemplateBuildStatus, startE2bTemplateBuild } from "@/lib/runtime/e2b-template";
import { e2bTemplate, guestMtu } from "@/lib/runtime/sandbox/e2b";

const target = { apiKey: requireEnv("OUTRUNNER_E2B_API_KEY"), apiUrl: requireEnv("OUTRUNNER_E2B_API_URL") };
const name = e2bTemplate();
console.log(`Building ${name}…`);
const build = await startE2bTemplateBuild(target, name, guestMtu());
for (;;) {
  const status = await e2bTemplateBuildStatus(target, build);
  if (status.state === "ready") break;
  if (status.state === "failed") {
    console.error(`Build ${build.buildId} failed: ${status.error}`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
console.log(`Built ${name}: template ${build.templateId}, build ${build.buildId}`);
