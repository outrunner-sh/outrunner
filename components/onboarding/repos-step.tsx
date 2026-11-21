"use client";

import { RepositoryPicker } from "@/components/repository-picker";
import { MAX_REPOS } from "@/lib/environments/rules";
import type { OnboardingEnv } from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";

/**
 * Step 3: the repositories the org works on, picked with the app's one
 * repository picker (components/repository-picker.tsx), which connects them.
 * They go in the environment the next step makes, so as many as one holds.
 */
export function ReposStep({ env, onDone }: { env: OnboardingEnv; onDone: (projects: Project[]) => void }) {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Pick your repositories</h1>
        <p className="text-muted-foreground text-sm">
          The ones {env.org.name} will work on, up to {MAX_REPOS}. Sessions clone them on their own cloud
          computer.
        </p>
      </div>
      <RepositoryPicker max={MAX_REPOS} submitLabel="Continue" onPicked={async (projects) => onDone(projects)} />
    </section>
  );
}
