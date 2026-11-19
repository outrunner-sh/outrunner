/**
 * noVNC's RFB client (@novnc/novnc, plain JavaScript without types), as much
 * of it as the Desktop tab uses (components/workspace-desktop.tsx). Its API:
 * node_modules/@novnc/novnc/docs/API.md.
 */
declare module "@novnc/novnc" {
  export type RFBEvents = {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<{ clean: boolean }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    /** The remote clipboard changed (not sent while view only). */
    clipboard: CustomEvent<{ text: string }>;
  };

  export default class RFB {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: { shared?: boolean; credentials?: { username?: string; password?: string; target?: string }; wsProtocols?: string[] },
    );
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    /** The CSS background around the remote screen. */
    background: string;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    /** Put `text` on the remote clipboard (ignored while view only). */
    clipboardPasteFrom(text: string): void;
    /** Send a key: pressed, released, or (no `down`) both. A null code
     *  sends the keysym alone. */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    addEventListener<K extends keyof RFBEvents>(type: K, listener: (event: RFBEvents[K]) => void): void;
    removeEventListener<K extends keyof RFBEvents>(type: K, listener: (event: RFBEvents[K]) => void): void;
  }
}
