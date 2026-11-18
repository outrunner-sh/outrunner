/**
 * Build the E2B template Outrunner's boxes start from (RUNTIME_PROVIDER=e2b):
 * box/Dockerfile at the BOX_TOOLS pins, Small-sized, named for the image tag
 * (lib/runtime/sandbox/e2b.ts's default E2B_TEMPLATE), on the E2B that
 * E2B_API_KEY / E2B_API_URL / E2B_SANDBOX_URL name.
 *
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs scripts/e2b-template.ts
 *
 * E2B_GUEST_MTU, where the host network needs it, is set in the build VM too.
 * Re-run after box/Dockerfile or BOX_TOOLS changes (the tag changes with them).
 */

import { readFileSync } from "node:fs";

import { defaultBuildLogger, Template } from "e2b";

import { requireEnv, optionalEnv } from "@/lib/env";
import { BOX_IMAGE_TAG, boxBuildArgs, boxImageTag } from "@/lib/runtime/box-image";
import { boxSize } from "@/lib/runtime/box-sizes";
import { e2bDockerfile } from "@/lib/runtime/e2b-template";
import { e2bTemplate, guestMtu } from "@/lib/runtime/sandbox/e2b";

const dockerfile = readFileSync(new URL("../box/Dockerfile", import.meta.url), "utf8");
if (boxImageTag(dockerfile) !== BOX_IMAGE_TAG) {
  console.error("box/Dockerfile or BOX_TOOLS changed: update BOX_IMAGE_TAG in lib/runtime/box-image.ts first");
  process.exit(1);
}

const size = boxSize("small");
const alias = e2bTemplate();
console.log(`Building ${alias} (${size.cpu} vCPU / ${size.memoryGb} GiB)…`);
const info = await Template.build(Template().fromDockerfile(e2bDockerfile(dockerfile, boxBuildArgs(), guestMtu())), {
  alias,
  cpuCount: size.cpu,
  memoryMB: size.memoryGb * 1024,
  apiKey: requireEnv("E2B_API_KEY"),
  apiUrl: optionalEnv("E2B_API_URL"),
  onBuildLogs: defaultBuildLogger({ minLevel: "info" }),
});
console.log(`Built ${info.alias}: template ${info.templateId}, build ${info.buildId}`);
