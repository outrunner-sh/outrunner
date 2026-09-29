// Native "Connect Claude": mint a Claude Code token without the user opening a
// terminal or ever handling the token themselves.
//
// `claude setup-token` is an interactive TUI, not a batch command. Run with no
// controlling terminal it prints nothing and never exits — which is why a plain
// `Command::output()` hangs forever. It must be driven through a PTY.
//
// Its real flow, observed by running it under a pty:
//
//   1. prints "Opening browser to sign in…" and opens the system browser at
//      https://claude.com/cai/oauth/authorize?...&code_challenge=...
//   2. BLOCKS on the terminal waiting for an authorization code to be pasted
//   3. prints the resulting sk-ant-oat… token
//
// Step 2 cannot be automated away: the authorize URL's redirect_uri is fixed to
// platform.claude.com, so the code lands in the browser and a human has to carry
// it back. That is why this is two commands rather than one — `start` gets the
// URL, `submit` hands over the code — and why the UI shows a code field.
//
// The token is returned to the webview, which posts it to the app's own
// credential endpoint. It is never written to disk here.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

/// How long to wait for the authorize URL to appear after spawning.
const URL_TIMEOUT: Duration = Duration::from_secs(45);
/// How long to wait for the token after the code is submitted.
const TOKEN_TIMEOUT: Duration = Duration::from_secs(90);

/// A login in progress: the PTY writer to feed the code to, plus everything the
/// child has printed so far.
pub struct ClaudeLogin {
    writer: Box<dyn Write + Send>,
    transcript: Arc<Mutex<String>>,
    /// Signalled by the reader thread whenever new output lands, so the pollers
    /// below wake on output rather than on a timer.
    rx: Receiver<()>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct ClaudeLoginState(pub Mutex<Option<ClaudeLogin>>);

/// Locate the `claude` binary.
///
/// A macOS GUI app inherits launchd's PATH, not the user's shell PATH, so a
/// Homebrew or nvm install is invisible to a bare `Command::new("claude")`.
/// Checking the usual prefixes directly is more predictable than spawning a
/// login shell just to resolve a name.
fn claude_binary() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for rel in [".claude/local/claude", ".local/bin/claude", ".bun/bin/claude"] {
            let candidate = home.join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for prefix in [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
    ] {
        let candidate = PathBuf::from(prefix);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // Last resort: whatever PATH we did inherit.
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("claude"))
            .find(|candidate| candidate.is_file())
    })
}

/// Strip ANSI escape sequences and the OSC-8 hyperlink wrappers Claude Code
/// emits, so the text can be pattern-matched. Without this the authorize URL
/// arrives wrapped in `\x1b]8;id=...;URL\x1b\\` and split by cursor moves.
fn strip_ansi(raw: &str) -> String {
    let csi = regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap();
    let osc = regex::Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").unwrap();
    let other = regex::Regex::new(r"\x1b[()][A-Za-z0-9]|\x1b[=>]|[\x00-\x08\x0b\x0c\x0e-\x1f]").unwrap();
    let out = osc.replace_all(raw, "");
    let out = csi.replace_all(&out, "");
    other.replace_all(&out, "").to_string()
}

/// The first Claude authorize URL in the transcript, if it has arrived.
fn find_authorize_url(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"https://claude\.com/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+").unwrap();
    // The CLI prints the URL twice (once inside an OSC-8 hyperlink, once bare)
    // and they can run together once the escapes are stripped; `oauth/authorize`
    // marks the real start and `state=` ends it.
    let found = re.find(text)?.as_str();
    Some(found.to_string())
}

/// The minted token, if the child has printed one.
fn find_token(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"sk-ant-[A-Za-z0-9_-]{20,}").unwrap();
    re.find(text).map(|m| m.as_str().to_string())
}

/// Block until `probe` finds something in the transcript, or `budget` elapses.
/// Wakes on the reader thread's signal rather than polling on a fixed tick.
fn await_match<T>(
    transcript: &Arc<Mutex<String>>,
    rx: &Receiver<()>,
    budget: Duration,
    probe: impl Fn(&str) -> Option<T>,
) -> Option<T> {
    let deadline = Instant::now() + budget;
    loop {
        {
            let text = transcript.lock().unwrap();
            if let Some(found) = probe(&strip_ansi(&text)) {
                return Some(found);
            }
        }
        let remaining = deadline.checked_duration_since(Instant::now())?;
        match rx.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                // Child exited; give its final output one last look.
                let text = transcript.lock().unwrap();
                return probe(&strip_ansi(&text));
            }
        }
    }
}

/// Spawn `claude setup-token` under a PTY and return the authorize URL the user
/// must visit. The child is left running, blocked on its code prompt.
#[tauri::command]
pub async fn connect_claude_start(
    state: tauri::State<'_, ClaudeLoginState>,
) -> Result<String, String> {
    let binary = claude_binary().ok_or("claude-cli-not-found")?;

    let pty = NativePtySystem::default()
        .openpty(PtySize { rows: 48, cols: 120, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("pty-failed: {e}"))?;

    let mut cmd = CommandBuilder::new(binary);
    cmd.arg("setup-token");
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }
    // Claude Code renders a spinner and redraws; a dumb terminal keeps the
    // transcript closer to plain text without changing the flow.
    cmd.env("TERM", "xterm-256color");

    let child = pty.slave.spawn_command(cmd).map_err(|e| format!("spawn-failed: {e}"))?;
    let mut reader = pty.master.try_clone_reader().map_err(|e| format!("pty-read-failed: {e}"))?;
    let writer = pty.master.take_writer().map_err(|e| format!("pty-write-failed: {e}"))?;

    let transcript = Arc::new(Mutex::new(String::new()));
    let (tx, rx) = channel();
    {
        let transcript = Arc::clone(&transcript);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        transcript
                            .lock()
                            .unwrap()
                            .push_str(&String::from_utf8_lossy(&buf[..n]));
                        // A closed channel just means nobody is waiting.
                        let _ = tx.send(());
                    }
                }
            }
        });
    }

    let url = await_match(&transcript, &rx, URL_TIMEOUT, find_authorize_url);

    let login = ClaudeLogin { writer, transcript, rx, _child: child };
    *state.0.lock().unwrap() = Some(login);

    url.ok_or_else(|| "no-authorize-url".to_string())
}

/// Hand the code from the browser to the waiting child and return the token.
#[tauri::command]
pub async fn connect_claude_submit(
    code: String,
    state: tauri::State<'_, ClaudeLoginState>,
) -> Result<String, String> {
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err("empty-code".into());
    }

    let mut guard = state.0.lock().unwrap();
    let login = guard.as_mut().ok_or("no-login-in-progress")?;

    // A PTY line ends with CR, not LF — the terminal driver turns it into the
    // newline the child's line reader is waiting for.
    login
        .writer
        .write_all(format!("{code}\r").as_bytes())
        .map_err(|e| format!("write-failed: {e}"))?;
    login.writer.flush().map_err(|e| format!("write-failed: {e}"))?;

    let token = await_match(&login.transcript, &login.rx, TOKEN_TIMEOUT, find_token);

    // Either way this attempt is over: drop the child so a retry starts clean
    // and no PTY is left open holding a half-finished login.
    *guard = None;

    token.ok_or_else(|| "no-token-in-output".to_string())
}

/// Abandon a login in progress (the user closed the dialog).
#[tauri::command]
pub async fn connect_claude_cancel(
    state: tauri::State<'_, ClaudeLoginState>,
) -> Result<(), String> {
    *state.0.lock().unwrap() = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_osc8_hyperlink_wrapper_around_the_url() {
        let raw = "\x1b]8;id=19tye59;https://claude.com/cai/oauth/authorize?code=true\x1b\\link\x1b]8;;\x1b\\";
        assert!(!strip_ansi(raw).contains('\x1b'));
    }

    #[test]
    fn finds_the_authorize_url_in_real_cli_output() {
        let raw = "\x1b[2G·\x1b[4GOpening\x1b[12Gbrowser\n\
                   https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=abc\n";
        let url = find_authorize_url(&strip_ansi(raw)).expect("url");
        assert!(url.starts_with("https://claude.com/cai/oauth/authorize"));
        assert!(url.contains("state=abc"));
    }

    #[test]
    fn does_not_mistake_the_prompt_for_a_token() {
        assert_eq!(find_token("Paste code here:"), None);
        assert_eq!(find_token("sk-ant-short"), None);
    }

    #[test]
    fn finds_a_setup_token_among_surrounding_output() {
        let out = "Token created successfully:\n  sk-ant-oat01-AbCd1234_efgh-5678ijkl\nDone.";
        assert_eq!(
            find_token(out).as_deref(),
            Some("sk-ant-oat01-AbCd1234_efgh-5678ijkl")
        );
    }
}
