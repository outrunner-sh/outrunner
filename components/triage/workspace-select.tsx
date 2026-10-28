"use client";

import { SELECT_OPTIONS } from "@/components/ui/select-options";
import { cn } from "@/lib/utils";

/** The workspace an item belongs to: one of the synced repositories, or
 *  Unsorted (""). */
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
  // One the list no longer has still shows as chosen rather than as Unsorted.
  const known = value === null || projects.some((p) => p.id === value);
  return (
    <select
      aria-label="Workspace"
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
      className={cn(
        "h-8 max-w-full rounded-md border border-input bg-transparent px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30",
        SELECT_OPTIONS,
        className,
      )}
    >
      <option value="" disabled={!allowUnsorted && value !== null}>
        Unsorted
      </option>
      {!known && value && <option value={value}>Workspace</option>}
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.fullName}
        </option>
      ))}
    </select>
  );
}
