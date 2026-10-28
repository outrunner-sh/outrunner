import { NextResponse } from "next/server";

import { captureWorkItem, listWorkItems, resolveProject, WorkItemChangeError } from "@/lib/db/work-items";
import { permissionsFor } from "@/lib/triage/access";
import { triageCaller } from "@/lib/triage/caller";
import { itemUrl } from "@/lib/triage/urls";
import { itemKey, parseNewWorkItem } from "@/lib/triage/work-items";

/** The org's work items the caller may see, each with what they may do with
 *  it, and whether they may triage Unsorted ones. */
export async function GET(request: Request) {
  const caller = await triageCaller(request, { allowToken: true });
  if (caller instanceof NextResponse) return caller;
  const { actor } = caller;
  const items = await listWorkItems(actor);
  return NextResponse.json({
    items: items.map((item) => ({ ...item, can: permissionsFor(actor, item) })),
    // Where the caller may file or move items: the projects they may read
    // (and write), for the pickers.
    projects: Object.fromEntries(actor.levels),
    orgLevel: actor.orgLevel,
  });
}

/**
 * Capture a work item: from the app's form, or with a CLI token (the CLI's
 * `outrunner triage`, a script; `?org=` picks the org). It lands in triage,
 * in the workspace `project` names (`owner/name`) or Unsorted. A `source_ref`
 * an item of the org already has makes it a note on that one instead
 * (`created: false`).
 */
export async function POST(request: Request) {
  const caller = await triageCaller(request, { allowToken: true });
  if (caller instanceof NextResponse) return caller;
  const { actor } = caller;

  const raw: unknown = await request.json().catch(() => null);
  const input = parseNewWorkItem(raw, caller.sources);
  if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 });

  let projectId: string | null = null;
  if (input.project) {
    projectId = await resolveProject(actor, input.project);
    if (!projectId) {
      return NextResponse.json(
        { error: `No workspace named ${input.project} that you can see. Leave it out to file the item as Unsorted.` },
        { status: 404 },
      );
    }
  }

  try {
    const result = await captureWorkItem(actor, { ...input, projectId });
    return NextResponse.json(
      {
        item: { ...result.item, can: permissionsFor(actor, result.item) },
        key: itemKey(result.item),
        url: itemUrl(result.item),
        created: result.kind === "created",
      },
      { status: result.kind === "created" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof WorkItemChangeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
