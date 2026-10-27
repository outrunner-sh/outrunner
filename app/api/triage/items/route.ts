import { NextResponse } from "next/server";

import { captureWorkItem, listWorkItems, resolveProject } from "@/lib/db/work-items";
import { triageCaller } from "@/lib/triage/caller";
import { itemUrl } from "@/lib/triage/urls";
import { itemKey, parseNewWorkItem } from "@/lib/triage/work-items";

/** The owner's work items, for the triage page. */
export async function GET(request: Request) {
  const caller = await triageCaller(request, { allowToken: true });
  if (caller instanceof NextResponse) return caller;
  return NextResponse.json({ items: await listWorkItems(caller.db, caller.owner.id) });
}

/**
 * Capture a work item: from the app's form, or with a CLI token (the CLI's
 * `outrunner triage`, a script). It lands in triage, in the workspace
 * `project` names (`owner/name`) or Unsorted. A `source_ref` an item already
 * has makes it a note on that one instead (`created: false`).
 */
export async function POST(request: Request) {
  const caller = await triageCaller(request, { allowToken: true });
  if (caller instanceof NextResponse) return caller;

  const raw: unknown = await request.json().catch(() => null);
  const input = parseNewWorkItem(raw, caller.sources);
  if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 });

  let projectId: string | null = null;
  if (input.project) {
    projectId = await resolveProject(caller.db, caller.owner.id, input.project);
    if (!projectId) {
      return NextResponse.json(
        { error: `No workspace named ${input.project}. Leave it out to file the item as Unsorted.` },
        { status: 404 },
      );
    }
  }

  const result = await captureWorkItem(caller.db, caller.owner.id, { ...input, projectId });
  return NextResponse.json(
    {
      item: result.item,
      key: itemKey(result.item),
      url: itemUrl(result.item),
      created: result.kind === "created",
    },
    { status: result.kind === "created" ? 201 : 200 },
  );
}
