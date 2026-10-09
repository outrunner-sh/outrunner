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

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
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
/// The workspace claim of the token that lists sessions (the agent's
/// protocol.ListingWorkspaceID).
const LISTING_WORKSPACE_ID: &str = "*";
/// Lifetime of a minted agent token, matching the control plane's.
const TOKEN_TTL_SECONDS: u64 = 300;
/// Covers the slowest relayed call: create (a base-branch fetch, capped at 30s
/// by the agent) and start (Claude's TUI, capped at 15s).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a `claude auth login` may wait for the user to approve in the
/// browser before it is stopped.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Managed state: the agent process, the open relayed sockets, and the folders
/// the user picked in this run.
#[derive(Default)]
pub struct LocalRuntime {
    agent: tokio::sync::Mutex<Option<Agent>>,
    sockets: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Outbound>>>>,
    next_socket: AtomicU32,
    /// Canonical paths chosen in the folder dialog. With the folders existing
    /// sessions work in, these are the only ones the page may name.
    picked: Mutex<HashSet<PathBuf>>,
    /// `claude auth login` in progress, with a number for the attempt, so a
    /// retry, a cancel or quitting the app can stop it.
    login: Mutex<Option<(u32, Child)>>,
    next_login: AtomicU32,
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
        // Exited, or its state could not be read: make sure the old process is
        // gone and reaped before replacing it, so it cannot linger as a zombie or
        // keep listening beside the new one.
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
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
        self.stop_claude_login();
        if let Ok(mut guard) = self.agent.try_lock() {
            if let Some(mut agent) = guard.take() {
                let _ = agent.child.kill();
                let _ = agent.child.wait();
            }
        }
    }

    /// Stop a `claude auth login` in progress, if any. It holds a localhost
    /// port open for the browser's redirect until it ends.
    fn stop_claude_login(&self) {
        let mut login = self.login.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((_, mut child)) = login.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Close every relayed socket. Called when the page reloads: its sockets'
    /// JavaScript ends are gone, and a leaked PTY relay would keep holding the
    /// terminal's single writer slot, leaving the reloaded page read-only.
    pub fn close_all_sockets(&self) {
        let mut sockets = self.sockets.lock().unwrap_or_else(PoisonError::into_inner);
        for (_, socket) in sockets.drain() {
            let _ = socket.send(Outbound::Close);
        }
    }
}

// ---------------------------------------------------------------------------
// Agent process
// ---------------------------------------------------------------------------

/// Where the agent keeps worktrees, casts and workspace facts:
/// `~/.outrunner`, or `OUTRUNNER_ROOT` (development, and the relay's own test).
fn root_dir() -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("OUTRUNNER_ROOT").filter(|r| !r.is_empty()) {
        return Ok(PathBuf::from(root));
    }
    let home = std::env::var_os("HOME").ok_or("no-home")?;
    Ok(PathBuf::from(home).join(".outrunner"))
}

/// A bundled sidecar: Tauri places `binaries/<name>` next to the app's own
/// executable, in the bundle and under `tauri dev` alike. `override_var`
/// replaces it for development.
fn sidecar(override_var: &str, name: &str) -> Option<PathBuf> {
    if let Ok(path) = std::env::var(override_var) {
        if !path.trim().is_empty() {
            return Some(PathBuf::from(path.trim()));
        }
    }
    let path = std::env::current_exe().ok()?.parent()?.join(name);
    path.is_file().then_some(path)
}

/// The bundled agent. `OUTRUNNER_AGENT_BINARY` overrides it.
fn agent_binary() -> Result<PathBuf, String> {
    sidecar("OUTRUNNER_AGENT_BINARY", "runtime-agent").ok_or_else(|| "agent-missing".into())
}

/// The bundled tmux, so local sessions need none installed on the Mac.
/// `OUTRUNNER_TMUX_BINARY` overrides it.
fn bundled_tmux() -> Option<PathBuf> {
    sidecar("OUTRUNNER_TMUX_BINARY", "tmux")
}

fn spawn_agent() -> Result<Agent, String> {
    let binary = agent_binary()?;
    let root = root_dir()?;
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    // Sessions run the `claude` linked here; make sure it is the one that works.
    let _ = find_claude();
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("agent.log"))
        .map_err(|error| error.to_string())?;
    let secret = random_hex(32);

    // The agent passes its environment on to every Claude session.
    let mut command = user_command(&binary);
    command
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
    // Without it, the agent runs whatever tmux is on PATH.
    if let Some(tmux) = bundled_tmux() {
        command.env("RUNTIME_TMUX_BIN", tmux);
    }
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

/// A command with only what a terminal session would have: the user's identity
/// and home, the login-shell PATH and a UTF-8 locale. The agent runs this way,
/// and so its Claude sessions, so the login check and login below use it too:
/// they then see exactly the Claude Code login a session will.
fn user_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
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
        .env("LANG", utf8_locale());
    command
}

/// Wait for `child` up to `limit`; past it, kill it. Whether it exited on its
/// own.
fn exit_within(child: &mut Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Whether Claude Code on this Mac is logged in, as `claude auth status` says.
/// None when it cannot tell: a Claude Code too old to have `auth status`, or
/// one that did not answer in time. The page blocks only on a clear no.
fn claude_logged_in(claude: &str) -> Option<bool> {
    let mut child = user_command(claude)
        .args(["auth", "status", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if !exit_within(&mut child, Duration::from_secs(10)) {
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    // It exits 1 when logged out, so read the answer, not the status.
    parse_logged_in(&out)
}

fn parse_logged_in(out: &str) -> Option<bool> {
    serde_json::from_str::<serde_json::Value>(out).ok()?.get("loggedIn")?.as_bool()
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
/// the usual prefixes as a floor in case it answers nothing. Connect Claude
/// runs `claude setup-token` with it too.
///
/// It starts with the directory where [`find_claude`] links the `claude` that
/// works, so that is the one every session runs.
pub(crate) fn session_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<String> = claude_link_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .into_iter()
            .collect();
        for dir in login_shell_path().unwrap_or_default().split(':').filter(|d| !d.is_empty()) {
            if !dirs.iter().any(|d| d == dir) {
                dirs.push(dir.to_string());
            }
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let floor = [
            format!("{home}/.local/bin"),
            format!("{home}/.claude/local"),
            format!("{home}/.bun/bin"),
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
    if !exit_within(&mut child, Duration::from_secs(5)) {
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    // Profiles print banners; take only what sits between the markers.
    let start = out.find(MARK)? + MARK.len();
    let end = start + out[start..].find(MARK)?;
    Some(out[start..end].to_string())
}

pub(crate) fn which(tool: &str) -> Option<String> {
    session_path()
        .split(':')
        .map(|dir| Path::new(dir).join(tool))
        .find(|candidate| candidate.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Where the `claude` that works is linked, first on [`session_path`].
fn claude_link_dir() -> Option<PathBuf> {
    root_dir().ok().map(|root| root.join("bin"))
}

/// The Claude Code to run on this Mac: the first `claude` on the session PATH,
/// then on the one this app inherited, that answers `--version` as Claude Code.
/// The first one found is not enough: an npm install whose postinstall never
/// ran (`--ignore-scripts`, pnpm) leaves a placeholder `claude` that is not
/// executable, or that only prints "claude native binary not installed", and it
/// can sit on the PATH ahead of an install that works.
///
/// The one found is linked into [`claude_link_dir`], so sessions run it too.
/// Err lists the candidates that didn't run: empty when there was none.
pub(crate) fn find_claude() -> Result<PathBuf, Vec<PathBuf>> {
    let link_dir = claude_link_dir();
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let dirs = session_path()
        .split(':')
        .map(PathBuf::from)
        .chain(std::env::split_paths(&inherited))
        .filter(|dir| Some(dir) != link_dir.as_ref());
    let found = find_claude_in(dirs);
    if let Some(dir) = link_dir {
        match &found {
            Ok(claude) => link_claude(&dir, claude),
            Err(_) => {
                let _ = std::fs::remove_file(dir.join("claude"));
            }
        }
    }
    found
}

fn find_claude_in(dirs: impl Iterator<Item = PathBuf>) -> Result<PathBuf, Vec<PathBuf>> {
    let mut seen = HashSet::new();
    let mut broken = Vec::new();
    for dir in dirs {
        let candidate = dir.join("claude");
        if !candidate.is_file() {
            continue;
        }
        // The same install is often on the PATH twice, by a link and directly.
        if !seen.insert(std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone())) {
            continue;
        }
        if runs_as_claude(&candidate) {
            return Ok(candidate);
        }
        broken.push(candidate);
    }
    Err(broken)
}

/// Whether `claude --version` runs and says it is Claude Code.
fn runs_as_claude(claude: &Path) -> bool {
    let Ok(mut child) = user_command(claude)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    if !exit_within(&mut child, Duration::from_secs(10)) {
        return false;
    }
    let mut out = String::new();
    let read = child.stdout.take().is_some_and(|mut stdout| stdout.read_to_string(&mut out).is_ok());
    read && child.wait().is_ok_and(|status| status.success()) && out.contains("Claude Code")
}

/// Point `dir/claude` at `claude`, replacing what was there in one rename, so a
/// session starting meanwhile finds the old link or the new one, never none.
fn link_claude(dir: &Path, claude: &Path) {
    let link = dir.join("claude");
    if std::fs::read_link(&link).is_ok_and(|target| target == claude) {
        return;
    }
    let staged = dir.join(format!(".claude-{}", random_hex(4)));
    let linked = std::fs::create_dir_all(dir)
        .and_then(|()| std::os::unix::fs::symlink(claude, &staged))
        .and_then(|()| std::fs::rename(&staged, &link));
    if linked.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
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
    /// Whether that Claude Code is logged in; None when it cannot tell.
    claude_logged_in: Option<bool>,
}

/// What local sessions need on this Mac and whether it is there, so the UI can
/// name what to install instead of failing on create.
#[tauri::command]
pub async fn local_status(app: AppHandle) -> Result<LocalStatus, String> {
    let device_id = device_id(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let claude = find_claude().ok().map(|path| path.to_string_lossy().into_owned());
        Ok(LocalStatus {
            device_id,
            root: root_dir()?.to_string_lossy().into_owned(),
            agent_bundled: agent_binary().is_ok(),
            git: which("git"),
            // The one the agent will run: the bundled copy before any on PATH.
            tmux: bundled_tmux()
                .map(|path| path.to_string_lossy().into_owned())
                .or_else(|| which("tmux")),
            claude_logged_in: claude.as_deref().and_then(claude_logged_in),
            claude,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Log Claude Code in on this Mac, for a user who has never run it here, and
/// resolve when that is done. `claude auth login` opens the browser itself, on a
/// link that redirects back to a port it listens on, so approving there finishes
/// the login with nothing to paste. The login lands where Claude Code keeps it,
/// for every local session and the user's own terminal alike; the app never
/// sees it.
///
/// Errors: `claude-missing`; `login-cancelled` when `local_claude_login_cancel`
/// or a newer attempt stopped this one; `login-timed-out`; and
/// `login-failed: <its last lines>` when the CLI exits unsuccessfully, so a
/// failure says why instead of leaving the page waiting.
#[tauri::command]
pub async fn local_claude_login(state: State<'_, LocalRuntime>) -> Result<(), String> {
    let claude = tauri::async_runtime::spawn_blocking(find_claude)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "claude-missing")?;
    run_claude_login(&state, &claude).await
}

/// `local_claude_login` with the binary given, so a test can stand in for it.
async fn run_claude_login(state: &LocalRuntime, claude: &Path) -> Result<(), String> {
    state.stop_claude_login();
    let mut child = user_command(claude)
        .args(["auth", "login"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("login-failed: {error}"))?;
    // Keep what it prints, for the error if it fails; draining both pipes also
    // means it can never block on a full one.
    let output = Arc::new(Mutex::new(String::new()));
    for pipe in [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let output = Arc::clone(&output);
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let mut output = output.lock().unwrap_or_else(PoisonError::into_inner);
                output.push_str(&line);
                output.push('\n');
            }
        });
    }
    let attempt = state.next_login.fetch_add(1, Ordering::Relaxed);
    *state.login.lock().unwrap_or_else(PoisonError::into_inner) = Some((attempt, child));

    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        let exited = {
            let mut login = state.login.lock().unwrap_or_else(PoisonError::into_inner);
            let Some((_, child)) = login.as_mut().filter(|(id, _)| *id == attempt) else {
                return Err("login-cancelled".into());
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    login.take();
                    Some(status)
                }
                _ => None,
            }
        };
        if let Some(status) = exited {
            if status.success() {
                return Ok(());
            }
            // Let the reader threads catch the last of its output.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let output = output.lock().unwrap_or_else(PoisonError::into_inner);
            return Err(format!("login-failed: {}", last_lines(&output, 4)));
        }
        if Instant::now() >= deadline {
            state.stop_claude_login();
            return Err("login-timed-out".into());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Stop a `local_claude_login` in progress; the page's Cancel.
#[tauri::command]
pub async fn local_claude_login_cancel(state: State<'_, LocalRuntime>) -> Result<(), String> {
    state.stop_claude_login();
    Ok(())
}

/// Up to `n` non-blank lines from the end of `text`, joined for one line of UI.
fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join(" | ")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFolder {
    /// The repository's top level for a git folder (even if a subfolder was
    /// chosen), else the folder as chosen.
    path: String,
    name: String,
    /// A repository with a commit to branch from: sessions get a worktree.
    /// Otherwise Claude works in the folder itself.
    git: bool,
    /// The checked-out branch, when there is one.
    branch: Option<String>,
}

/// Ask the user for a folder to work in. `None` means they cancelled.
#[tauri::command]
pub async fn local_pick_folder(
    app: AppHandle,
    state: State<'_, LocalRuntime>,
) -> Result<Option<LocalFolder>, String> {
    let (picked, folder) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose a folder to work in")
        .pick_folder(move |choice| {
            let _ = picked.send(choice);
        });
    let Some(folder) = folder.await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|error| error.to_string())?;
    let folder = tauri::async_runtime::spawn_blocking(move || inspect_folder(&path))
        .await
        .map_err(|error| error.to_string())??;
    // The folder sessions use: the repository's top level for a git folder.
    if let Ok(real) = std::fs::canonicalize(&folder.path) {
        state.picked.lock().unwrap_or_else(PoisonError::into_inner).insert(real);
    }
    Ok(Some(folder))
}

/// Re-check a remembered folder: it may have moved or gone.
#[tauri::command]
pub async fn local_check_folder(
    app: AppHandle,
    state: State<'_, LocalRuntime>,
    path: String,
) -> Result<LocalFolder, String> {
    check_chosen(&app, &state, &path).await?;
    tauri::async_runtime::spawn_blocking(move || inspect_folder(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

/// Refuse a folder the user did not choose. The page names folders, but running
/// git in one (or a session) on the page's word alone would let a page probe
/// the disk, or run git in a directory whose config it does not trust. Allowed:
/// a folder picked in the dialog in this run, or one an existing session works
/// in — picked in an earlier run, and how the sidebar starts another there.
async fn check_chosen(app: &AppHandle, state: &LocalRuntime, path: &str) -> Result<(), String> {
    let real = std::fs::canonicalize(path).map_err(|_| "folder-missing".to_string())?;
    if state.picked.lock().unwrap_or_else(PoisonError::into_inner).contains(&real) {
        return Ok(());
    }
    if session_works_in(&list_sessions(app, state).await?, &real) {
        return Ok(());
    }
    Err("folder-not-chosen".into())
}

/// Whether one of the agent's sessions works in the folder at `real`.
fn session_works_in(sessions: &serde_json::Value, real: &Path) -> bool {
    sessions
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|session| session.get("folder")?.as_str())
        .filter_map(|folder| std::fs::canonicalize(folder).ok())
        .any(|folder| folder == real)
}

/// The sessions the agent on this Mac knows, newest first. Local sessions live
/// only here, not in the shared database.
#[tauri::command]
pub async fn local_list_sessions(
    app: AppHandle,
    state: State<'_, LocalRuntime>,
) -> Result<serde_json::Value, String> {
    list_sessions(&app, &state).await
}

async fn list_sessions(app: &AppHandle, state: &LocalRuntime) -> Result<serde_json::Value, String> {
    let agent = state.agent().await?;
    // The agent lists only for its listing workspace id, which no real
    // workspace can have (valid_id refuses it), so the page cannot get one.
    let token = mint_token(&agent.secret, LISTING_WORKSPACE_ID, "local", &device_id(app)?);
    let response = http_client()
        .get(format!("http://{}/workspaces", agent.addr))
        .bearer_auth(token)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("agent-unreachable: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("agent: listing sessions failed ({})", response.status()));
    }
    let body: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
    Ok(body.get("workspaces").cloned().unwrap_or_else(|| serde_json::json!([])))
}

/// Mirrors the agent's own check (internal/workspace inspectFolder), so the
/// page can say up front whether a session will get a worktree.
fn inspect_folder(path: &Path) -> Result<LocalFolder, String> {
    if !path.is_dir() {
        return Err("folder-missing".into());
    }
    let as_given = path.to_string_lossy().into_owned();
    let name_of = |p: &str| {
        Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
    };
    let git = git_output(path, &["rev-parse", "--show-toplevel"])
        .filter(|top| git_output(Path::new(top), &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).is_some());
    Ok(match git {
        Some(top) => {
            let branch = git_output(Path::new(&top), &["rev-parse", "--abbrev-ref", "HEAD"])
                .filter(|branch| branch != "HEAD" && !branch.is_empty());
            LocalFolder { name: name_of(&top), path: top, git: true, branch }
        }
        None => LocalFolder { name: name_of(&as_given), path: as_given, git: false, branch: None },
    })
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
        ("POST", ["workspaces", id, "start" | "stop" | "resume" | "destroy" | "message" | "model"], None)
            if *id == workspace_id =>
        {
            Ok(reqwest::Method::POST)
        }
        ("GET", ["workspaces", id, "summary"], None) if *id == workspace_id => Ok(reqwest::Method::GET),
        ("GET", ["workspaces", id, "changes"], query)
            if *id == workspace_id && query.is_none_or(valid_changes_query) =>
        {
            Ok(reqwest::Method::GET)
        }
        _ => Err(format!("route-not-allowed: {method} {path}")),
    }
}

/// One file's diff: exactly `path=<a relative path>`. The agent checks the path
/// again, but the relay is the boundary the page talks to, so it refuses an
/// absolute path, a `..` step or a NUL without relying on that.
fn valid_changes_query(query: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(&format!("http://agent/?{query}")) else {
        return false;
    };
    let pairs: Vec<_> = url.query_pairs().collect();
    match pairs.as_slice() {
        [(key, path)] if key == "path" => {
            !path.is_empty()
                && !path.starts_with('/')
                && !path.contains('\0')
                && path.split('/').all(|step| step != "..")
        }
        _ => false,
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
    if method == "POST" && path == "/workspaces" {
        // A session is Claude working in that folder: only in one the user chose.
        let folder = body
            .as_ref()
            .and_then(|body| body.get("repoPath")?.as_str())
            .ok_or("folder-required")?;
        check_chosen(&app, &state, folder).await?;
    }
    let agent = state.agent().await?;
    let device = device_id(&app)?;
    agent_call(&agent, &device, &method, &path, body, &workspace_id, &project_id).await
}

/// One allowlisted control call to the agent, with a token for one workspace.
async fn agent_call(
    agent: &AgentHandle,
    device_id: &str,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
    workspace_id: &str,
    project_id: &str,
) -> Result<serde_json::Value, String> {
    let method = allowed_route(method, path, workspace_id)?;
    let token = mint_token(&agent.secret, workspace_id, project_id, device_id);

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
    state.sockets.lock().unwrap_or_else(PoisonError::into_inner).insert(id, outbound);
    let sockets = state.sockets.clone();
    tauri::async_runtime::spawn(async move {
        relay(url, commands, on_event).await;
        sockets.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
    });
    Ok(id)
}

#[tauri::command]
pub fn local_socket_send(state: State<'_, LocalRuntime>, id: u32, data: String) -> Result<(), String> {
    let sockets = state.sockets.lock().unwrap_or_else(PoisonError::into_inner);
    let socket = sockets.get(&id).ok_or("socket-closed")?;
    socket.send(Outbound::Text(data)).map_err(|_| "socket-closed".to_string())
}

#[tauri::command]
pub fn local_socket_close(state: State<'_, LocalRuntime>, id: u32) {
    if let Some(socket) = state.sockets.lock().unwrap_or_else(PoisonError::into_inner).remove(&id) {
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

    /// A directory holding one `claude`, with `body` as its script and `mode`.
    fn claude_dir(name: &str, body: &str, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("outrunner-{name}-{}", random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let claude = dir.join("claude");
        std::fs::write(&claude, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(mode)).unwrap();
        dir
    }

    // What npm leaves when Claude Code's postinstall never ran (2.1.293's
    // bin/claude.exe, shortened): a 0644 script that only reports it.
    const PLACEHOLDER: &str = "echo 'Error: claude native binary not installed.' >&2\nexit 1";

    #[test]
    fn the_first_claude_that_runs_is_used_not_the_first_found() {
        let unfinished = claude_dir("unfinished", PLACEHOLDER, 0o644);
        let placeholder = claude_dir("placeholder", PLACEHOLDER, 0o755);
        let working = claude_dir("working", "echo '2.1.293 (Claude Code)'", 0o755);
        // The same unfinished install again, through a link.
        let linked = std::env::temp_dir().join(format!("outrunner-linked-{}", random_hex(4)));
        std::fs::create_dir_all(&linked).unwrap();
        std::os::unix::fs::symlink(unfinished.join("claude"), linked.join("claude")).unwrap();

        let dirs = [&unfinished, &placeholder, &linked, &working].map(|d| d.to_path_buf());
        assert_eq!(find_claude_in(dirs.clone().into_iter()), Ok(working.join("claude")));
        assert_eq!(
            find_claude_in(dirs[..3].to_vec().into_iter()),
            Err(vec![unfinished.join("claude"), placeholder.join("claude")]),
            "each broken install is reported once"
        );
        assert_eq!(find_claude_in(std::iter::empty()), Err(vec![]));
        for dir in [unfinished, placeholder, linked, working] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_claude_that_answers_as_something_else_is_not_used() {
        let other = claude_dir("other", "echo 'claude 0.1 (a different tool)'", 0o755);
        assert_eq!(find_claude_in(std::iter::once(other.clone())), Err(vec![other.join("claude")]));
        let _ = std::fs::remove_dir_all(other);
    }

    #[test]
    fn the_link_follows_the_claude_found() {
        let dir = std::env::temp_dir().join(format!("outrunner-link-{}", random_hex(4)));
        let first = claude_dir("first", "echo '2.1.293 (Claude Code)'", 0o755).join("claude");
        let second = claude_dir("second", "echo '2.1.294 (Claude Code)'", 0o755).join("claude");
        link_claude(&dir, &first);
        assert_eq!(std::fs::read_link(dir.join("claude")).unwrap(), first);
        link_claude(&dir, &second);
        assert_eq!(std::fs::read_link(dir.join("claude")).unwrap(), second);
        // Nothing staged is left behind.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        for path in [dir, first.parent().unwrap().into(), second.parent().unwrap().into()] {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    #[test]
    fn reads_whether_claude_is_logged_in_from_auth_status() {
        assert_eq!(parse_logged_in(r#"{"loggedIn": true, "authMethod": "claude.ai"}"#), Some(true));
        assert_eq!(parse_logged_in(r#"{"loggedIn": false, "authMethod": "none"}"#), Some(false));
        // A Claude Code without `auth status` prints usage, not JSON.
        assert_eq!(parse_logged_in("error: unknown command 'auth'"), None);
        assert_eq!(parse_logged_in(r#"{"authMethod": "none"}"#), None);
    }

    #[test]
    fn the_login_check_reads_a_real_auth_status() {
        // A stand-in `claude` that answers like a logged-out one: JSON, exit 1.
        let dir = std::env::temp_dir().join(format!("outrunner-auth-{}", random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let claude = dir.join("claude");
        std::fs::write(&claude, "#!/bin/sh\necho '{\"loggedIn\": false}'\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(claude_logged_in(claude.to_str().unwrap()), Some(false));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[ignore = "asks this Mac's real Claude Code"]
    fn the_login_check_gets_an_answer_from_the_real_claude() {
        let claude = find_claude().expect("a claude that runs, on the login-shell PATH");
        let claude = claude.to_string_lossy();
        assert!(claude_logged_in(&claude).is_some(), "no clear answer from {claude}");
    }

    /// A stand-in `claude` whose `auth login` runs `body`.
    fn fake_claude(name: &str, body: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("outrunner-{name}-{}", random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let claude = dir.join("claude");
        std::fs::write(&claude, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, claude)
    }

    #[test]
    fn a_login_resolves_when_the_cli_exits_cleanly() {
        let (dir, claude) = fake_claude("login-ok", "echo 'Login successful.'");
        let runtime = LocalRuntime::default();
        let result = tauri::async_runtime::block_on(run_claude_login(&runtime, &claude));
        assert_eq!(result, Ok(()));
        assert!(runtime.login.lock().unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_login_says_what_the_cli_printed() {
        let (dir, claude) = fake_claude(
            "login-fail",
            "echo 'Opening browser to sign in…'\necho 'OAuth error: access denied' >&2\nexit 1",
        );
        let runtime = LocalRuntime::default();
        let err = tauri::async_runtime::block_on(run_claude_login(&runtime, &claude)).unwrap_err();
        assert!(err.starts_with("login-failed: "), "{err}");
        assert!(err.contains("OAuth error: access denied"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_cancelled_login_stops_the_cli() {
        let (dir, claude) = fake_claude("login-cancel", "exec sleep 30");
        let runtime = Arc::new(LocalRuntime::default());
        let canceller = Arc::clone(&runtime);
        std::thread::spawn(move || {
            // Cancel once the CLI is up; finding the login-shell PATH first can
            // take seconds.
            while canceller.login.lock().unwrap().is_none() {
                std::thread::sleep(Duration::from_millis(50));
            }
            canceller.stop_claude_login();
        });
        let started = Instant::now();
        let result = tauri::async_runtime::block_on(run_claude_login(&runtime, &claude));
        assert_eq!(result, Err("login-cancelled".to_string()));
        assert!(started.elapsed() < Duration::from_secs(20), "the CLI ran to its end");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn last_lines_keeps_the_end_without_blanks() {
        assert_eq!(last_lines("a\n\n b \nc\nd\ne\n", 3), "c | d | e");
        assert_eq!(last_lines("", 3), "");
    }

    #[test]
    fn folders_report_whether_sessions_get_a_worktree() {
        let dir = std::env::temp_dir().join(format!("outrunner-folder-{}", random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = inspect_folder(&dir).unwrap();
        assert!(!plain.git, "a plain folder is worked on in place");
        assert_eq!(plain.branch, None);

        let git = |args: &[&str]| {
            Command::new("git").arg("-C").arg(&dir)
                .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
                .args(args).output().unwrap()
        };
        git(&["init", "-q", "-b", "trunk"]);
        assert!(!inspect_folder(&dir).unwrap().git, "a repository with no commit has nothing to branch");
        std::fs::write(dir.join("a"), "a").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "a"]);
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let repo = inspect_folder(&sub).unwrap();
        assert!(repo.git);
        assert_eq!(repo.branch.as_deref(), Some("trunk"));
        assert!(!repo.path.ends_with("/sub"), "a subfolder resolves to the repository's top level");

        assert_eq!(inspect_folder(&dir.join("missing")).err().as_deref(), Some("folder-missing"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn routes_are_bound_to_the_tokens_workspace() {
        assert!(allowed_route("POST", "/workspaces", "ws-1").is_ok());
        assert!(allowed_route("POST", "/workspaces/ws-1/start", "ws-1").is_ok());
        assert!(allowed_route("POST", "/workspaces/ws-1/model", "ws-1").is_ok());
        assert!(allowed_route("POST", "/workspaces/ws-2/model", "ws-1").is_err());
        assert!(allowed_route("GET", "/workspaces/ws-1/model", "ws-1").is_err());
        assert!(allowed_route("GET", "/workspaces/ws-1/summary", "ws-1").is_ok());
        assert!(allowed_route("GET", "/workspaces/ws-1/changes", "ws-1").is_ok());
        assert!(allowed_route("GET", "/workspaces/ws-1/changes?path=src%2Fa.ts", "ws-1").is_ok());
        assert!(allowed_route("GET", "/workspaces/ws-1/changes?other=1", "ws-1").is_err());
        // A diff's path stays inside the worktree, whatever the agent does.
        for bad in [
            "path=",
            "path=%2Fetc%2Fpasswd",
            "path=..%2Fx",
            "path=a%2F..%2F..%2Fx",
            "path=a&path=b",
            "path=a%00b",
        ] {
            let route = format!("/workspaces/ws-1/changes?{bad}");
            assert!(allowed_route("GET", &route, "ws-1").is_err(), "{bad}");
        }
        assert!(allowed_route("POST", "/workspaces/ws-1/start?x=1", "ws-1").is_err());
        // Another workspace's route, an unrelayed action, or a wrong method.
        assert!(allowed_route("POST", "/workspaces/ws-2/stop", "ws-1").is_err());
        assert!(allowed_route("POST", "/workspaces/ws-1/archive", "ws-1").is_err());
        assert!(allowed_route("GET", "/workspaces/ws-1/destroy", "ws-1").is_err());
        assert!(allowed_route("GET", "/health/../workspaces", "ws-1").is_err());
    }

    #[test]
    fn a_sessions_folder_counts_as_chosen_through_symlinks() {
        let base = std::env::temp_dir().join(format!("outrunner-chosen-{}", random_hex(4)));
        let (real, other, link) = (base.join("app"), base.join("other"), base.join("link"));
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // The agent reports a session's folder as git resolved it; the page may
        // name it through a symlink (/var is /private/var on macOS).
        let sessions = serde_json::json!([{ "folder": link }, { "title": "no folder" }]);
        assert!(session_works_in(&sessions, &std::fs::canonicalize(&real).unwrap()));
        assert!(!session_works_in(&sessions, &std::fs::canonicalize(&other).unwrap()));
        assert!(!session_works_in(&serde_json::json!(null), &real));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ids_must_be_plain() {
        assert!(valid_id("0f6c1c0e-4a43-4a8e-9f4e-2a8d1c3b5e77"));
        // The listing id among them: the page must never get a listing token.
        for bad in ["", "../x", "a/b", "a b", "ws:1", LISTING_WORKSPACE_ID] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    /// The relay end to end against the real agent, tmux and Claude Code: the
    /// agent verifies our tokens, a worktree is made off a throwaway clone,
    /// one prompt goes through, and the PTY and conversation streams come back
    /// over Channels. Spends a few tokens of the signed-in Claude account.
    ///
    ///   scripts/build-agent-desktop.sh
    ///   OUTRUNNER_AGENT_BINARY=$PWD/binaries/runtime-agent-aarch64-apple-darwin \
    ///     cargo test relays_a_real_local_session -- --ignored --nocapture
    #[test]
    #[ignore = "drives the real agent, tmux and claude"]
    fn relays_a_real_local_session() {
        use std::sync::{Arc, Mutex};
        use tauri::ipc::{Channel, InvokeResponseBody};

        let work = std::env::temp_dir().join(format!("outrunner-relay-{}", random_hex(4)));
        let repo = work.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        std::env::set_var("OUTRUNNER_ROOT", work.join("root"));
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
                .args(args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("README.md"), "relay\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "first"]);

        let mut agent = spawn_agent().expect("the agent starts and announces its address");
        let handle = AgentHandle { addr: agent.addr.clone(), secret: agent.secret.clone() };
        let ws = format!("relay-{}", random_hex(6));
        let (project, device) = ("p-relay", "dev-relay");

        // Collect what a page would receive on each stream.
        let collect = || {
            let seen = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
            let sink = seen.clone();
            let channel = Channel::<SocketEvent>::new(move |body| {
                if let InvokeResponseBody::Json(json) = body {
                    sink.lock().unwrap().push(serde_json::from_str(&json).unwrap());
                }
                Ok(())
            });
            (seen, channel)
        };
        let wait_for = |seen: &Arc<Mutex<Vec<serde_json::Value>>>, what: &str, pred: &dyn Fn(&serde_json::Value) -> bool, secs: u64| {
            let deadline = Instant::now() + Duration::from_secs(secs);
            while Instant::now() < deadline {
                if seen.lock().unwrap().iter().any(pred) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            panic!("timed out waiting for {what}: {:?}", seen.lock().unwrap());
        };

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tauri::async_runtime::block_on(async {
                let created = agent_call(&handle, device, "POST", "/workspaces", Some(serde_json::json!({
                    "workspaceId": ws, "repoFullName": "acme/app", "branch": format!("runtime/{ws}"),
                    "baseBranch": "main", "repoPath": repo.to_string_lossy(),
                })), &ws, project).await.expect("create");
                let worktree = created["worktree"].as_str().unwrap().to_string();
                agent_call(&handle, device, "POST", &format!("/workspaces/{ws}/start"), None, &ws, project)
                    .await
                    .expect("start");
                // The relay defaulted the mode; the agent recorded it.
                let facts = std::fs::read_to_string(work.join("root/facts").join(format!("{ws}.json"))).unwrap();
                assert!(facts.contains("acceptEdits"), "{facts}");

                let (events, events_channel) = collect();
                let (_events_tx, events_rx) = mpsc::unbounded_channel::<Outbound>();
                let token = mint_token(&handle.secret, &ws, project, device);
                tauri::async_runtime::spawn(relay(format!("ws://{}/events-ws?token={token}", handle.addr), events_rx, events_channel));
                let (pty, pty_channel) = collect();
                let (pty_tx, pty_rx) = mpsc::unbounded_channel();
                let token = mint_token(&handle.secret, &ws, project, device);
                tauri::async_runtime::spawn(relay(format!("ws://{}/pty?token={token}", handle.addr), pty_rx, pty_channel));
                pty_tx.send(Outbound::Text(r#"{"t":"resize","cols":100,"rows":30}"#.into())).unwrap();

                let is = |kind: &'static str| move |e: &serde_json::Value| e["type"] == kind;
                wait_for(&events, "events open", &is("open"), 10);
                wait_for(&pty, "pty open", &is("open"), 10);

                agent_call(&handle, device, "POST", &format!("/workspaces/{ws}/message"),
                    Some(serde_json::json!({ "content": "Reply with exactly RELAY-OK and nothing else." })),
                    &ws, project).await.expect("message delivered");

                let assistant_said = |e: &serde_json::Value| {
                    e["type"] == "message"
                        && e["data"].as_str().and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                            .is_some_and(|frame| frame["data"]["role"] == "assistant" && frame["data"]["content"].to_string().contains("RELAY-OK"))
                };
                wait_for(&events, "the assistant's reply", &assistant_said, 120);
                let pty_frame = |t: &'static str| move |e: &serde_json::Value| {
                    e["type"] == "message" && e["data"].as_str().is_some_and(|d| d.contains(&format!(r#""t":"{t}""#)))
                };
                wait_for(&pty, "the writer role", &pty_frame("role"), 5);
                wait_for(&pty, "terminal output", &pty_frame("output"), 5);

                pty_tx.send(Outbound::Close).unwrap();
                wait_for(&pty, "pty close", &is("close"), 5);
                agent_call(&handle, device, "POST", &format!("/workspaces/{ws}/destroy"), None, &ws, project)
                    .await
                    .expect("destroy");
                assert!(!Path::new(&worktree).exists(), "worktree removed");
            });
        }));

        let _ = Command::new("tmux").args(["-L", TMUX_SOCKET, "kill-session", "-t", &format!("ws-{ws}")])
            .env("PATH", session_path()).output();
        let _ = agent.child.kill();
        let _ = agent.child.wait();
        let _ = std::fs::remove_dir_all(&work);
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
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
