// Self-update for the native shell.
//
// The UI is the hosted site, so most changes reach users with a web deploy and
// no update at all. This covers the rest: the Rust side, the bundled agent, the
// icon. Release builds check the manifest the publish workflow writes
// (`latest.json`, see tauri.conf.json `plugins.updater`) shortly after launch
// and every few hours. A newer version is downloaded, its signature checked
// against the public key built into this app, and installed over the current
// bundle in the background; the user is then asked to restart. "Later" is safe:
// the new bundle is already in place, so the next launch runs it.
//
// The tray's "Check for Updates…" runs the same check, but reports every
// outcome, including "up to date" and errors, which the background check keeps
// to the log.
//
// The page's sidebar shows an Update button while an installed update waits
// for a restart (`update_status`, the `update-ready` event, and
// `restart_to_update`), so "Later" isn't the last word on it.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::{Mutex, MutexGuard};

/// After launch, so the first check does not compete with the page loading.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(10);
/// The tray app may stay open for weeks; keep checking while it does.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// One lock for the whole check: holding it means a check (and its download)
/// is in flight, and its value is the version already installed on disk,
/// waiting for a restart. Keeping both behind the same lock is what stops the
/// background loop and the tray item installing one update twice: a check
/// that finishes records its version before anyone else can get in.
#[derive(Default)]
pub struct UpdateState {
    installed: Mutex<Option<String>>,
}

/// What a check may do, decided under the lock.
enum Gate<'a> {
    /// Another check is running.
    Busy,
    /// An update is installed already; nothing more to fetch until a restart.
    Installed(String),
    /// Go ahead. Write the installed version into the guard before dropping it.
    Run(MutexGuard<'a, Option<String>>),
}

impl UpdateState {
    /// The version installed and waiting for a restart. A check in flight
    /// holds the lock, and then nothing is installed yet.
    fn waiting(&self) -> Option<String> {
        self.installed.try_lock().ok().and_then(|installed| installed.clone())
    }

    fn enter(&self) -> Gate<'_> {
        match self.installed.try_lock() {
            Err(_) => Gate::Busy,
            Ok(guard) => match guard.clone() {
                Some(version) => Gate::Installed(version),
                None => Gate::Run(guard),
            },
        }
    }
}

/// Start the background checks. Debug builds (`tauri dev`) never update
/// themselves: they would replace a development build with a release.
pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            check(&app, false).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// The tray's "Check for Updates…".
pub fn check_now(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { check(&app, true).await });
}

/// `interactive` reports every outcome in a dialog; otherwise only a finished
/// install is shown, and nothing at all for "no update" or a failure.
async fn check(app: &AppHandle, interactive: bool) {
    let state = app.state::<UpdateState>();
    let mut installed = match state.enter() {
        Gate::Busy => {
            if interactive {
                inform(app, "Already checking", "outrunner is already checking for an update.");
            }
            return;
        }
        Gate::Installed(version) => {
            if interactive {
                ask_to_restart(app, &version);
            }
            return;
        }
        Gate::Run(guard) => guard,
    };

    let result = find_and_install(app).await;
    if let Ok(Some(version)) = &result {
        *installed = Some(version.clone());
    }
    drop(installed);

    match result {
        Ok(Some(version)) => {
            // The sidebar's Update button, live; ask_to_restart's dialog too.
            let _ = app.emit("update-ready", &version);
            ask_to_restart(app, &version);
        }
        Ok(None) => {
            if interactive {
                let current = app.package_info().version.to_string();
                inform(app, "You're up to date", &format!("outrunner {current} is the latest version."));
            }
        }
        Err(error) => {
            eprintln!("update check failed: {error}");
            if interactive {
                app.dialog()
                    .message(format!(
                        "outrunner could not update.\n\n{error}\n\n\
                         If outrunner is not in your Applications folder, move it there and try again."
                    ))
                    .title("Update failed")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    }
}

/// The version installed, or `None` when already on the latest.
async fn find_and_install(app: &AppHandle) -> Result<Option<String>, tauri_plugin_updater::Error> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(None);
    };
    // Verifies the signature before touching the installed bundle.
    update.download_and_install(|_, _| {}, || {}).await?;
    Ok(Some(update.version))
}

fn ask_to_restart(app: &AppHandle, version: &str) {
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "outrunner {version} is installed. Restart now to start using it?\n\n\
             Local sessions keep running and reconnect after the restart."
        ))
        .title("Update ready")
        .buttons(MessageDialogButtons::OkCancelCustom("Restart".into(), "Later".into()))
        .show(move |restart| {
            if restart {
                // Through the event loop, so RunEvent::Exit stops the local agent.
                handle.request_restart();
            }
        });
}

/// The version installed and waiting for a restart, for the sidebar's Update
/// button; none while a check is still in flight (nothing waits yet).
#[tauri::command]
pub fn update_status(state: State<'_, UpdateState>) -> Option<String> {
    fake_update().or_else(|| state.waiting())
}

/// The sidebar's Update button: restart into the installed update.
#[tauri::command]
pub fn restart_to_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    if update_status(state).is_none() {
        return Err("no-update".into());
    }
    // Through the event loop, so RunEvent::Exit stops the local agent.
    app.request_restart();
    Ok(())
}

/// Debug builds never update themselves, so `OUTRUNNER_FAKE_UPDATE=<version>`
/// pretends one is installed, to try the Update button.
fn fake_update() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("OUTRUNNER_FAKE_UPDATE").ok().filter(|version| !version.is_empty())
}

fn inform(app: &AppHandle, title: &str, message: &str) {
    app.dialog().message(message).title(title).kind(MessageDialogKind::Info).show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_in_flight_keeps_others_out() {
        let state = UpdateState::default();
        let Gate::Run(_held) = state.enter() else { panic!("first check should run") };
        assert!(matches!(state.enter(), Gate::Busy));
    }

    #[test]
    fn an_installed_update_is_never_fetched_again() {
        let state = UpdateState::default();
        let Gate::Run(mut guard) = state.enter() else { panic!("first check should run") };
        // As check() does: record the version, then let go.
        *guard = Some("0.2.1".into());
        drop(guard);
        // No window in which a second check sees neither "busy" nor "installed".
        assert!(matches!(state.enter(), Gate::Installed(v) if v == "0.2.1"));
        assert!(matches!(state.enter(), Gate::Installed(_)));
    }

    #[test]
    fn the_sidebar_sees_an_update_only_once_it_is_installed() {
        let state = UpdateState::default();
        assert_eq!(state.waiting(), None);
        let Gate::Run(mut guard) = state.enter() else { panic!("first check should run") };
        // Downloading: nothing to restart into yet.
        assert_eq!(state.waiting(), None);
        *guard = Some("0.2.1".into());
        drop(guard);
        assert_eq!(state.waiting().as_deref(), Some("0.2.1"));
    }

    #[test]
    fn a_check_that_found_nothing_lets_the_next_one_run() {
        let state = UpdateState::default();
        let Gate::Run(guard) = state.enter() else { panic!("first check should run") };
        drop(guard);
        assert!(matches!(state.enter(), Gate::Run(_)));
    }
}
