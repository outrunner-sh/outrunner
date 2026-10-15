/**
 * Whether a new session can run on This Mac. Off, new sessions run in the
 * cloud, the new-session screen offers no Cloud/This Mac choice, and a Mac
 * folder in the sidebar offers no new session; sessions already on a Mac
 * still open and run.
 */
export const LOCAL_SESSIONS = true;

/**
 * Whether onboarding offers This Mac. Off: first run sets up the cloud, and a
 * Mac session is set up from the new-session screen the first time This Mac
 * is chosen there.
 */
export const LOCAL_IN_ONBOARDING = false;
