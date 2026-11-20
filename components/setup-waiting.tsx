import { KeyRound, Laptop, Users } from "lucide-react";
import Link from "next/link";

/**
 * Home for a member of an org that isn't set up yet (lib/orgs/setup.ts): an
 * admin picks its repositories and makes its first environment, and until
 * then there's nothing here to start a session from. What they can do
 * meanwhile, in place of the new-session form.
 */
export function SetupWaiting({ orgName }: { orgName: string }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
      <section className="w-full max-w-md space-y-5" aria-labelledby="setup-waiting">
        <div className="space-y-1.5 text-center">
          <h1 id="setup-waiting" className="text-xl font-semibold">
            An admin is setting up {orgName}
          </h1>
          <p className="text-muted-foreground text-sm">
            Sessions start once an admin has picked the repositories it works on and made its first environment.
          </p>
        </div>
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60 text-sm">
          <li>
            <Link href="/settings/coding-agents" className="hover:bg-accent/40 flex items-start gap-3 px-4 py-3">
              <KeyRound className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <span className="block font-medium">Connect your coding agent</span>
                <span className="text-muted-foreground block text-xs">Claude Code or Codex, ready for your first session.</span>
              </span>
            </Link>
          </li>
          <li className="flex items-start gap-3 px-4 py-3">
            <Users className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <span className="block font-medium">Ask an admin</span>
              <span className="text-muted-foreground block text-xs">Any admin of {orgName} can finish setting it up from its home page.</span>
            </span>
          </li>
          <li className="flex items-start gap-3 px-4 py-3">
            <Laptop className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <span className="block font-medium">Work in another org</span>
              <span className="text-muted-foreground block text-xs">Switch orgs from the menu at the top of the sidebar.</span>
            </span>
          </li>
        </ul>
      </section>
    </div>
  );
}
