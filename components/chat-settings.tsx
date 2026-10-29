"use client";

import { useEffect, useState } from "react";

import { Row, Switch } from "@/components/notification-settings";
import { SectionHeader } from "@/components/settings-details";
import { Spinner } from "@/components/ui/loaders";
import { requestJson } from "@/lib/http/request-json";
import { type ChatPreferences } from "@/lib/session/chat-preferences";
import { forgetChatPreferences } from "@/hooks/use-chat-preferences";

/**
 * Settings → Account → Chats: whether a message sent while the agent works
 * steers its turn or waits in the queue. Saves as it's changed.
 */
export function ChatSettings() {
  const [preferences, setPreferences] = useState<ChatPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    requestJson<{ preferences: ChatPreferences }>("/api/settings/chat", { fallback: "Couldn't load your chat settings." })
      .then(({ preferences }) => setPreferences(preferences))
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Couldn't load them."));
  }, []);

  const save = async (change: ChatPreferences) => {
    const before = preferences;
    setPreferences(change);
    setError(null);
    setSaving(true);
    try {
      const saved = await requestJson<{ preferences: ChatPreferences }>("/api/settings/chat", { method: "PUT", body: change });
      setPreferences(saved.preferences);
      forgetChatPreferences();
    } catch (saveError) {
      setPreferences(before);
      setError(saveError instanceof Error ? saveError.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <SectionHeader title="Chats" />
        {saving && <Spinner label="Saving" className="size-3 text-muted-foreground" />}
      </div>
      {preferences ? (
        <div className="divide-y divide-border/60 rounded-lg border border-border/60 text-[13px]">
          <Row
            title="Steer with follow-up messages"
            detail={
              preferences.steerFollowUps
                ? "A message sent while Claude Code works goes into its turn at once, taken in at its next step. Codex's still queue."
                : "A message sent while the agent works waits in the queue until its turn ends."
            }
            control={
              <Switch
                on={preferences.steerFollowUps}
                label="Steer with follow-up messages"
                onChange={(on) => void save({ steerFollowUps: on })}
              />
            }
          />
        </div>
      ) : (
        !error && <Spinner label="Loading chat settings" />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
