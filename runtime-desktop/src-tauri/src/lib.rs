// Runtime desktop shell.
//
// The window loads the hosted Runtime web UI directly (which itself opens the
// terminal WebSocket straight to the Daytona box), so this native layer stays
// thin: a tray-resident window, a tray menu, hide-to-tray on close,
// single-instance focus, and self-update for the native parts (updater.rs).
//
// Auth: GitHub OAuth is completed in the system browser, not the embedded
// webview — providers block embedded webviews, and the browser's URL bar is the
// user's anti-phishing signal. We (1) flag the page as running in the desktop
// app, (2) open any off-site navigation (the OAuth provider) in the system
// browser, and (3) receive the authorization code back and hand it to the
// webview's own `/auth/callback`, so the PKCE verifier never leaves the webview
// and the session cookie lands in the right jar.
//
// The code comes back over a LOOPBACK redirect (`http://127.0.0.1:PORT/`), which
// RFC 8252 recommends for native apps. The `runtime://` deep link is kept as a
// fallback: on macOS a custom scheme only resolves once the .app bundle is
// registered with Launch Services, so it silently does nothing under
// `tauri dev`, and any app may claim the same scheme. Loopback needs no OS
// registration and takes an ordinary http entry in the provider's allowlist.

mod claude_login;
mod local_runtime;
mod updater;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;

/// Port the loopback OAuth listener binds. Fixed rather than
/// OS-assigned (which RFC 8252 prefers) for one practical reason: the web app
/// has to name this URL in `redirectTo`, and the provider has to allowlist it.
/// A fixed port keeps both sides free of any Tauri-specific plumbing.
pub const OAUTH_PORT: u16 = 47823;

/// Where the shell points. Hardcoding production meant a debug build could only
/// ever exercise the deployed site, so a local change was untestable through the
/// desktop app. `OUTRUNNER_SITE` overrides; otherwise debug targets the local dev
/// server and release the hosted site.
fn site() -> String {
    if let Ok(url) = std::env::var("OUTRUNNER_SITE") {
        if !url.trim().is_empty() {
            return url.trim().trim_end_matches('/').to_string();
        }
    }
    if cfg!(debug_assertions) {
        "http://localhost:3000".to_string()
    } else {
        "https://outrunner.neev.ai".to_string()
    }
}

/// Host of [`site`], for the same-site navigation check. Derived rather than
/// declared as a second constant, so the two cannot disagree.
fn site_host(site: &str) -> String {
    site.parse::<tauri::Url>()
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default()
}

/// What the browser tab is left showing after the redirect. Styled to match the
/// app (same background, wordmark and muted type) so the hand-off does not look
/// like it landed on a stray local server — which, mechanically, it did.
///
/// Self-contained: no external CSS or webfont, because this renders from a
/// loopback server with no relationship to the app's asset pipeline, and a
/// blocking font request would flash unstyled text at the one moment the user
/// is deciding whether sign-in worked.
const SIGNED_IN_PAGE: &str = r#"<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed in — Outrunner</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: grid;
    place-items: center;
    background: #0A0A0A;
    color: #FAFAFA;
    font: 15px/1.6 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    text-align: center;
    padding: 24px;
  }
  .wordmark {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.01em;
    margin-bottom: 28px;
  }
  .check {
    width: 34px; height: 34px;
    margin: 0 auto 18px;
    border-radius: 999px;
    border: 1px solid #2A2A2A;
    display: grid; place-items: center;
  }
  .check svg { width: 16px; height: 16px; stroke: #FAFAFA; }
  h1 { font-size: 15px; font-weight: 500; margin: 0 0 6px; }
  p  { font-size: 13px; margin: 0; color: #8F8F8F; }
</style>
<body>
  <main>
    <div class="wordmark">&gt;_ outrunner</div>
    <div class="check" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
    </div>
    <h1>Signed in</h1>
    <p>You can close this tab and return to Outrunner.</p>
  </main>
</body>
</html>"#;

/// Send an authorization callback into the webview so the code exchange (and
/// therefore the session cookie) happens there rather than in the browser.
/// Shared by the loopback listener and the deep-link fallback.
fn deliver_callback(app: &tauri::AppHandle, site: &str, query: &str) {
    let target = format!("{site}/auth/callback?{query}");
    if let (Some(window), Ok(parsed)) = (app.get_webview_window("main"), target.parse()) {
        let _ = window.navigate(parsed);
    }
    show_main(app);
}

/// Injected into the page so the web app knows it runs inside the desktop shell
/// and can route sign-in through the system browser.
const INIT_JS: &str = "window.__RUNTIME_DESKTOP__ = true;";

/// Reveal + focus the main window (from the tray, dock, or a second launch).
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(claude_login::ClaudeLoginState::default())
        .manage(local_runtime::LocalRuntime::default())
        .manage(updater::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            claude_login::connect_claude_start,
            claude_login::connect_claude_submit,
            claude_login::connect_claude_poll,
            claude_login::connect_claude_debug,
            claude_login::connect_claude_cancel,
            local_runtime::local_status,
            local_runtime::local_claude_login,
            local_runtime::local_claude_login_cancel,
            local_runtime::local_pick_folder,
            local_runtime::local_check_folder,
            local_runtime::local_list_sessions,
            local_runtime::local_agent_request,
            local_runtime::local_socket_open,
            local_runtime::local_socket_send,
            local_runtime::local_socket_close,
        ])
        // Must be registered first: focus the existing window instead of
        // spawning a second instance (and forward any deep link it carried).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Main window → hosted Runtime UI, flagged as the desktop shell, with
            // off-site navigations (OAuth) bounced to the system browser.
            let site = site();
            let site_host = site_host(&site);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(site.parse().unwrap()))
                .title("Outrunner")
                .inner_size(1280.0, 860.0)
                .min_inner_size(720.0, 480.0)
                .initialization_script(INIT_JS)
                // A reload drops the page's ends of any relayed local-session
                // sockets; close ours so none keeps the terminal's writer slot.
                .on_page_load(|window, payload| {
                    if payload.event() == PageLoadEvent::Started {
                        window.state::<local_runtime::LocalRuntime>().close_all_sockets();
                    }
                })
                .on_navigation(move |url| {
                    let scheme = url.scheme();
                    let same_site = url.host_str() == Some(site_host.as_str());
                    // Allow the app's own pages and internal webview loads.
                    if same_site || matches!(scheme, "about" | "data" | "blob") {
                        return true;
                    }
                    // Everything else (OAuth provider, external links) opens in
                    // the system browser instead of the embedded webview.
                    let _ = open::that(url.as_str());
                    false
                })
                .build()?;

            // Primary path: a loopback listener on a fixed port. The browser
            // redirects here with the code, and we hand it to the webview.
            let oauth_handle = app.handle().clone();
            let oauth_site = site.clone();
            if let Err(error) = tauri_plugin_oauth::start_with_config(
                tauri_plugin_oauth::OauthConfig {
                    ports: Some(vec![OAUTH_PORT]),
                    // Sent to the BROWSER tab, which is left sitting on the
                    // redirect. The app itself focuses via deliver_callback.
                    response: Some(SIGNED_IN_PAGE.into()),
                    // No 302: the browser tab stays on the confirmation above
                    // rather than being bounced somewhere.
                    redirect_uri: None,
                },
                move |url| {
                    // `url` is the full loopback request; only its query matters.
                    if let Ok(parsed) = url.parse::<tauri::Url>() {
                        let query = parsed.query().unwrap_or("").to_string();
                        deliver_callback(&oauth_handle, &oauth_site, &query);
                    }
                },
            ) {
                // Non-fatal: a busy port costs sign-in, not the whole app, and
                // the deep-link fallback below may still carry it.
                eprintln!("could not start the OAuth listener on {OAUTH_PORT}: {error}");
            }

            // Fallback: the `runtime://` deep link. Only resolves on macOS once
            // the bundle is registered with Launch Services, so it cannot be the
            // primary path — but it costs nothing to keep.
            let handle = app.handle().clone();
            let deep_link_site = site.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if url.scheme() != "runtime" {
                        continue;
                    }
                    deliver_callback(&handle, &deep_link_site, url.query().unwrap_or(""));
                }
            });

            // Tray menu.
            let show_i = MenuItem::with_id(app, "show", "Show Outrunner", true, None::<&str>)?;
            let new_i = MenuItem::with_id(app, "new", "New Workspace", true, None::<&str>)?;
            let reload_i = MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let update_i =
                MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Outrunner", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&show_i, &new_i, &reload_i, &sep, &update_i, &quit_i])?;

            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Outrunner")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event({
                    let tray_site = site.clone();
                    move |app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "new" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.navigate(format!("{tray_site}/new").parse().unwrap());
                        }
                        show_main(app);
                    }
                    "reload" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("location.reload()");
                        }
                    }
                    "check_updates" => updater::check_now(app),
                    "quit" => app.exit(0),
                    _ => {}
                }})
                .on_tray_icon_event(|tray, event| {
                    // Left-click toggles the window like a menu-bar app.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                show_main(app);
                            }
                        }
                    }
                })
                .build(app)?;

            updater::start(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it to the tray instead of quitting; use
            // the tray's "Quit Outrunner" to exit. Keeps the session reachable.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Outrunner")
        .run(|app, event| {
            // Stop the local agent on quit. tmux keeps its Claude sessions
            // running, and the next launch's agent reattaches to them.
            if let RunEvent::Exit = event {
                app.state::<local_runtime::LocalRuntime>().shutdown();
            }
        });
}
