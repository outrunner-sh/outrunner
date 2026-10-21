"use client";

/**
 * The last resort, when the root layout itself fails: it replaces the whole
 * document, so it brings its own <html> and plain styles (the app's CSS may be
 * what failed).
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
        <div style={{ textAlign: "center" }}>
          <p style={{ margin: "0 0 4px", fontWeight: 500 }}>Outrunner could not start</p>
          <p style={{ margin: "0 0 16px", color: "#8a8a8a" }}>Reloading usually fixes it.</p>
          <button
            type="button"
            onClick={reset}
            style={{ padding: "8px 14px", border: 0, borderRadius: 8, background: "#ededed", color: "#0a0a0a", cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
