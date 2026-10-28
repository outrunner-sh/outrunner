import { cn } from "@/lib/utils";

/** A small bordered button naming one of an item's properties (its status,
 *  its workspace) that opens a menu to change it. */
export function PropertyChip({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2 text-xs text-foreground/90 transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60 data-[state=open]:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
