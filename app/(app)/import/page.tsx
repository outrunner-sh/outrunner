import { redirect } from "next/navigation";

import { LocalImport } from "@/components/local-import";
import { getOwnerSafe } from "@/lib/auth/owner";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  if (!(await getOwnerSafe())) redirect("/signin?next=/import");
  return <LocalImport />;
}
