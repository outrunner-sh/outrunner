"use client";

import { Check, FolderGit2, Inbox } from "lucide-react";

import { PropertyChip } from "@/components/triage/property-chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The workspace an item belongs to: one of the synced repositories, or
 *  Unsorted (null). Shown as a chip that opens a menu of them. */
export function WorkspaceSelect({
  projects,
  value,
  onChange,
  disabled = false,
  allowUnsorted = true,
  className,
}: {
  projects: { id: string; fullName: string }[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
  /** Whether Unsorted may be picked (moving an item there needs write on
   *  all projects). */
  allowUnsorted?: boolean;
  className?: string;
}) {
  // One the list no longer has is still named as chosen rather than as Unsorted.
  const current = value ? (projects.find((p) => p.id === value)?.fullName ?? "Workspace") : null;
  const pick = (next: string | null) => {
    if (next !== value) onChange(next);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <PropertyChip aria-label="Workspace" className={className}>
          {current ? <FolderGit2 /> : <Inbox />}
          <span className="truncate">{current ?? "Unsorted"}</span>
        </PropertyChip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8} className="w-64 [&_[role=menuitem]]:text-[13px]">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Move to workspace</DropdownMenuLabel>
        <DropdownMenuItem disabled={!allowUnsorted && value !== null} onSelect={() => pick(null)}>
          <Inbox />
          <span className="flex-1">Unsorted</span>
          {value === null && <Check className="text-foreground" />}
        </DropdownMenuItem>
        {projects.length > 0 && <DropdownMenuSeparator />}
        {projects.map((project) => (
          <DropdownMenuItem key={project.id} onSelect={() => pick(project.id)}>
            <FolderGit2 />
            <span className="flex-1 truncate">{project.fullName}</span>
            {project.id === value && <Check className="text-foreground" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
