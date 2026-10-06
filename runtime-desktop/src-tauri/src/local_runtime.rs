// Local sessions: Claude Code running on this Mac, driven from the hosted UI.
//
// The web app talks to a cloud session's agent directly, but it cannot reach a
// local one: WKWebView treats `http://` and `ws://` to 127.0.0.1 from an https
// page as mixed content and blocks them (Safari is the only engine that does).
// So the shell owns the local agent end to end. It starts the bundled
// runtime-agent on loopback with a secret only it holds, mints the agent's
// tokens itself, and relays the page's HTTP calls and WebSockets over IPC.
//
// Nothing else can drive it: the agent listens on 127.0.0.1 only and refuses
// any request without a token signed by that secret.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// tmux server name for local sessions, so they never mix with the user's own.
const TMUX_SOCKET: &str = "outrunner";
/// Local sessions ask before shell commands; edits are auto-accepted. The cloud
/// default (bypassPermissions) would hand Claude this machine's keys and
/// credentials with no prompt at all.
const PERMISSION_MODE: &str = "acceptEdits";
/// Lifetime of a minted agent token, matching the control plane's.
const TOKEN_TTL_SECONDS: u64 = 300;
/// Covers the slowest relayed call: create (a base-branch fetch, capped at 30s
/// by the agent) and start (Claude's TUI, capped at 15s).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

/// Managed state: the agent process and the open relayed sockets.
#[derive(Default)]
pub struct LocalRuntime {
    agent: tokio::sync::Mutex<Option<Agent>>,
    sockets: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Outbound>>>>,
    next_socket: AtomicU32,
}

struct Agent {
    child: Child,
    addr: String,
    secret: String,
}

/// What a relay call needs from the running agent.
struct AgentHandle {
    addr: String,
    secret: String,
}

enum Outbound {
    Text(String),
    Close,
}

impl LocalRuntime {
    /// The running agent, started on first use and restarted if it died.
    async fn agent(&self) -> Result<AgentHandle, String> {
        let mut guard = self.agent.lock().await;
        if let Some(agent) = guard.as_mut() {
            if matches!(agent.child.try_wait(), Ok(None)) {
                return Ok(AgentHandle { addr: agent.addr.clone(), secret: agent.secret.clone() });
            }
        }
        let agent = tauri::async_runtime::spawn_blocking(spawn_agent)
            .await
            .map_err(|error| error.to_string())??;
        let handle = AgentHandle { addr: agent.addr.clone(), secret: agent.secret.clone() };
        *guard = Some(agent);
        Ok(handle)
    }

    /// Stop the agent on quit. tmux keeps the sessions — and Claude — running,
    /// so work carries on and the next launch reattaches.
    pub fn shutdown(&self) {
        self.close_all_sockets();
        if let Ok(mut guard) = self.agent.try_lock() {
            if let Some(mut agent) = guard.take() {
                let _ = agent.child.kill();
                let _ = agent.child.wait();
            }
        }
    }

    /// Close every relayed socket. Called when the page reloads: its sockets'
    /// JavaScript ends are gone, and a leaked PTY relay would keep holding the
    /// terminal's single writer slot, leaving the reloaded page read-only.
    pub fn close_all_sockets(&self) {
        let mut sockets = self.sockets.lock().unwrap();
        for (_, socket) in sockets.drain() {
            let _ = socket.send(Outbound::Close);
        }
    }
}

// ---------------------------------------------------------------------------
// Agent process
// ---------------------------------------------------------------------------

/// Where the agent keeps worktrees, casts and workspace facts.
fn root_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("no-home")?;
    Ok(PathBuf::from(home).join(".outrunner"))
}

/// The bundled agent: Tauri places the `binaries/runtime-agent` sidecar next to
/// the app's own executable, in the bundle and under `tauri dev` alike.
/// `OUTRUNNER_AGENT_BINARY` overrides it for development.
fn agent_binary() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("OUTRUNNER_AGENT_BINARY") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path.trim()));
        }
    }
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let path = exe.parent().ok_or("agent-missing")?.join("runtime-agent");
    if path.is_file() {
        Ok(path)
    } else {
        Err("agent-missing".into())
    }
}

fn spawn_agent() -> Result<Agent, String> {
    let binary = agent_binary()?;
    let root = root_dir()?;
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("agent.log"))
        .map_err(|error| error.to_string())?;
    let secret = random_hex(32);

    let mut command = Command::new(&binary);
    // A clean environment: the agent passes its own on to every Claude session,
    // so only what a terminal session would have goes in.
    command.env_clear();
    for key in ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("PATH", session_path())
        // A GUI app gets no locale, and tmux without a UTF-8 one draws Claude's
        // prompt glyph as `_` — which is also what the agent waits for.
        .env("LANG", utf8_locale())
        // `tmux attach` refuses to run without a terminal type.
        .env("TERM", "xterm-256color")
        .env("RUNTIME_AGENT_SECRET", &secret)
        .env("RUNTIME_AGENT_ROOT", &root)
        .env("HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("RUNTIME_TMUX_SOCKET", TMUX_SOCKET)
        .env("RUNTIME_TMUX_CONFIG", "/dev/null")
        .env("RUNTIME_DEFAULT_PERMISSION_MODE", PERMISSION_MODE)
        .env("RUNTIME_AGENT_EXIT_WITH_PARENT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log));
    let mut child = command.spawn().map_err(|error| format!("agent-spawn-failed: {error}"))?;

    // The agent announces its OS-assigned address on stdout. Keep draining
    // after that so it can never block on a full pipe.
    let stdout = child.stdout.take().ok_or("agent-spawn-failed")?;
    let (found, address) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(addr) = line.strip_prefix("RUNTIME_AGENT_ADDR=") {
                let _ = found.send(addr.trim().to_string());
            }
        }
    });
    match address.recv_timeout(Duration::from_secs(10)) {
        Ok(addr) if addr.starts_with("127.0.0.1:") => Ok(Agent { child, addr, secret }),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            Err("agent-did-not-start".into())
        }
    }
}

fn utf8_locale() -> String {
    match std::env::var("LANG") {
        Ok(lang) if lang.to_ascii_uppercase().contains("UTF-8") => lang,
        _ => "en_US.UTF-8".into(),
    }
}

/// The PATH local sessions run with. A macOS GUI app inherits launchd's minimal
/// PATH, not the user's shell's, so git, tmux and claude from Homebrew or a
/// version manager would all be invisible. Ask the login shell once, and keep
/// the usual prefixes as a floor in case it answers nothing.
fn session_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<String> = login_shell_path()
            .map(|path| path.split(':').filter(|d| !d.is_empty()).map(String::from).collect())
            .unwrap_or_default();
        let home = std::env::var("HOME").unwrap_or_default();
        let floor = [
            format!("{home}/.local/bin"),
            format!("{home}/.claude/local"),
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
            "/usr/bin".into(),
            "/bin".into(),
            "/usr/sbin".into(),
            "/sbin".into(),
        ];
        for dir in floor {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        dirs.join(":")
    })
}

fn login_shell_path() -> Option<String> {
    const MARK: &str = "__OUTRUNNER_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-lic", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // A profile that waits on input, or is just slow, must not hang the app.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    // Profiles print banners; take only what sits between the markers.
    let start = out.find(MARK)? + MARK.len();
    let end = start + out[start..].find(MARK)?;
    Some(out[start..end].to_string())
}

fn which(tool: &str) -> Option<String> {
    session_path()
        .split(':')
        .map(|dir| Path::new(dir).join(tool))
        .find(|candidate| candidate.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Stable id for this Mac, recorded on each local workspace so another device
/// can tell the session is not here.
fn device_id(app: &AppHandle) -> Result<String, String> {
    static ID: OnceLock<String> = OnceLock::new();
    if let Some(id) = ID.get() {
        return Ok(id.clone());
    }
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    let file = dir.join("device-id");
    let id = match std::fs::read_to_string(&file) {
        Ok(existing) if valid_id(existing.trim()) => existing.trim().to_string(),
        _ => {
            let fresh = random_hex(16);
            std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            std::fs::write(&file, &fresh).map_err(|error| error.to_string())?;
            fresh
        }
    };
    Ok(ID.get_or_init(|| id).clone())
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the OS random source is unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Tokens — the same HS256 JWT the control plane mints (lib/runtime/runtime-token.ts)
// and the agent verifies (internal/auth).
// ---------------------------------------------------------------------------

fn mint_token(secret: &str, workspace_id: &str, project_id: &str, computer_id: &str) -> String {
    let exp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
        + TOKEN_TTL_SECONDS;
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let claims = serde_json::json!({
        "workspaceId": workspace_id,
        "projectId": project_id,
        "computerId": computer_id,
        // The agent requires a user; on a single-user Mac it is whoever is
        // signed in to this app, and the agent never acts on it.
        "userId": "desktop",
        "exp": exp,
    });
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
    let signing_input = format!("{header}.{payload}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key");
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{signing_input}.{signature}")
}

/// Ids become path segments and tmux session names on the agent side.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn check_ids(workspace_id: &str, project_id: &str) -> Result<(), String> {
    if valid_id(workspace_id) && valid_id(project_id) {
        Ok(())
    } else {
        Err("invalid-id".into())
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    device_id: String,
    root: String,
    agent_bundled: bool,
    git: Option<String>,
    tmux: Option<String>,
    claude: Option<String>,
}

/// What local sessions need on this Mac and whether it is there, so the UI can
/// name what to install instead of failing on create.
#[tauri::command]
pub async fn local_status(app: AppHandle) -> Result<LocalStatus, String> {
    let device_id = device_id(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(LocalStatus {
            device_id,
            root: root_dir()?.to_string_lossy().into_owned(),
            agent_bundled: agent_binary().is_ok(),
            git: which("git"),
            tmux: which("tmux"),
            claude: which("claude"),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepo {
    /// The repository's top level, even if a subfolder was chosen.
    path: String,
    /// Whether any remote points at the project's GitHub repository.
    matches: bool,
    /// `owner/name` of every remote, to say what was picked when it is wrong.
    remotes: Vec<String>,
}

/// Ask the user for their clone of a project. `None` means they cancelled.
#[tauri::command]
pub async fn local_pick_repo(app: AppHandle, repo_full_name: String) -> Result<Option<LocalRepo>, String> {
    let (picked, folder) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(format!("Choose your clone of {repo_full_name}"))
        .pick_folder(move |choice| {
            let _ = picked.send(choice);
        });
    let Some(folder) = folder.await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || inspect_repo(&path, &repo_full_name))
        .await
        .map_err(|error| error.to_string())?
        .map(Some)
}

/// Re-check a remembered clone: it may have moved, or been re-pointed.
#[tauri::command]
pub async fn local_check_repo(path: String, repo_full_name: String) -> Result<LocalRepo, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_repo(Path::new(&path), &repo_full_name))
        .await
        .map_err(|error| error.to_string())?
}

fn inspect_repo(path: &Path, repo_full_name: &str) -> Result<LocalRepo, String> {
    let top = git_output(path, &["rev-parse", "--show-toplevel"]).ok_or("not-a-repo")?;
    let mut remotes: Vec<String> = git_output(Path::new(&top), &["remote", "-v"])
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .filter_map(repo_slug)
        .collect();
    remotes.sort();
    remotes.dedup();
    let matches = remotes.iter().any(|remote| remote.eq_ignore_ascii_case(repo_full_name));
    Ok(LocalRepo { path: top, matches, remotes })
}

fn git_output(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("PATH", session_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `owner/name` from a remote URL, scp-style (`git@github.com:o/n.git`) or not
/// (`https://github.com/o/n`, `ssh://git@github.com/o/n.git`).
fn repo_slug(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let path = match trimmed.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?.1,
        None => trimmed.split_once(':')?.1,
    };
    let mut parts = path.rsplit('/');
    let name = parts.next()?;
    let owner = parts.next()?;
    (!owner.is_empty() && !name.is_empty()).then(|| format!("{owner}/{name}"))
}

/// The agent routes the page may call, each bound to the workspace its token is
/// for. Archive/restore are absent: local workspaces have no snapshots. Only the
/// change set takes a query (`?path=` for one file's diff).
fn allowed_route(method: &str, path: &str, workspace_id: &str) -> Result<reqwest::Method, String> {
    let (route, query) = match path.split_once('?') {
        Some((route, query)) => (route, Some(query)),
        None => (path, None),
    };
    let segments: Vec<&str> = route.trim_start_matches('/').split('/').collect();
    match (method, segments.as_slice(), query) {
        ("POST", ["workspaces"], None) => Ok(reqwest::Method::POST),
        ("POST", ["workspaces", id, "start" | "stop" | "resume" | "destroy" | "message"], None)
            if *id == workspace_id =>
        {
            Ok(reqwest::Method::POST)
        }
        ("GET", ["workspaces", id, "summary"], None) if *id == workspace_id => Ok(reqwest::Method::GET),
        ("GET", ["workspaces", id, "changes"], query)
            if *id == workspace_id && query.is_none_or(|q| q.starts_with("path=")) =>
        {
            Ok(reqwest::Method::GET)
        }
        _ => Err(format!("route-not-allowed: {method} {path}")),
    }
}

/// Relay one control call to the local agent, authorized for one workspace.
#[tauri::command]
pub async fn local_agent_request(
    app: AppHandle,
    state: State<'_, LocalRuntime>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    workspace_id: String,
    project_id: String,
) -> Result<serde_json::Value, String> {
    check_ids(&workspace_id, &project_id)?;
    let method = allowed_route(&method, &path, &workspace_id)?;
    let agent = state.agent().await?;
    let token = mint_token(&agent.secret, &workspace_id, &project_id, &device_id(&app)?);

    let mut request = http_client()
        .request(method, format!("http://{}{}", agent.addr, path))
        .bearer_auth(token)
        .timeout(REQUEST_TIMEOUT);
    if let Some(mut body) = body {
        // A create that names no mode gets the local default rather than the
        // agent's box default.
        if path == "/workspaces" {
            if let Some(object) = body.as_object_mut() {
                object.entry("permissionMode").or_insert(PERMISSION_MODE.into());
            }
        }
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| format!("agent-unreachable: {error}"))?;
    let status = response.status();
    let value: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if status.is_success() {
        Ok(value)
    } else {
        let message = value
            .pointer("/error/message")
            .and_then(|m| m.as_str())
            .unwrap_or("request failed");
        Err(format!("agent: {message}"))
    }
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// One relayed WebSocket's lifecycle, mirroring the browser WebSocket events
/// the page's session client already handles.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SocketEvent {
    Open,
    Message { data: String },
    Close { code: u16, reason: String },
    Error { message: String },
}

/// Open the PTY or conversation stream for one workspace. Events arrive on
/// `on_event`; the returned id addresses sends and the close.
#[tauri::command]
pub async fn local_socket_open(
    app: AppHandle,
    state: State<'_, LocalRuntime>,
    kind: String,
    workspace_id: String,
    project_id: String,
    last_event_id: Option<String>,
    on_event: Channel<SocketEvent>,
) -> Result<u32, String> {
    check_ids(&workspace_id, &project_id)?;
    let route = match kind.as_str() {
        "pty" => "/pty",
        "events" => "/events-ws",
        _ => return Err(format!("unknown-socket: {kind}")),
    };
    let agent = state.agent().await?;
    let token = mint_token(&agent.secret, &workspace_id, &project_id, &device_id(&app)?);
    let mut url = format!("ws://{}{route}?token={token}", agent.addr);
    if let Some(cursor) = last_event_id.filter(|cursor| !cursor.is_empty()) {
        // The cursor is a byte offset into the conversation log.
        if !cursor.bytes().all(|b| b.is_ascii_digit()) {
            return Err("invalid-cursor".into());
        }
        url.push_str("&lastEventId=");
        url.push_str(&cursor);
    }

    let id = state.next_socket.fetch_add(1, Ordering::SeqCst) + 1;
    let (outbound, commands) = mpsc::unbounded_channel();
    state.sockets.lock().unwrap().insert(id, outbound);
    let sockets = state.sockets.clone();
    tauri::async_runtime::spawn(async move {
        relay(url, commands, on_event).await;
        sockets.lock().unwrap().remove(&id);
    });
    Ok(id)
}

#[tauri::command]
pub fn local_socket_send(state: State<'_, LocalRuntime>, id: u32, data: String) -> Result<(), String> {
    let sockets = state.sockets.lock().unwrap();
    let socket = sockets.get(&id).ok_or("socket-closed")?;
    socket.send(Outbound::Text(data)).map_err(|_| "socket-closed".to_string())
}

#[tauri::command]
pub fn local_socket_close(state: State<'_, LocalRuntime>, id: u32) {
    if let Some(socket) = state.sockets.lock().unwrap().remove(&id) {
        let _ = socket.send(Outbound::Close);
    }
}

async fn relay(url: String, mut commands: mpsc::UnboundedReceiver<Outbound>, events: Channel<SocketEvent>) {
    let stream = match tokio_tungstenite::connect_async(url.as_str()).await {
        Ok((stream, _)) => stream,
        Err(error) => {
            let _ = events.send(SocketEvent::Error { message: error.to_string() });
            let _ = events.send(SocketEvent::Close { code: 1006, reason: String::new() });
            return;
        }
    };
    if events.send(SocketEvent::Open).is_err() {
        return;
    }
    let (mut sink, mut source) = stream.split();
    loop {
        tokio::select! {
            incoming = source.next() => {
                let event = match incoming {
                    Some(Ok(Message::Text(text))) => SocketEvent::Message { data: text.to_string() },
                    Some(Ok(Message::Binary(bytes))) => {
                        SocketEvent::Message { data: String::from_utf8_lossy(&bytes).into_owned() }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame
                            .map(|f| (u16::from(f.code), f.reason.to_string()))
                            .unwrap_or((1005, String::new()));
                        let _ = events.send(SocketEvent::Close { code, reason });
                        return;
                    }
                    // Pings are answered by tungstenite itself.
                    Some(Ok(_)) => continue,
                    Some(Err(error)) => {
                        let _ = events.send(SocketEvent::Error { message: error.to_string() });
                        let _ = events.send(SocketEvent::Close { code: 1006, reason: String::new() });
                        return;
                    }
                    None => {
                        let _ = events.send(SocketEvent::Close { code: 1006, reason: String::new() });
                        return;
                    }
                };
                if events.send(event).is_err() {
                    let _ = sink.send(Message::Close(None)).await;
                    return;
                }
            }
            command = commands.recv() => match command {
                Some(Outbound::Text(text)) => {
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        let _ = events.send(SocketEvent::Close { code: 1006, reason: String::new() });
                        return;
                    }
                }
                Some(Outbound::Close) | None => {
                    let _ = sink.send(Message::Close(None)).await;
                    let _ = events.send(SocketEvent::Close { code: 1000, reason: String::new() });
                    return;
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_slug_reads_every_remote_form() {
        for (url, want) in [
            ("git@github.com:neevai-labs/outrunner.git", "neevai-labs/outrunner"),
            ("https://github.com/neevai-labs/outrunner", "neevai-labs/outrunner"),
            ("https://github.com/neevai-labs/outrunner.git/", "neevai-labs/outrunner"),
            ("ssh://git@github.com/neevai-labs/outrunner.git", "neevai-labs/outrunner"),
        ] {
            assert_eq!(repo_slug(url).as_deref(), Some(want), "{url}");
        }
        assert_eq!(repo_slug("not a url"), None);
    }

    #[test]
    fn routes_are_bound_to_the_tokens_workspace() {
        assert!(allowed_route("POST", "/workspaces", "ws-1").is_ok());
        assert!(allowed_route("POST", "/workspaces/ws-1/start", "ws-1").is_ok());
        assert!(allowed_route("GET", "/workspaces/ws-1/summary", "ws-1").is_ok());
        assert!(allowed_route("GET", "/workspaces/ws-1/changes", "ws-1").is_ok());
        assert!(allowed_route("GET", "/workspaces/ws-1/changes?path=src%2Fa.ts", "ws-1").is_ok());
        assert!(allowed_route("GET", "/workspaces/ws-1/changes?other=1", "ws-1").is_err());
        assert!(allowed_route("POST", "/workspaces/ws-1/start?x=1", "ws-1").is_err());
        // Another workspace's route, an unrelayed action, or a wrong method.
        assert!(allowed_route("POST", "/workspaces/ws-2/stop", "ws-1").is_err());
        assert!(allowed_route("POST", "/workspaces/ws-1/archive", "ws-1").is_err());
        assert!(allowed_route("GET", "/workspaces/ws-1/destroy", "ws-1").is_err());
        assert!(allowed_route("GET", "/health/../workspaces", "ws-1").is_err());
    }

    #[test]
    fn ids_must_be_plain() {
        assert!(valid_id("0f6c1c0e-4a43-4a8e-9f4e-2a8d1c3b5e77"));
        for bad in ["", "../x", "a/b", "a b", "ws:1"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn minted_tokens_have_the_agents_shape() {
        let token = mint_token("secret", "ws-1", "p-1", "dev-1");
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["workspaceId"], "ws-1");
        assert_eq!(claims["computerId"], "dev-1");
        assert!(claims["exp"].as_u64().unwrap() > 0);
        // Same signature the Go verifier computes over header.payload.
        let mut mac = Hmac::<Sha256>::new_from_slice(b"secret").unwrap();
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        assert_eq!(parts[2], URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()));
    }
}
