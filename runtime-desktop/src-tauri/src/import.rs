//! Moving this Mac's sessions to the cloud. `runtime-agent import` finds them
//! (Conductor's, Claude Code's and Codex's own, Outrunner's local ones) and
//! captures one, uploading it where the web app's import plan says. It runs as
//! a process that reads the user's home and exits: nothing listens.
//!
//! The page is a remote origin, so this is the boundary: it names a session by
//! the key a scan gave it, never a path, and each upload URL must be Outrunner's
//! snapshot storage, so no page can send the user's code anywhere else.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

use regex::Regex;

use crate::local_runtime::{agent_binary, last_lines, random_hex, user_command};

/// `runtime-agent import`'s exit code for a session that can't be imported:
/// its stdout says why, as `{"skip": {...}}`.
const EXIT_SKIPPED: i32 = 3;

/// The artifact kinds a capture uploads.
const ARTIFACT_KINDS: [&str; 4] = ["bundle", "patch", "conversation", "rollout"];

/// Where signed upload URLs for imported sessions point, in the snapshot bucket.
const UPLOAD_PATH: &str = "/storage/v1/object/upload/sign/workspace-snapshots/archives/";

/// Outrunner's own storage host. Pinned to the one project, not to
/// `*.supabase.co`: anyone can create a Supabase project, so a suffix match
/// would let a page that got into the window upload the user's code to a
/// bucket of their own. `OUTRUNNER_STORAGE_HOST` overrides it, for a custom
/// domain or another project (a staging one, or a developer's).
const STORAGE_HOST: &str = "butbnitdpiehgwqggowr.supabase.co";

/// The host uploads may go to.
fn storage_host() -> String {
    if let Ok(host) = std::env::var("OUTRUNNER_STORAGE_HOST") {
        if !host.trim().is_empty() {
            return host.trim().to_string();
        }
    }
    STORAGE_HOST.to_string()
}

/// Every session on this Mac that could move to the cloud, and why any can't.
#[tauri::command]
pub async fn import_scan() -> Result<serde_json::Value, String> {
    run_import(vec!["scan".into()], None).await
}

/// Capture the session with `key` and upload it to `uploads` (a signed URL per
/// artifact kind). Returns the capture, or `{"skip": ...}` when it can't come.
#[tauri::command]
pub async fn import_session(key: String, uploads: HashMap<String, String>) -> Result<serde_json::Value, String> {
    if !valid_key(&key) {
        return Err("invalid-session-key".into());
    }
    check_uploads(&uploads, &storage_host())?;
    let out = std::env::temp_dir().join(format!("outrunner-import-{}", random_hex(8)));
    create_private_dir(&out)?;
    let _cleanup = RemoveOnDrop(out.clone());
    let stdin = serde_json::to_vec(&uploads).map_err(|e| e.to_string())?;
    let args = vec![
        "capture".into(),
        "--key".into(),
        key,
        "--out".into(),
        out.to_string_lossy().into_owned(),
        "--upload".into(),
    ];
    run_import(args, Some(stdin)).await
}

/// Run `runtime-agent import <args>` off the async runtime, feeding `stdin`.
async fn run_import(args: Vec<String>, stdin: Option<Vec<u8>>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = user_command(agent_binary()?);
        command
            .arg("import")
            .args(&args)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| format!("import-failed: {e}"))?;
        if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
            pipe.write_all(&input).map_err(|e| format!("import-failed: {e}"))?;
        }
        let output = child.wait_with_output().map_err(|e| format!("import-failed: {e}"))?;
        match output.status.code() {
            Some(0) | Some(EXIT_SKIPPED) => {
                serde_json::from_slice(&output.stdout).map_err(|e| format!("import-failed: {e}"))
            }
            _ => Err(format!("import-failed: {}", last_lines(&String::from_utf8_lossy(&output.stderr), 3))),
        }
    })
    .await
    .map_err(|e| format!("import-failed: {e}"))?
}

/// A session key as a scan gives one: "<agent>:<session id>".
fn valid_key(key: &str) -> bool {
    static KEY: OnceLock<Regex> = OnceLock::new();
    KEY.get_or_init(|| Regex::new(r"^(claude|codex):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$").unwrap())
        .is_match(key)
}

/// Each upload is for an artifact a capture makes, to Outrunner's storage.
fn check_uploads(uploads: &HashMap<String, String>, storage_host: &str) -> Result<(), String> {
    if uploads.is_empty() {
        return Err("no-uploads".into());
    }
    for (kind, url) in uploads {
        if !ARTIFACT_KINDS.contains(&kind.as_str()) {
            return Err(format!("unknown-artifact: {kind}"));
        }
        if !allowed_upload_to(url, storage_host) {
            return Err(format!("upload-not-allowed: {kind}"));
        }
    }
    Ok(())
}

/// A signed upload URL into the snapshot bucket on `storage_host`, Outrunner's
/// own (see [`storage_host`]); a debug build also takes a local Supabase.
/// Nothing that could step out of the bucket's archives. The host is passed
/// in rather than read here, so this tests without the process environment.
fn allowed_upload_to(raw: &str, storage_host: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default();
    let storage = match url.scheme() {
        "https" => !storage_host.is_empty() && host == storage_host,
        "http" => cfg!(debug_assertions) && matches!(host, "127.0.0.1" | "localhost"),
        _ => false,
    };
    let path = url.path();
    storage
        && url.username().is_empty()
        && path.starts_with(UPLOAD_PATH)
        && !path.to_ascii_lowercase().contains("%2e")
        && !path.split('/').any(|segment| segment == ".." || segment == ".")
}

/// A folder only the user can read: the capture writes their code there.
fn create_private_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(dir).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir(dir).map_err(|e| e.to_string())
    }
}

/// Removes a capture's folder however the import ends.
struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_only_scan_keys() {
        assert!(valid_key("claude:b52b847e-3fe0-4bba-98c7-15c157a7f6d4"));
        assert!(valid_key("codex:0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000"));
        for bad in ["claude:../../etc/passwd", "claude:", "gpt:abc", "claude:a b", "--key", "claude:-x"] {
            assert!(!valid_key(bad), "{bad}");
        }
    }

    #[test]
    fn uploads_go_only_to_the_snapshot_bucket() {
        let ok = "https://abc.supabase.co/storage/v1/object/upload/sign/workspace-snapshots/archives/u/w/t/conversation.jsonl?token=x";
        assert!(allowed_upload_to(ok, "abc.supabase.co"));
        for bad in [
            "https://evil.example/storage/v1/object/upload/sign/workspace-snapshots/archives/u/w/t/x",
            "https://abc.supabase.co.evil.example/storage/v1/object/upload/sign/workspace-snapshots/archives/x",
            "http://abc.supabase.co/storage/v1/object/upload/sign/workspace-snapshots/archives/x",
            "https://abc.supabase.co/storage/v1/object/upload/sign/attachments/x",
            "https://abc.supabase.co/storage/v1/object/upload/sign/workspace-snapshots/archives/%2E%2E/x",
            "https://user@abc.supabase.co/storage/v1/object/upload/sign/workspace-snapshots/archives/x",
            "file:///etc/passwd",
        ] {
            assert!(!allowed_upload_to(bad, "abc.supabase.co"), "{bad}");
        }
        // Only the one configured project, not any Supabase one: anyone can
        // make a project, so a page that got into the window must not be able
        // to name theirs.
        assert!(!allowed_upload_to(ok, STORAGE_HOST), "another project's bucket");
        assert!(!allowed_upload_to(ok, ""), "no host configured");
        let mine = ok.replace("abc.supabase.co", STORAGE_HOST);
        assert!(allowed_upload_to(&mine, STORAGE_HOST));
    }

    #[test]
    fn uploads_are_for_an_artifact_a_capture_makes() {
        let host = "abc.supabase.co";
        let mine = format!("https://{host}{UPLOAD_PATH}u/w/t/conversation.jsonl?token=x");
        let one = |kind: &str| HashMap::from([(kind.to_string(), mine.clone())]);
        assert!(check_uploads(&one("conversation"), host).is_ok());
        assert!(check_uploads(&one("ssh-key"), host).is_err());
        assert!(check_uploads(&one("conversation"), "other.supabase.co").is_err());
        assert!(check_uploads(&HashMap::new(), host).is_err());
    }
}
