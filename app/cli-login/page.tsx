import { approveCliLogin } from "@/app/cli-login/actions";
import { ApproveButton } from "@/app/cli-login/approve-button";
import { parseCliLoginRequest } from "@/lib/auth/cli-login";
import { getOwnerSafe } from "@/lib/auth/owner";

/**
 * Where `outrunner login` sends the browser. The proxy has already sent a
 * signed-out visitor through sign-in and back here, so this only asks the
 * signed-in user to approve the computer the CLI named.
 */
export default async function CliLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const request = parseCliLoginRequest(await searchParams);
  const owner = await getOwnerSafe();

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8">
        <p aria-hidden className="select-none font-display text-7xl leading-none text-foreground/25">
          outrunner
        </p>
        {!request ? (
          <div className="space-y-2">
            <h1 className="text-sm">This sign-in link isn&apos;t complete.</h1>
            <p className="text-xs text-muted-foreground">
              Run <code className="font-mono">outrunner login</code> in your terminal again. It opens the right page.
            </p>
          </div>
        ) : !owner ? (
          <div className="space-y-2">
            <h1 className="text-sm">Sign in to Outrunner first.</h1>
            <p className="text-xs text-muted-foreground">Then run <code className="font-mono">outrunner login</code> again.</p>
          </div>
        ) : (
          <form action={approveCliLogin} className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-sm">Sign in the Outrunner CLI?</h1>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Computer</dt>
                <dd className="font-mono">{request.deviceName}</dd>
                <dt className="text-muted-foreground">As</dt>
                <dd className="font-mono">{owner.githubLogin}</dd>
              </dl>
              <p className="text-xs text-muted-foreground">
                Only approve this if you just ran <code className="font-mono">outrunner</code> yourself.
              </p>
            </div>
            <input type="hidden" name="port" value={request.port} />
            <input type="hidden" name="state" value={request.state} />
            <input type="hidden" name="challenge" value={request.challenge} />
            <input type="hidden" name="name" value={request.deviceName} />
            <ApproveButton />
          </form>
        )}
      </div>
    </main>
  );
}
