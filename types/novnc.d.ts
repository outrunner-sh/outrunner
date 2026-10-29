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
    addEventListener<K extends keyof RFBEvents>(type: K, listener: (event: RFBEvents[K]) => void): void;
    removeEventListener<K extends keyof RFBEvents>(type: K, listener: (event: RFBEvents[K]) => void): void;
  }
}
