import Link from "next/link";
import About from "@/app/settings/general/page";
export default function HelpAbout() {
  return <main className="mx-auto max-w-2xl space-y-6 p-8"><Link href="/" className="text-sm text-muted-foreground">← Back to app</Link><About /></main>;
}
