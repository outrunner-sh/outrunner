/**
 * What this server is: the commit it's deployed as (OUTRUNNER_BUILD) and the
 * git tree its image was built from (OUTRUNNER_TREE, baked in by the
 * Dockerfile). An image is built once per tree and deployed as whichever
 * commit has that tree, so the deploy checks both: the commit says which
 * deploy this is, the tree that the code running is the code tested.
 */
export type BuildInfo = { build: string | null; tree: string | null };

export function buildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  return { build: env.OUTRUNNER_BUILD || null, tree: env.OUTRUNNER_TREE || null };
}
