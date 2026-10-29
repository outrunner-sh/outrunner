"use client";

import type RFB from "@novnc/novnc";
import { Maximize2, Minimize2, MousePointer2, PanelRightClose, RotateCw } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";

import { Spinner } from "@/components/ui/loaders";
import { desktopView, FIRST_VIEW, openDesktop } from "@/lib/session/desktop-view";
import { cn } from "@/lib/utils";

/**
 * The session's desktop, live: the box's display, where the agent's browser
 * and desktop tools run, drawn by noVNC's own client from the desktop's VNC
 * proxy. Mounted only while the Desktop tab is open, so the desktop is started
 * when someone looks (the route starts it) and the socket closes when they
 * leave. View only until the user turns Interact on, so a stray click on the
 * pane never lands in what the agent is doing.
 */
export function WorkspaceDesktop({
  workspaceId,
  isReady,
  onClose,
}: {
  workspaceId: string;
  /** The session is running: a stopped box has no desktop to show. */
  isReady: boolean;
  /** Closes the pane; shown where the pane covers the chat (narrow windows). */
  onClose: () => void;
}) {
  const [view, dispatch] = useReducer(desktopView, FIRST_VIEW);
  const [interact, setInteract] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  // Read by a connection as it opens, so a reconnect keeps the user's choice.
  const interacting = useRef(interact);

  // A session that stops takes its desktop with it; once it runs again, the
  // tab connects afresh, from Starting, not from where it was left.
  const [wasReady, setWasReady] = useState(isReady);
  if (wasReady !== isReady) {
    setWasReady(isReady);
    if (isReady) dispatch({ type: "reconnect" });
  }

  // Interact is noVNC's own view-only, set on the live client: no reconnect.
  useEffect(() => {
    interacting.current = interact;
    if (client.current) client.current.viewOnly = !interact;
  }, [interact]);

  // One connection an attempt: a fresh link each time (it lapses in two
  // minutes), the socket closed when the tab closes, the session stops or
  // Reconnect replaces it. Events from a connection already let go are
  // dropped, so a late one can't overwrite its successor's state.
  useEffect(() => {
    if (!isReady) return;
    let live = true;
    let rfb: RFB | null = null;
    // noVNC's client is done once it disconnects; asked again, it logs an error.
    let closed = false;
    const send: typeof dispatch = (event) => {
      if (live) dispatch(event);
    };
    // noVNC touches `window` as it loads (and waits on the browser's video
    // decoders at its top level), so it is fetched here, in the browser only,
    // and alongside the link rather than after it.
    const loading = import("@novnc/novnc");
    // Awaited only once there is a link: a failure before then is not unhandled.
    loading.catch(() => {});
    void (async () => {
      const opened = await openDesktop(workspaceId);
      if (!live) return;
      if (!("url" in opened)) return send(opened);
      send({ type: "opened" });
      try {
        const { default: Client } = await loading;
        if (!live || !screen.current) return;
        rfb = new Client(screen.current, opened.url, { wsProtocols: ["binary"] });
      } catch (error) {
        console.error("Desktop: the viewer didn't start", error);
        return send({ type: "refused", httpStatus: 0, error: "The desktop viewer couldn't load. Please reload the page." });
      }
      // Scaled down to fit the pane, never the desktop resized to it: the
      // agent's screenshots and clicks are in the desktop's own pixels.
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.viewOnly = !interacting.current;
      rfb.background = "transparent";
      rfb.addEventListener("connect", () => send({ type: "connect" }));
      rfb.addEventListener("disconnect", (event) => {
        closed = true;
        send({ type: "disconnect", clean: event.detail.clean });
      });
      rfb.addEventListener("securityfailure", (event) => send({ type: "securityfailure", reason: event.detail.reason }));
      client.current = rfb;
    })();
    return () => {
      live = false;
      client.current = null;
      if (!closed) rfb?.disconnect();
    };
  }, [workspaceId, isReady, view.attempt]);

  // Fullscreen is the browser's, so Esc leaves it without this knowing:
  // the button follows the document, not its own clicks.
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === panel.current && panel.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void panel.current?.requestFullscreen().catch(() => {});
  }

  const connected = view.status === "connected";
  const opening = view.status === "starting" || view.status === "connecting";
  const reconnect = () => dispatch({ type: "reconnect" });

  return (
    <div ref={panel} className="studio-desktop">
      <div className="studio-desktop-bar">
        <span className="studio-desktop-state" aria-live="polite">
          <span className={cn("studio-status", connected ? "is-ready" : isReady && opening && "is-provisioning")} />
          {!isReady ? "Not running" : connected ? "Live" : opening ? "Connecting" : view.status === "error" ? "Unavailable" : "Disconnected"}
        </span>
        <span className="studio-desktop-actions">
          <button
            type="button"
            onClick={() => setInteract((on) => !on)}
            aria-pressed={interact}
            className="studio-desktop-toggle"
            title={interact ? "Back to view only" : "Use the desktop: your mouse and keyboard reach it"}
          >
            <MousePointer2 />
            Interact
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="studio-icon-button"
            title={fullscreen ? "Exit full screen" : "Full screen"}
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button type="button" onClick={onClose} className="studio-env-close" title="Hide desktop" aria-label="Hide desktop">
            <PanelRightClose />
          </button>
        </span>
      </div>

      {/* noVNC draws into the empty box, scaled to fit, and takes its canvas
          out again when the socket closes; the states lie over it, outside
          it, so React and noVNC never share a parent. */}
      <div className={cn("studio-desktop-screen", interact && "is-interacting")}>
        <div ref={screen} className="studio-desktop-canvas" />
        {!isReady ? (
          <div className="studio-desktop-overlay">
            <p>The desktop runs while the session does.</p>
          </div>
        ) : opening ? (
          <div className="studio-desktop-overlay" role="status">
            <Spinner />
            <p>Starting the desktop…</p>
          </div>
        ) : view.status === "disconnected" || view.status === "error" ? (
          <div className="studio-desktop-overlay" role="alert">
            <p>{view.status === "error" ? view.message : view.reason}</p>
            <button type="button" onClick={reconnect} className="studio-desktop-toggle">
              <RotateCw />
              {view.status === "error" ? "Try again" : "Reconnect"}
            </button>
          </div>
        ) : null}
      </div>

      <p className="studio-desktop-note">
        The session&apos;s desktop, where the agent&apos;s browser and desktop tools run. View only until you choose Interact.
      </p>
    </div>
  );
}
