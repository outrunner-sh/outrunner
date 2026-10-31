import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DesktopWelcome } from "@/components/desktop-welcome";
import { DESKTOP_CONTEXT_COOKIE, desktopDestination, readDesktopContext } from "@/lib/auth/desktop/grant";
import { getOwner } from "@/lib/auth/owner";
import { needsOnboarding } from "@/lib/onboarding/server";

export default async function DesktopReadyPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const context = readDesktopContext((await cookies()).get(DESKTOP_CONTEXT_COOKIE)?.value);
  if (!context) return <DesktopWelcome expired />;
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=%2Fauth%2Fdesktop%2Fready");
  if (await needsOnboarding()) redirect("/onboarding");
  const { next } = await searchParams;
  return <DesktopWelcome email={owner.email ?? owner.name} next={desktopDestination(next ?? context.next)} />;
}
