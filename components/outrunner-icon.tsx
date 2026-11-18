import type { SVGProps } from "react";

/** The small-size brand mark from public/brand/mark-small.svg. */
export function OutrunnerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M 11.87 18.93 A 24.0 24.0 0 1 1 8.82 38.21" strokeWidth="7.5" />
      <path d="M 19.76 26.29 A 13.5 13.5 0 1 1 22.79 41.87" strokeWidth="5.0" />
    </svg>
  );
}
