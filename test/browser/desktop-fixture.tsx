"use client";

import { useState } from "react";

import { WorkspaceDesktop } from "@/components/workspace-desktop";

/**
 * The Desktop tab against a stand-in desktop: the route's link answered in
 * the page, and the VNC proxy's socket played by FakeVncSocket, which answers
 * noVNC's handshake (RFB 3.8, no security) so the tab goes live. The page
 * drops the socket on demand, as the box's proxy drops one:
 * `window.__desktop.drop()`; `window.__desktop.links` counts the links asked for.
 */

type Fake = { links: number; sockets: FakeVncSocket[]; drop: () => void };

/** RFB's ServerInit: a 1280×800 true-colour desktop named "desktop". */
function serverInit(): Uint8Array {
  const name = new TextEncoder().encode("desktop");
  const bytes = new Uint8Array(24 + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 1280);
  view.setUint16(2, 800);
  // Pixel format: 32 bpp, depth 24, little-endian, true colour, 255 a channel, shifts 16/8/0.
  bytes.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0], 4);
  view.setUint32(20, name.length);
  bytes.set(name, 24);
  return bytes;
}

class FakeVncSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  protocol = "binary";
  binaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** Where the handshake is: 0 versions, 1 security type, 2 client init, 3 done. */
  private stage = 0;

  constructor(readonly url: string) {
    fake().sockets.push(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.push(new TextEncoder().encode("RFB 003.008\n"));
    }, 50);
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 1) return;
    const size = data.byteLength;
    if (this.stage === 0 && size >= 12) {
      this.stage = 1;
      this.push(new Uint8Array([1, 1])); // one security type: None
    } else if (this.stage === 1) {
      this.stage = 2;
      this.push(new Uint8Array([0, 0, 0, 0])); // SecurityResult: OK
    } else if (this.stage === 2) {
      this.stage = 3;
      this.push(serverInit());
    }
  }

  close(): void {
    this.end(1000, true);
  }

  /** Dropped by the far end, as a proxy drops it. */
  drop(): void {
    this.end(1006, false);
  }

  private end(code: number, wasClean: boolean): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.(new CloseEvent("close", { code, wasClean })), 0);
  }

  private push(bytes: Uint8Array): void {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    setTimeout(() => {
      if (this.readyState === 1) this.onmessage?.(new MessageEvent("message", { data }));
    }, 0);
  }
}

function fake(): Fake {
  return (window as unknown as { __desktop: Fake }).__desktop;
}

/** Put the stand-ins in the page: once, before the tab first connects. */
function install(): void {
  // Rendered on the server first, where there's no page to put them in.
  if (typeof window === "undefined") return;
  const w = window as unknown as { __desktop?: Fake; WebSocket: unknown; fetch: typeof fetch };
  if (w.__desktop) return;
  const state: Fake = {
    links: 0,
    sockets: [],
    drop: () => state.sockets.findLast((s) => s.readyState === 1)?.drop(),
  };
  w.__desktop = state;
  w.WebSocket = FakeVncSocket;
  const realFetch = w.fetch.bind(window);
  w.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/api\/workspaces\/[^/]+\/desktop$/.test(new URL(url, location.href).pathname)) {
      state.links += 1;
      return Response.json({ url: `ws://desktop.test/websockify?link=${state.links}` });
    }
    if (/\/api\/workspaces\/[^/]+\/desktop\//.test(new URL(url, location.href).pathname)) return Response.json({ ok: true });
    return realFetch(input, init);
  };
}

export function DesktopFixture() {
  useState(install);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <WorkspaceDesktop workspaceId="desktop-fixture" isReady onClose={() => {}} />
    </div>
  );
}
