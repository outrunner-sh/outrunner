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
    check_uploads(&uploads)?;
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

/// The values of what the user picked of `repo`'s environment on this Mac:
/// Conductor's variables by name, .env files by their path in the checkout,
/// and its scripts. Only what a scan offered is read.
#[tauri::command]
pub async fn import_environment(
    repo: String,
    vars: Vec<String>,
    files: Vec<String>,
    scripts: bool,
) -> Result<serde_json::Value, String> {
    if !valid_repo(&repo) {
        return Err("invalid-repo".into());
    }
    if vars.len() > 500 || files.len() > 100 {
        return Err("too-many".into());
    }
    if let Some(bad) = vars.iter().find(|v| !valid_env_name(v)) {
        return Err(format!("invalid-variable: {bad}"));
    }
    if let Some(bad) = files.iter().find(|f| !valid_checkout_path(f)) {
        return Err(format!("invalid-file: {bad}"));
    }
    let mut args = vec!["env".into(), "--repo".into(), repo];
    if !vars.is_empty() {
        args.extend(["--vars".into(), vars.join(",")]);
    }
    if !files.is_empty() {
        args.extend(["--files".into(), files.join(",")]);
    }
    if scripts {
        args.push("--scripts".into());
    }
    run_import(args, None).await
}

/// A GitHub repository, "owner/name".
fn valid_repo(repo: &str) -> bool {
    static REPO: OnceLock<Regex> = OnceLock::new();
    REPO.get_or_init(|| Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$").unwrap())
        .is_match(repo)
}

/// A variable name as a scan gives one; no comma, which would split it.
fn valid_env_name(name: &str) -> bool {
    static NAME: OnceLock<Regex> = OnceLock::new();
    NAME.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$").unwrap()).is_match(name)
}

/// A relative path that stays in the checkout, with no comma.
fn valid_checkout_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && !path.starts_with('/')
        && !path.contains(',')
        && !path.contains('\0')
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
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
fn check_uploads(uploads: &HashMap<String, String>) -> Result<(), String> {
    if uploads.is_empty() {
        return Err("no-uploads".into());
    }
    for (kind, url) in uploads {
        if !ARTIFACT_KINDS.contains(&kind.as_str()) {
            return Err(format!("unknown-artifact: {kind}"));
        }
        if !allowed_upload(url) {
            return Err(format!("upload-not-allowed: {kind}"));
        }
    }
    Ok(())
}

/// A signed upload URL into the snapshot bucket on Supabase (or on the host
/// `OUTRUNNER_STORAGE_HOST` names, for a custom domain); a debug build also
/// takes a local Supabase. Nothing that could step out of the bucket's
/// archives.
fn allowed_upload(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default();
    let storage = match url.scheme() {
        "https" => {
            host.ends_with(".supabase.co")
                || std::env::var("OUTRUNNER_STORAGE_HOST").is_ok_and(|h| !h.is_empty() && h == host)
        }
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
    fn environment_picks_stay_names_and_checkout_paths() {
        assert!(valid_repo("ada/app.js"));
        assert!(!valid_repo("ada/app;rm") && !valid_repo("../x") && !valid_repo("-x/y"));
        assert!(valid_env_name("DATABASE_URL") && !valid_env_name("A,B") && !valid_env_name("1X"));
        assert!(valid_checkout_path("apps/backend/.env"));
        for bad in ["/etc/passwd", "../.ssh/id_rsa", "a/../../b", "a,b", "./x", "a//b", ""] {
            assert!(!valid_checkout_path(bad), "{bad}");
        }
    }

    #[test]
    fn uploads_go_only_to_the_snapshot_bucket() {
        let ok = "https://abc.supabase.co/storage/v1/object/upload/sign/workspace-snapshots/archives/u/w/t/conversation.jsonl?token=x";
        assert!(allowed_upload(ok));
        for bad in [
            "https://evil.example/storage/v1/object/upload/sign/workspace-snapshots/archives/u/w/t/x",
            "https://abc.supabase.co.evil.example/storage/v1/object/upload/sign/workspace-snapshots/archives/x",
            "http://abc.supabase.co/storage/v1/object/upload/sign/workspace-snapshots/archives/x",
            "https://abc.supabase.co/storage/v1/object/upload/sign/attachments/x",
            "https://abc.supabase.co/storage/v1/object/upload/sign/workspace-snapshots/archives/%2E%2E/x",
            "https://user@abc.supabase.co/storage/v1/object/upload/sign/workspace-snapshots/archives/x",
            "file:///etc/passwd",
        ] {
            assert!(!allowed_upload(bad), "{bad}");
        }
        let uploads = HashMap::from([("conversation".to_string(), ok.to_string())]);
        assert!(check_uploads(&uploads).is_ok());
        let unknown = HashMap::from([("ssh-key".to_string(), ok.to_string())]);
        assert!(check_uploads(&unknown).is_err());
        assert!(check_uploads(&HashMap::new()).is_err());
    }
}
