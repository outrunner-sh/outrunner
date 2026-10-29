/** Shared card and panel outline, with the longer dashes used in onboarding. */
export function DashedFrame() {
  return (
    <svg
      aria-hidden
      // m-0: never spaced as a child of a `space-y` panel.
      className="text-border group-hover:text-foreground/40 pointer-events-none absolute inset-0 m-0 size-full overflow-visible transition-colors"
    >
      <rect width="100%" height="100%" rx="12" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="8 6" />
    </svg>
  );
}
