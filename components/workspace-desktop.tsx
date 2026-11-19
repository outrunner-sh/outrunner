"use client";

import type RFB from "@novnc/novnc";
import { Maximize2, Minimize2, MousePointer2, PanelRightClose, RotateCw } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";

import { Spinner } from "@/components/ui/loaders";
import { CONNECT_TIMEOUT_MS, desktopView, FIRST_VIEW, inUseReporter, openDesktop } from "@/lib/session/desktop-view";
import { cn } from "@/lib/utils";

/** noVNC's client, loaded once for the page. It touches `window` as it
 *  loads (and waits on the browser's video decoders at its top level), so it
 *  is loaded in the browser only, when a Desktop tab first opens. A failed
 *  load is kept: the browser would give the same failure again until the
 *  page is reloaded. */
let noVnc: Promise<typeof import("@novnc/novnc")> | null = null;
function loadNoVnc(): Promise<typeof import("@novnc/novnc")> {
  noVnc ??= import("@novnc/novnc");
  // Awaited only once there is a link: a failure before then is not unhandled.
  noVnc.catch(() => {});
  return noVnc;
}

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
    // Fetched alongside the link rather than after it.
    const loading = loadNoVnc();
    let stall: ReturnType<typeof setTimeout> | undefined;
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
        return send({ type: "viewerfailed" });
      }
      // Scaled down to fit the pane, never the desktop resized to it: the
      // agent's screenshots and clicks are in the desktop's own pixels.
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.viewOnly = !interacting.current;
      rfb.background = "transparent";
      // A socket that opens but never finishes the handshake would keep the
      // spinner up for good: given up on, it offers Reconnect.
      stall = setTimeout(() => {
        send({ type: "stalled" });
        if (!closed) rfb?.disconnect();
      }, CONNECT_TIMEOUT_MS);
      rfb.addEventListener("connect", () => {
        clearTimeout(stall);
        send({ type: "connect" });
      });
      rfb.addEventListener("disconnect", (event) => {
        closed = true;
        clearTimeout(stall);
        send({ type: "disconnect", clean: event.detail.clean });
      });
      rfb.addEventListener("securityfailure", (event) => send({ type: "securityfailure", reason: event.detail.reason }));
      client.current = rfb;
    })();
    return () => {
      live = false;
      clearTimeout(stall);
      client.current = null;
      if (!closed) rfb?.disconnect();
    };
  }, [workspaceId, isReady, view.attempt]);

  // While the user drives (Interact on, the desktop live), their moves on it
  // tell the agent's desktop tools to wait for them: caught on the way down
  // to noVNC's canvas, which keeps the events for itself.
  const connected = view.status === "connected";
  useEffect(() => {
    const target = screen.current;
    if (!interact || !connected || !target) return;
    const report = inUseReporter(workspaceId);
    const moves = ["pointerdown", "pointermove", "wheel", "keydown"] as const;
    for (const type of moves) target.addEventListener(type, report, { capture: true, passive: true });
    return () => {
      for (const type of moves) target.removeEventListener(type, report, { capture: true });
    };
  }, [interact, connected, workspaceId]);

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
            {/* A viewer that didn't load stays failed until the page loads
                again: the browser keeps a failed import for the page's life. */}
            {view.status === "error" && view.reload ? (
              <button type="button" onClick={() => window.location.reload()} className="studio-desktop-toggle">
                <RotateCw />
                Reload
              </button>
            ) : (
              <button type="button" onClick={reconnect} className="studio-desktop-toggle">
                <RotateCw />
                {view.status === "error" ? "Try again" : "Reconnect"}
              </button>
            )}
          </div>
        ) : null}
      </div>

      <p className="studio-desktop-note">
        The session&apos;s desktop, where the agent&apos;s browser and desktop tools run. View only until you choose Interact.
      </p>
    </div>
  );
}
