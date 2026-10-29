"use client";

import { useEffect, useState } from "react";

import { requestJson } from "@/lib/http/request-json";
import { type ChatPreferences, DEFAULT_CHAT_PREFERENCES } from "@/lib/session/chat-preferences";

/** The user's chat preferences as last read here, shared by every session
 *  page in the tab: read once, again after Settings changes them. */
let read: Promise<ChatPreferences> | null = null;

/** Read them again on the next page that asks (Settings saved a change). */
export function forgetChatPreferences(): void {
  read = null;
}

/** The user's chat preferences: the defaults until they are read, and where
 *  they can't be (a local session's page reads them all the same). */
export function useChatPreferences(): ChatPreferences {
  const [preferences, setPreferences] = useState<ChatPreferences>(DEFAULT_CHAT_PREFERENCES);
  useEffect(() => {
    let live = true;
    read ??= requestJson<{ preferences: ChatPreferences }>("/api/settings/chat")
      .then(({ preferences }) => preferences)
      .catch(() => {
        read = null; // asked again by the next page
        return DEFAULT_CHAT_PREFERENCES;
      });
    void read.then((value) => live && setPreferences(value));
    return () => {
      live = false;
    };
  }, []);
  return preferences;
}
