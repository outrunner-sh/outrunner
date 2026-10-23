/**
 * What CI needs to build and check the box image (.github/workflows/box-image.yml),
 * from lib/runtime/box-image.ts, so the workflow repeats none of it:
 *
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs scripts/box-image.ts <command>
 *
 *   image       the image reference; fails if BOX_IMAGE_TAG isn't box/Dockerfile's
 *   build-args  `--build-arg NAME=value` for each pinned version, one per line
 *   check       the shell check a box (or the built image) must pass
 */

import { readFileSync } from "node:fs";

import { BOX_IMAGE, BOX_IMAGE_TAG, boxBuildArgs, boxCheckScript, boxImageTag } from "@/lib/runtime/box-image";

const command = process.argv[2];

switch (command) {
  case "image": {
    const tag = boxImageTag(readFileSync(new URL("../box/Dockerfile", import.meta.url), "utf8"));
    if (tag !== BOX_IMAGE_TAG) {
      console.error(`box/Dockerfile or BOX_TOOLS changed: set BOX_IMAGE_TAG to "${tag}" in lib/runtime/box-image.ts`);
      process.exit(1);
    }
    console.log(BOX_IMAGE);
    break;
  }
  case "build-args":
    for (const [name, value] of Object.entries(boxBuildArgs())) console.log(`--build-arg=${name}=${value}`);
    break;
  case "check":
    console.log(boxCheckScript());
    break;
  default:
    console.error("usage: box-image.ts image | build-args | check");
    process.exit(2);
}
