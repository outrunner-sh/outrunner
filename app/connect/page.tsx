import { redirect } from "next/navigation";

import { RepoPicker } from "@/components/repo-picker";
import { getOwner } from "@/lib/auth/owner";

export const dynamic = "force-dynamic";

/** Pick the GitHub repositories to work in. Entered from the empty home state. */
export default async function ConnectPage() {
  if (!(await getOwner())) redirect("/signin?next=/connect");

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="mb-1 text-lg font-medium">Connect repositories</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Choose which of your GitHub repositories to work in. You can add more later.
      </p>
      <RepoPicker />
    </main>
  );
}
