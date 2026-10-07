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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// After launch, so the first check does not compete with the page loading.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(10);
/// The tray app may stay open for weeks; keep checking while it does.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub struct UpdateState {
    /// A check (and its download) is in flight. The background loop and the
    /// tray item must not install the same update twice at once.
    busy: AtomicBool,
    /// Version already installed on disk, waiting for a restart. Once set there
    /// is nothing more to fetch until the app restarts into it.
    installed: Mutex<Option<String>>,
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

    if let Some(version) = state.installed.lock().unwrap().clone() {
        if interactive {
            ask_to_restart(app, &version);
        }
        return;
    }
    if state.busy.swap(true, Ordering::SeqCst) {
        if interactive {
            inform(app, "Already checking", "Outrunner is already checking for an update.");
        }
        return;
    }

    let result = find_and_install(app).await;
    state.busy.store(false, Ordering::SeqCst);

    match result {
        Ok(Some(version)) => {
            *state.installed.lock().unwrap() = Some(version.clone());
            ask_to_restart(app, &version);
        }
        Ok(None) => {
            if interactive {
                let current = app.package_info().version.to_string();
                inform(app, "You're up to date", &format!("Outrunner {current} is the latest version."));
            }
        }
        Err(error) => {
            eprintln!("update check failed: {error}");
            if interactive {
                app.dialog()
                    .message(format!(
                        "Outrunner could not update.\n\n{error}\n\n\
                         If Outrunner is not in your Applications folder, move it there and try again."
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
            "Outrunner {version} is installed. Restart now to start using it?\n\n\
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

fn inform(app: &AppHandle, title: &str, message: &str) {
    app.dialog().message(message).title(title).kind(MessageDialogKind::Info).show(|_| {});
}
