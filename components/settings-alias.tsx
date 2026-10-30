"use client";

import Link from "next/link";
import { useEffect } from "react";

/** The server chooses the authorized scope. Preserve the fragment, which
 * never reaches the server, when following the request-time legacy alias. */
export function SettingsAlias({ href }: { href: string }) {
  useEffect(() => {
    window.location.replace(`${href}${window.location.hash}`);
  }, [href]);
  return <p role="status" className="text-sm text-muted-foreground">Opening Coding agents… <Link href={href}>Continue</Link></p>;
}
