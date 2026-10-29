"use client";

import Image from "next/image";
import { LogOut } from "lucide-react";
import { useFormStatus } from "react-dom";

import { signOut } from "@/app/auth/actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/loaders";
import { clearKeptPages } from "@/lib/client/kept-page";
import { clearMissions } from "@/lib/missions/kept-missions";
import { clearAppDataCache } from "@/lib/session/app-data-cache";
import { CONVERSATIONS } from "@/lib/session/conversation-cache";
import { closeKeptStreams } from "@/lib/session/kept-streams";
import { clearKeptTriage } from "@/lib/triage/kept-triage";

/**
 * The bottom-of-sidebar user pill (the sidebar draws the divider above it),
 * opening onto who is signed in and Log out. Settings is the gear beside it,
 * not repeated here.
 */
export function HomeUserMenu({
  ownerLogin,
  ownerAvatarUrl,
}: {
  ownerLogin: string;
  ownerAvatarUrl: string | null;
}) {
  const label = ownerLogin || "signed in";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left outline-none transition-colors hover:bg-accent">
        <Avatar url={ownerAvatarUrl} />
        <span className="truncate text-[13px] text-foreground">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="flex items-center gap-2 font-normal">
          <Avatar url={ownerAvatarUrl} />
          <span className="truncate">{label}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <form action={signOut}>
          <SignOutItem />
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Log out, staying open with its icon turning until the redirect lands (the
 *  menu would otherwise close at once, with nothing to say it worked). The
 *  conversations and the lists this browser kept go with the user. */
function SignOutItem() {
  const { pending } = useFormStatus();
  return (
    <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
      <button
        type="submit"
        className="w-full"
        aria-busy={pending || undefined}
        disabled={pending}
        onClick={() => {
          closeKeptStreams();
          CONVERSATIONS.clear();
          clearAppDataCache();
          clearMissions();
          clearKeptTriage();
          clearKeptPages();
        }}
      >
        {pending ? <Spinner /> : <LogOut />}
        Log out
      </button>
    </DropdownMenuItem>
  );
}

function Avatar({ url }: { url: string | null }) {
  return url ? (
    <Image
      src={url}
      alt=""
      width={22}
      height={22}
      className="size-[22px] rounded-full border border-border/60"
    />
  ) : (
    <span className="size-[22px] shrink-0 rounded-full bg-accent" />
  );
}
