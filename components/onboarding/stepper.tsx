import { Check } from "lucide-react";
import { Fragment } from "react";

import { cn } from "@/lib/utils";

/**
 * Where the user is in onboarding: each step a dot, ticked once done, joined
 * by lines, as Replicas' onboarding shows. A done step can be gone back to.
 */
export function Stepper<Id extends string>({
  steps,
  current,
  done,
  onGo,
}: {
  steps: { id: Id; label: string }[];
  current: Id;
  done: ReadonlySet<Id>;
  onGo: (id: Id) => void;
}) {
  return (
    <ol className="flex items-center justify-center gap-3" aria-label="Setup steps">
      {steps.map(({ id, label }, index) => {
        const isDone = done.has(id) && id !== current;
        const isCurrent = id === current;
        return (
          <Fragment key={id}>
            {index > 0 && (
              <li aria-hidden className={cn("h-px w-10 sm:w-16", done.has(steps[index - 1].id) ? "bg-success/70" : "bg-border")} />
            )}
            <li>
              <button
                type="button"
                disabled={!isDone}
                onClick={() => onGo(id)}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2 text-xs transition-colors",
                  isCurrent ? "text-foreground" : isDone ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground/60",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full border",
                    isDone && "border-success bg-success text-background",
                    isCurrent && "border-success",
                    !isDone && !isCurrent && "border-border",
                  )}
                >
                  {isDone ? <Check className="size-3" strokeWidth={3} /> : isCurrent && <span className="bg-success size-2 rounded-full" />}
                </span>
                {label}
              </button>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
