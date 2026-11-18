"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";

/**
 * The last resort, when the root layout itself fails: it replaces the whole
 * document, so it brings its own <html> and plain styles (the app's CSS may be
 * what failed).
 */
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    Sentry.captureException(error, { tags: { where: "global-error", digest: error.digest } });
  }, [error]);
  return (
    <html lang="en">
      <body
        style={{
          display: "grid",
          minHeight: "100vh",
          margin: 0,
          placeItems: "center",
          background: "#060505",
          color: "#ededed",
          font: "14px/1.5 system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: 380, padding: "0 24px", textAlign: "center" }}>
          <p style={{ margin: "0 0 4px", fontWeight: 500 }}>Outrunner couldn&apos;t load</p>
          <p style={{ margin: "0 0 16px", color: "#8a8a8a" }}>
            Reloading usually fixes it.
            {error.digest && " If it doesn't, mention the error below when you report it."}
          </p>
          <button
            type="button"
            // A full reload, not reset(): the root layout is what failed, so
            // nothing of this page is worth keeping.
            onClick={() => window.location.reload()}
            style={{ padding: "8px 14px", border: 0, borderRadius: 8, background: "#ededed", color: "#0a0a0a", cursor: "pointer" }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ margin: "16px 0 0", color: "#8a8a8a", font: "12px ui-monospace, monospace" }}>
              error {error.digest}{" "}
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(error.digest!).then(() => setCopied(true))}
                style={{ padding: "0 4px", border: 0, background: "transparent", color: "#ededed", font: "inherit", textDecoration: "underline", cursor: "pointer" }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
