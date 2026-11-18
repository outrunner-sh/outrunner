import { NextResponse } from "next/server";
import { z } from "zod";

import { recordProjectChange } from "@/lib/audit/project-history";
import { archiveEnvironment, createEnvironment, getEnvironment, setOrgDefaultEnvironment } from "@/lib/db/environments";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { savingSettings } from "@/lib/http/settings-save";
import { orgCaller } from "@/lib/orgs/routes";
import { activeOrgId } from "@/lib/orgs/server";

const Create = z
  .object({
    name: z.string(),
    projectIds: z.array(z.string().uuid()),
    /** Make it the org's default too: its admins' to ask. */
    orgDefault: z.boolean().optional(),
  })
  .strict();

/**
 * Make an environment in the active org (lib/orgs/active.ts) of some of its
 * connected repositories, in the order given: the Environments page's "New
 * environment", and the org's first, made its default. Needs write on each
 * repository (createEnvironment); making it the org's default needs its
 * admin. The environment as made, 201.
 */
export async function POST(request: Request) {
  const orgId = await activeOrgId();
  if (!orgId) return NextResponse.json({ error: "Make or join an org first." }, { status: 409 });
  const parsed = Create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Name the environment and pick its repositories." }, { status: 400 });
  const { name, projectIds, orgDefault = false } = parsed.data;
  const caller = await orgCaller(request, orgId, { admin: orgDefault });
  if (caller instanceof Response) return caller;
  const { owner } = caller;

  return savingSettings("environments", async () => {
    let id: string;
    try {
      id = await createEnvironment(owner.id, orgId, name, projectIds);
    } catch (error) {
      if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
      throw error;
    }
    if (orgDefault) {
      try {
        await setOrgDefaultEnvironment(orgId, id, owner.id);
      } catch (error) {
        // Not left behind half made: asked again, it would make a second.
        await archiveEnvironment(owner.id, id).catch((cause: unknown) => console.error(`Couldn't take back environment ${id}`, cause));
        throw error;
      }
    }
    await recordProjectChange(owner, id, "project.created");
    const made = await getEnvironment(owner.id, id);
    if (!made) return NextResponse.json({ error: "The environment was made, but couldn't be read back." }, { status: 500 });
    return NextResponse.json(made, { status: 201 });
  });
}
