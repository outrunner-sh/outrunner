"use client";

import { useEffect, type ComponentProps } from "react";

import { Automations } from "@/components/automations";
import { AutomationsLoading } from "@/components/automations-loading";
import { keptPage } from "@/lib/client/kept-page";

type AutomationsData = ComponentProps<typeof Automations>;

function isAutomationsData(value: unknown): value is AutomationsData {
  const data = value as AutomationsData | null;
  return (
    typeof data?.org?.id === "string" &&
    typeof data.org.name === "string" &&
    (data.automations === null || Array.isArray(data.automations)) &&
    (data.runs === null || Array.isArray(data.runs)) &&
    (data.installations === null || Array.isArray(data.installations)) &&
    typeof data.runsLimit === "number" &&
    Array.isArray(data.templates)
  );
}

/** The Automations page as it was last shown, for every run (no `?trigger=`),
 *  so a visit paints it at once (lib/client/kept-page.ts). */
const KEPT_AUTOMATIONS = keptPage<AutomationsData>("automations", 1, isAutomationsData);

/** The server's answer: shown, and kept for the next visit when it is the
 *  page's own view of every run. */
export function ServedAutomations(props: AutomationsData) {
  useEffect(() => {
    if (props.runKind === null) KEPT_AUTOMATIONS.remember(props);
  }, [props]);
  return <Automations {...props} />;
}

/** While the server reads the org's automations: what the page last showed,
 *  else its skeleton. Only for the page's own view — one narrowed to a kind of
 *  trigger lists other runs. */
export function KeptAutomations() {
  const kept = KEPT_AUTOMATIONS.useKept();
  // `kept` is null in a server render: location is only read in the browser.
  const narrowed = kept !== null && new URLSearchParams(window.location.search).has("trigger");
  return kept && !narrowed ? <Automations {...kept} /> : <AutomationsLoading />;
}
