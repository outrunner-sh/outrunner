"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/loaders";
import { requestJson } from "@/lib/http/request-json";
import { KIND_LABEL, NOTIFICATION_KINDS, type NotificationKind, type NotificationPreferences } from "@/lib/notifications/events";
import { askPermission, notificationPermission, type Permission } from "@/lib/notifications/show";
import { cn } from "@/lib/utils";

type Loaded = { preferences: NotificationPreferences; emailAvailable: boolean; slackLinked: boolean };

const EMAIL_CHOICES: Array<{ value: NotificationPreferences["email"]; label: string; detail: string }> = [
  { value: "off", label: "Off", detail: "No email." },
  { value: "instant", label: "Each one", detail: "An email a minute after each, unless you've seen the session by then." },
  { value: "digest", label: "Daily digest", detail: "One email a day with what you haven't seen." },
];

/**
 * Settings → Account → Notifications: where to hear that a session's turn
 * finished, it needs you or errored, or its pull request opened or merged.
 * In the browser and the Mac app (on by default; the browser asks once), by
 * email (off by default), by Slack DM (once Slack is linked), and which of
 * those events. Each change saves as it's made.
 */
export function NotificationSettings() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [permission, setPermission] = useState<Permission | null>(null);

  useEffect(() => {
    requestJson<Loaded>("/api/settings/notifications", { fallback: "Couldn't load your notification settings." })
      .then(setLoaded)
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Couldn't load them."));
    void notificationPermission().then(setPermission);
  }, []);

  const save = async (change: Partial<NotificationPreferences>) => {
    if (!loaded) return;
    const before = loaded;
    setLoaded({ ...loaded, preferences: { ...loaded.preferences, ...change } });
    setSaving(true);
    setError(null);
    try {
      const { preferences } = await requestJson<{ preferences: NotificationPreferences }>("/api/settings/notifications", {
        method: "PUT",
        body: change,
      });
      setLoaded((current) => (current ? { ...current, preferences } : current));
    } catch (saveError) {
      setLoaded(before);
      setError(saveError instanceof Error ? saveError.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <div className="space-y-3">
        <SectionHeader title="Notifications" />
        {error ? <p className="text-xs text-destructive">{error}</p> : <Spinner label="Loading notification settings" />}
      </div>
    );
  }
  const { preferences, emailAvailable, slackLinked } = loaded;
  const toggleKind = (kind: NotificationKind) =>
    void save({
      kinds: preferences.kinds.includes(kind) ? preferences.kinds.filter((k) => k !== kind) : [...preferences.kinds, kind],
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <SectionHeader title="Notifications" />
        {saving && <Spinner label="Saving" className="size-3 text-muted-foreground" />}
      </div>

      <div className="divide-y divide-border/60 rounded-lg border border-border/60 text-[13px]">
        <Row
          title="Browser and Mac app"
          detail="As it happens, except for the session you're looking at."
          control={<Switch on={preferences.browser} label="Browser and Mac app notifications" onChange={(on) => void save({ browser: on })} />}
        >
          {preferences.browser && permission !== null && permission !== "granted" && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              {permission === "default" && (
                <>
                  <span>This browser hasn&apos;t been allowed to show them yet.</span>
                  <Button size="sm" variant="outline" onClick={() => void askPermission().then(setPermission)}>
                    Allow notifications
                  </Button>
                </>
              )}
              {permission === "denied" && <span>This browser blocks them for Outrunner: allow them in its site settings.</span>}
              {permission === "unsupported" && <span>This browser can&apos;t show them; update the Mac app for its own.</span>}
            </div>
          )}
        </Row>

        <Row
          title="Email"
          detail={emailAvailable ? EMAIL_CHOICES.find((c) => c.value === preferences.email)?.detail : "This deployment doesn't send email."}
          control={
            <div role="radiogroup" aria-label="Email notifications" className="flex rounded-md border border-border/60 p-0.5">
              {EMAIL_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  role="radio"
                  aria-checked={preferences.email === choice.value}
                  disabled={!emailAvailable && choice.value !== "off"}
                  onClick={() => void save({ email: choice.value })}
                  className={cn(
                    "rounded px-2 py-0.5 text-xs transition-colors disabled:opacity-40",
                    preferences.email === choice.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          }
        />

        <Row
          title="Slack DM"
          detail={
            slackLinked ? (
              "A message from Outrunner in Slack, a minute after each, unless you've seen the session by then."
            ) : (
              <>
                Link your Slack account in{" "}
                <Link href="/settings/integrations" className="underline underline-offset-2 hover:text-foreground">
                  Connections
                </Link>{" "}
                first.
              </>
            )
          }
          control={
            <Switch
              on={preferences.slack && slackLinked}
              disabled={!slackLinked}
              label="Slack DM notifications"
              onChange={(on) => void save({ slack: on })}
            />
          }
        />
      </div>

      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-xs text-muted-foreground">Tell me when</legend>
        {NOTIFICATION_KINDS.map((kind) => (
          <label key={kind} className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-foreground/85">
            <input
              type="checkbox"
              checked={preferences.kinds.includes(kind)}
              onChange={() => toggleKind(kind)}
              className="size-3.5 accent-foreground"
            />
            {KIND_LABEL[kind]}
          </label>
        ))}
      </fieldset>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function Row({
  title,
  detail,
  control,
  children,
}: {
  title: string;
  detail?: React.ReactNode;
  control: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-foreground">{title}</p>
          {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </div>
        <div className="shrink-0">{control}</div>
      </div>
      {children}
    </div>
  );
}

function Switch({ on, label, disabled = false, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="flex items-center disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span aria-hidden className={cn("relative h-4 w-7 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")}>
        <span className={cn("absolute top-0.5 size-3 rounded-full bg-background transition-[left]", on ? "left-3.5" : "left-0.5")} />
      </span>
    </button>
  );
}
