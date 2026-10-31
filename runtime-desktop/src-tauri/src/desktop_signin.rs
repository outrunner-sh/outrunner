//! Browser-first signup: only the final, explicit desktop choice comes back.
//! The native PKCE verifier never enters the browser or callback URL.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const LIFETIME: Duration = Duration::from_secs(60 * 60);

struct Attempt {
    state: String,
    verifier: String,
    started: Instant,
    ticket: Option<String>,
}

#[derive(Default)]
pub struct DesktopSigninState(Mutex<Option<Attempt>>);

fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not start secure sign-in.".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn new_attempt() -> Result<Attempt, String> {
    Ok(Attempt {
        state: random_secret()?,
        verifier: random_secret()?,
        started: Instant::now(),
        ticket: None,
    })
}

#[tauri::command]
pub fn desktop_signin_start(
    state: tauri::State<'_, DesktopSigninState>,
    next: String,
) -> Result<String, String> {
    let attempt = new_attempt()?;
    let mut url = format!("{}/auth/desktop/start", crate::site())
        .parse::<tauri::Url>()
        .map_err(|_| "Invalid app address.".to_string())?;
    url.query_pairs_mut()
        .append_pair("state", &attempt.state)
        .append_pair(
            "challenge",
            &URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.as_bytes())),
        )
        .append_pair("next", &next);
    let id = attempt.state.clone();
    *state.0.lock().unwrap() = Some(attempt);
    if open::that(url.as_str()).is_err() {
        *state.0.lock().unwrap() = None;
        return Err("Could not open your browser. Please try again.".to_string());
    }
    Ok(id)
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Poll {
    Waiting,
    Expired,
    Ready { ticket: String, verifier: String },
}

#[tauri::command]
pub fn desktop_signin_poll(state: String, login: tauri::State<'_, DesktopSigninState>) -> Poll {
    let mut current = login.0.lock().unwrap();
    let Some(attempt) = current.as_ref() else {
        return Poll::Expired;
    };
    if attempt.state != state {
        return Poll::Expired;
    }
    if attempt.started.elapsed() >= LIFETIME {
        *current = None;
        return Poll::Expired;
    }
    if attempt.ticket.is_none() {
        return Poll::Waiting;
    }
    // Return secrets to the waiting webview once, then release native memory.
    let attempt = current.take().unwrap();
    Poll::Ready {
        ticket: attempt.ticket.unwrap(),
        verifier: attempt.verifier,
    }
}

/// Ignore callbacks from another attempt, old browser tabs, or a different app.
/// Return true only when this callback belongs to the pending native attempt.
pub fn accept_callback(login: &DesktopSigninState, query: &str) -> bool {
    let Ok(url) = format!("http://localhost/?{query}").parse::<tauri::Url>() else {
        return false;
    };
    let pairs: Vec<_> = url.query_pairs().collect();
    let tickets: Vec<_> = pairs
        .iter()
        .filter(|(name, _)| name == "desktop_ticket")
        .collect();
    let states: Vec<_> = pairs.iter().filter(|(name, _)| name == "state").collect();
    if tickets.len() != 1 || states.len() != 1 {
        return false;
    }
    let ticket = &tickets[0].1;
    if ticket.is_empty() || ticket.len() > 8192 {
        return false;
    }
    let mut current = login.0.lock().unwrap();
    let Some(attempt) = current.as_mut() else {
        return false;
    };
    if attempt.started.elapsed() >= LIFETIME
        || attempt.state != states[0].1
        || attempt.ticket.is_some()
    {
        return false;
    }
    attempt.ticket = Some(ticket.to_string());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> DesktopSigninState {
        DesktopSigninState(Mutex::new(Some(new_attempt().unwrap())))
    }
    fn callback(login: &DesktopSigninState) -> String {
        format!(
            "desktop_ticket=opaque-grant&state={}",
            login.0.lock().unwrap().as_ref().unwrap().state
        )
    }
    #[test]
    fn random_pkce_secrets_are_independent_and_url_safe() {
        let attempt = new_attempt().unwrap();
        assert_eq!(attempt.state.len(), 43);
        assert_eq!(attempt.verifier.len(), 43);
        assert_ne!(attempt.state, attempt.verifier);
        assert_eq!(
            URL_SAFE_NO_PAD
                .encode(Sha256::digest(attempt.verifier.as_bytes()))
                .len(),
            43
        );
    }
    #[test]
    fn accepts_matching_callback_only_once() {
        let login = pending();
        let query = callback(&login);
        assert!(accept_callback(&login, &query));
        assert!(!accept_callback(&login, &query));
    }
    #[test]
    fn rejects_missing_duplicate_expired_and_foreign_callbacks() {
        let login = pending();
        let query = callback(&login);
        assert!(!accept_callback(&DesktopSigninState::default(), &query));
        assert!(!accept_callback(&pending(), &query));
        assert!(!accept_callback(&login, "desktop_ticket=grant"));
        assert!(!accept_callback(&login, &format!("{query}&state=extra")));
        assert!(!accept_callback(
            &login,
            &format!("{query}&desktop_ticket=extra")
        ));
        login.0.lock().unwrap().as_mut().unwrap().started = Instant::now() - LIFETIME;
        assert!(!accept_callback(&login, &query));
    }
}
