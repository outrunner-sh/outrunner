"use client";

import { useSyncExternalStore } from "react";

import type { ResourceSnapshot, SharedResource } from "@/lib/client/shared-resource";

/** What a {@link SharedResource} holds now, re-rendering as it changes. */
export function useSharedResource<T>(resource: SharedResource<T>): ResourceSnapshot<T> {
  return useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getServerSnapshot);
}
