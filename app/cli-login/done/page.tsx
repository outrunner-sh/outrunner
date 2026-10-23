import Link from "next/link";

/** Where the CLI sends the browser once it has its token. */
export default function CliLoginDonePage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8">
        <p aria-hidden className="select-none font-display text-7xl leading-none text-foreground/25">
          outrunner
        </p>
        <div className="space-y-2">
          <h1 className="text-sm">The CLI is signed in.</h1>
          <p className="text-xs text-muted-foreground">You can close this tab and go back to your terminal.</p>
        </div>
        <Link href="/" className="text-xs underline underline-offset-4">
          Open Outrunner
        </Link>
      </div>
    </main>
  );
}
