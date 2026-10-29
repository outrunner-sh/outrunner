"use client";

import { cn } from "@/lib/utils";

/** One row: icon, what it is, and a count or chevron on the right. With
 *  `onClick` it is a button: `expanded` marks one that unfolds details, `busy`
 *  one at work, which ignores clicks. */
export function EnvRow({
  ref,
  icon,
  right,
  title,
  onClick,
  expanded,
  disabled,
  busy,
  merged,
  children,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  icon: React.ReactNode;
  right?: React.ReactNode;
  title?: string;
  onClick?: () => void;
  expanded?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** Tint the icon and PR link in the merged colour (an opened PR once merged). */
  merged?: boolean;
  children: React.ReactNode;
}) {
  const content = (
    <>
      <span className="studio-env-icon">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      {right && <span className="studio-env-right">{right}</span>}
    </>
  );
  if (!onClick) {
    return (
      <div title={title} className={cn("studio-env-row", merged && "is-merged")}>
        {content}
      </div>
    );
  }
  // Busy is not disabled: the button keeps its focus and just ignores clicks.
  return (
    <button
      ref={ref}
      type="button"
      onClick={busy ? undefined : onClick}
      title={title}
      aria-expanded={expanded}
      aria-busy={busy || undefined}
      disabled={disabled}
      className="studio-env-row is-action disabled:cursor-not-allowed disabled:opacity-50"
    >
      {content}
    </button>
  );
}
