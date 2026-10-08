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
//   2. waits while the user authorizes there
//   3. prints the resulting sk-ant-oat… token
//
// Step 2 normally completes hands-free: the browser lands on
// platform.claude.com showing "You're all set up for Claude Code", the CLI
// finishes on its own, and nothing is pasted anywhere. So the happy path is one
// click, and `connect_claude_poll` watches for the token.
//
// The CLI can still fall back to prompting for a code on the terminal, so
// `connect_claude_submit` remains for that case and the UI keeps a code field.
// Do not assume the prompt: an earlier version waited for it unconditionally and
// left the user hunting for a code that was never issued.
//
// The token is returned to the webview, which posts it to the app's own
// credential endpoint. It is never written to disk here.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Set by the reader thread once the child's output has ended, after the
    /// last of it is in `transcript`.
    exited: Arc<AtomicBool>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct ClaudeLoginState(
    pub Mutex<Option<ClaudeLogin>>,
    /// The last attempt's output, kept after the child is dropped so a failure
    /// can be diagnosed from what the CLI actually printed.
    pub Mutex<String>,
);

/// Locate the `claude` binary the way local sessions do: on the user's
/// login-shell PATH, then the usual install prefixes.
///
/// A macOS GUI app inherits launchd's PATH, not the user's shell PATH, so a
/// Homebrew or version-manager install is invisible to a bare
/// `Command::new("claude")`. The login shell is asked once, with a deadline and
/// markers around the answer, so a slow profile cannot hang this and a profile
/// that prints a banner cannot garble the path.
fn claude_binary() -> Option<PathBuf> {
    crate::local_runtime::which("claude").map(PathBuf::from)
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

/// The last few lines the CLI printed, ANSI stripped and tokens redacted, for
/// an error message. Without them a failure on someone else's machine says only
/// that it didn't work, and has to be debugged by hand.
fn transcript_tail(raw: &str) -> String {
    let re = regex::Regex::new(r"sk-ant-[A-Za-z0-9_-]{10,}").unwrap();
    let text = strip_ansi(raw);
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(6)..].join(" | ");
    re.replace_all(&tail, "<redacted token>").into_owned()
}

/// What a poll reports: the token once printed, an error once the CLI has
/// exited without one, and otherwise nothing yet.
///
/// The exit check matters. `setup-token` exits without a token when the account
/// has no Claude subscription or the user declines in the browser, and before
/// this the UI kept waiting for five minutes and then gave up without a word.
fn poll_outcome(raw: &str, exited: bool) -> Result<Option<String>, String> {
    if let Some(token) = find_token(&strip_ansi(raw)) {
        return Ok(Some(token));
    }
    if !exited {
        return Ok(None);
    }
    let tail = transcript_tail(raw);
    Err(if tail.is_empty() {
        "setup-token-exited".to_string()
    } else {
        format!("setup-token-exited: {tail}")
    })
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
    start_login(&state, claude_binary().ok_or("claude-cli-not-found")?)
}

/// `connect_claude_start` with the binary given, so a test can stand in for
/// the CLI.
fn start_login(state: &ClaudeLoginState, binary: PathBuf) -> Result<String, String> {
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
    // An npm install's `claude` starts with `#!/usr/bin/env node`, and
    // launchd's PATH has no node in it.
    cmd.env("PATH", crate::local_runtime::session_path());

    let child = pty.slave.spawn_command(cmd).map_err(|e| format!("spawn-failed: {e}"))?;
    let mut reader = pty.master.try_clone_reader().map_err(|e| format!("pty-read-failed: {e}"))?;
    let writer = pty.master.take_writer().map_err(|e| format!("pty-write-failed: {e}"))?;

    let transcript = Arc::new(Mutex::new(String::new()));
    let exited = Arc::new(AtomicBool::new(false));
    let (tx, rx) = channel();
    {
        let transcript = Arc::clone(&transcript);
        let exited = Arc::clone(&exited);
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
            exited.store(true, Ordering::Release);
        });
    }

    let url = await_match(&transcript, &rx, URL_TIMEOUT, find_authorize_url);

    let login = ClaudeLogin { writer, transcript, rx, exited, _child: child };
    *state.0.lock().unwrap() = Some(login);

    match url {
        Some(url) => Ok(url),
        None => {
            let tail = state.0.lock().unwrap().as_ref().map_or_else(String::new, |l| {
                transcript_tail(&l.transcript.lock().unwrap())
            });
            Err(if tail.is_empty() {
                "no-authorize-url".to_string()
            } else {
                format!("no-authorize-url: {tail}")
            })
        }
    }
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

/// Wait briefly for the CLI to print a token on its own, without a code.
///
/// The observed flow completes hands-free: authorizing in the browser lands on
/// platform.claude.com, which reports "You're all set up for Claude Code", and
/// the CLI finishes and prints the token with nothing pasted. The code prompt
/// only appears when that automatic path does not fire, so the UI polls this
/// and keeps the code field as a fallback rather than demanding a paste.
///
/// Returns None if no token has arrived yet — the caller polls again. Takes the
/// state lock only long enough to clone the transcript handle, so a poll in
/// flight never blocks cancel or submit.
#[tauri::command]
pub async fn connect_claude_poll(
    state: tauri::State<'_, ClaudeLoginState>,
) -> Result<Option<String>, String> {
    poll_login(&state)
}

fn poll_login(state: &ClaudeLoginState) -> Result<Option<String>, String> {
    let (transcript, exited) = {
        let guard = state.0.lock().unwrap();
        let login = guard.as_ref().ok_or("no-login-in-progress")?;
        (Arc::clone(&login.transcript), Arc::clone(&login.exited))
    };

    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        // Read the flag before the text: the reader sets it only after its last
        // write, so an exit seen here means the transcript below is complete.
        let gone = exited.load(Ordering::Acquire);
        let text = transcript.lock().unwrap().clone();
        *state.1.lock().unwrap() = text.clone();
        let outcome = poll_outcome(&text, gone);
        if !matches!(outcome, Ok(None)) {
            let mut current = state.0.lock().unwrap();
            // Cancel drops the child, which then exits; that exit, or a retry
            // started since, is not this poll's to report or to clear.
            if !current.as_ref().is_some_and(|l| Arc::ptr_eq(&l.transcript, &transcript)) {
                return Err("no-login-in-progress".into());
            }
            // Done with this attempt either way: drop the child so a retry is
            // clean.
            *current = None;
            return outcome;
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// The last attempt's output, with any token redacted.
///
/// Diagnostics only. Tokens are replaced with their length so a transcript can
/// be read without the credential in it — nothing here should ever hand back a
/// secret, and a debug path is exactly where one leaks.
#[tauri::command]
pub async fn connect_claude_debug(
    state: tauri::State<'_, ClaudeLoginState>,
) -> Result<String, String> {
    let raw = state.1.lock().unwrap().clone();
    let text = strip_ansi(&raw);
    let re = regex::Regex::new(r"sk-ant-[A-Za-z0-9_-]{10,}").unwrap();
    Ok(re
        .replace_all(&text, |c: &regex::Captures| {
            format!("<REDACTED token, {} chars>", c[0].len())
        })
        .to_string())
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
    fn a_poll_reports_why_the_cli_exited_without_a_token() {
        let raw = "\x1b[2GOpening browser to sign in\n\nSomething went wrong\n";
        assert_eq!(poll_outcome(raw, false), Ok(None));
        let err = poll_outcome(raw, true).unwrap_err();
        assert!(err.starts_with("setup-token-exited: "), "{err}");
        assert!(err.ends_with("Opening browser to sign in | Something went wrong"), "{err}");
        assert_eq!(poll_outcome("", true), Err("setup-token-exited".to_string()));
    }

    #[test]
    fn a_poll_returns_a_token_printed_just_before_exit() {
        let raw = "Token created:\n  sk-ant-oat01-AbCd1234_efgh-5678ijkl\n";
        assert_eq!(
            poll_outcome(raw, true),
            Ok(Some("sk-ant-oat01-AbCd1234_efgh-5678ijkl".to_string()))
        );
    }

    #[test]
    fn the_tail_keeps_the_last_lines_and_redacts_tokens() {
        let raw = (1..=8).map(|n| format!("line {n}\n\n")).collect::<String>()
            + "sk-ant-oat01-AbCd1234_efgh\n";
        assert_eq!(
            transcript_tail(&raw),
            "line 4 | line 5 | line 6 | line 7 | line 8 | <redacted token>"
        );
    }

    /// A stand-in for `claude` that prints a sign-in link, then fails the way
    /// `setup-token` does for an account without a subscription.
    fn failing_cli(name: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("outrunner-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("claude");
        std::fs::write(
            &path,
            "#!/bin/sh\n\
             echo 'Opening browser to sign in'\n\
             echo 'https://claude.com/cai/oauth/authorize?code=true&state=abc'\n\
             sleep 1\n\
             echo 'Login failed: no subscription'\n\
             exit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, path)
    }

    #[test]
    fn a_cli_that_exits_without_a_token_ends_the_poll_with_its_output() {
        let (dir, cli) = failing_cli("login-exit");
        let state = ClaudeLoginState::default();
        let url = start_login(&state, cli).expect("authorize url");
        assert!(url.starts_with("https://claude.com/cai/oauth/authorize"), "{url}");

        let deadline = Instant::now() + Duration::from_secs(15);
        let err = loop {
            match poll_login(&state) {
                Ok(None) if Instant::now() < deadline => continue,
                Ok(other) => panic!("poll = {other:?}; want the CLI's failure"),
                Err(err) => break err,
            }
        };
        assert!(err.starts_with("setup-token-exited: "), "{err}");
        assert!(err.contains("Login failed: no subscription"), "{err}");
        // The attempt is over, so a retry starts clean.
        assert_eq!(poll_login(&state), Err("no-login-in-progress".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cancelled_login_is_not_reported_as_a_failure() {
        let (dir, cli) = failing_cli("login-cancel");
        let state = ClaudeLoginState::default();
        start_login(&state, cli).expect("authorize url");
        *state.0.lock().unwrap() = None; // connect_claude_cancel
        assert_eq!(poll_login(&state), Err("no-login-in-progress".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
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
