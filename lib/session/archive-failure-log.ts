import { AgentRequestError } from "@/lib/runtime/agent-client";
import type { archiveFailureReport } from "@/lib/session/archive-failure";

type Diagnostic = ReturnType<typeof archiveFailureReport>["diagnostic"];

// These are hints extracted from older agents' messages, never inputs to
// recovery or save decisions. No substring of an arbitrary message is logged.
type LegacyDetail = {
  operation: "git_bundle" | "write_patch" | "staging" | "upload" | "stop_session" | "artifact_io" | "unknown";
  reason: "not_git_repository" | "dubious_ownership" | "empty_bundle" | "storage_http" |
    "no_space" | "read_only_filesystem" | "permission_denied" | "missing_file" |
    "timeout" | "canceled" | "dns" | "connection_refused" | "connection_reset" | "tls" | "unknown";
  artifact?: "conversation" | "cast" | "bundle" | "patch" | "summary" | "manifest" | "rollout" | "chat";
  exitCode?: number;
  httpStatus?: number;
  inputTruncated: boolean;
};

const MAX_INPUT_CHARS = 8192;
const UPLOAD = /^upload (conversation|cast|bundle|patch|summary|manifest|rollout|chats\/[a-zA-Z0-9_-]+\/(?:conversation|rollout)\.jsonl): /;
const SUFFIX_REASONS: readonly [RegExp, LegacyDetail["reason"]][] = [
  [/(?:^|: )no space left on device$/i, "no_space"],
  [/(?:^|: )read-only file system$/i, "read_only_filesystem"],
  [/(?:^|: )permission denied$/i, "permission_denied"],
  [/(?:^|: )no such file or directory$/i, "missing_file"],
  [/(?:^|: )(?:i\/o timeout|context deadline exceeded(?: \(Client\.Timeout exceeded while awaiting headers\))?|net\/http: TLS handshake timeout)$/, "timeout"],
  [/(?:^|: )context canceled$/, "canceled"],
  [/: no such host$/, "dns"],
  [/: (?:connect: )?connection refused$/, "connection_refused"],
  [/: (?:read: )?connection reset by peer$/, "connection_reset"],
  [/: x509: certificate signed by unknown authority$/, "tls"],
];

function legacyDetail(message: string): LegacyDetail {
  const detail: LegacyDetail = { operation: "unknown", reason: "unknown", inputTruncated: message.length > MAX_INPUT_CHARS };
  const text = message.slice(0, MAX_INPUT_CHARS);
  let rest = "";
  // A multi-repository capture prepends a checkout name. Discard it too.
  const bundle = /^(?:[a-zA-Z0-9_.-]{1,100}: )?git bundle: /.exec(text);
  const upload = UPLOAD.exec(text);
  const other = /^(write patch: |snapshot staging dir: |tmux kill-session [^\s:]{1,160}: |(?:open|checksum|marshal) [^:\r\n]{1,128}: )/.exec(text);
  if (bundle) {
    detail.operation = "git_bundle";
    rest = text.slice(bundle[0].length);
  } else if (upload) {
    detail.operation = "upload";
    detail.artifact = upload[1].startsWith("chats/") ? "chat" : upload[1] as LegacyDetail["artifact"];
    rest = text.slice(upload[0].length);
    const status = /^unexpected status ([45][0-9]{2}):/.exec(rest);
    if (status) {
      // Never examine a storage response body for hints.
      return { ...detail, reason: "storage_http", httpStatus: Number(status[1]) };
    }
  } else if (other) {
    detail.operation = other[0].startsWith("write patch:") ? "write_patch"
      : other[0].startsWith("snapshot staging dir:") ? "staging"
        : other[0].startsWith("tmux kill-session ") ? "stop_session" : "artifact_io";
    rest = text.slice(other[0].length);
  } else {
    return detail;
  }

  if (detail.operation === "git_bundle" || detail.operation === "stop_session") {
    const exit = /^exit status ([0-9]{1,3})(?=:|$)/.exec(rest);
    if (exit && Number(exit[1]) <= 255) detail.exitCode = Number(exit[1]);
  }
  if (detail.operation === "git_bundle") {
    const fatal = /^exit status [0-9]{1,3}: fatal: /.exec(rest);
    const why = fatal ? rest.slice(fatal[0].length) : "";
    if (/^not a git repository\b/.test(why)) detail.reason = "not_git_repository";
    else if (/^detected dubious ownership\b/.test(why)) detail.reason = "dubious_ownership";
    else if (/^Refusing to create empty bundle\b/.test(why)) detail.reason = "empty_bundle";
  }
  // A truncated tail is not evidence of the original message's suffix.
  if (detail.reason === "unknown" && !detail.inputTruncated) {
    detail.reason = SUFFIX_REASONS.find(([pattern]) => pattern.test(rest))?.[1] ?? "unknown";
  }
  return detail;
}

/** Server log only. Keep the caller's public report separate: arbitrary legacy
 * details never reach its persisted error, lifecycle JSON or Runner modal.
 * Projection onto a fixed vocabulary removes credentials (even unknown shapes),
 * URLs, private paths and log-injection text rather than trying to mask them.
 * Input work is capped; output has only fixed labels, booleans and small numbers.
 */
export function archiveFailureLog(error: unknown, diagnostic: Diagnostic) {
  if (diagnostic.stage !== "capture" || diagnostic.snapshot ||
      !(error instanceof AgentRequestError) || error.error?.code !== "INTERNAL") return diagnostic;
  return { ...diagnostic, legacy: legacyDetail(error.error.message) };
}
