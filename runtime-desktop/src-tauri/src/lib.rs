// Runtime desktop shell.
//
// The window loads the hosted Runtime web UI directly (which itself opens the
// terminal WebSocket straight to the Daytona box), so this native layer stays
// thin: a window whose close button quits the app, a tray menu,
// single-instance focus, and self-update for the native parts (updater.rs).
//
// Auth: signup and onboarding run in the system browser. The final desktop
// choice returns a short-lived, PKCE-bound grant to create a separate webview
// session. Provider linking still uses the legacy loopback OAuth callback.

mod claude_login;
mod desktop_signin;
mod import;
mod local_runtime;
mod managed_claude;
mod updater;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    window::Color,
    Manager, RunEvent, Theme, WebviewUrl, WebviewWindowBuilder,
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
        "https://app.outrunner.sh".to_string()
    }
}

/// Whether `url` is on [`site`]'s origin, for the navigation check: its
/// scheme, host and port, not its host alone, so `http://` or another port of
/// the same host never loads in the window. Derived from the site rather than
/// declared as a second constant, so the two cannot disagree.
fn same_origin(url: &tauri::Url, site: &tauri::Url) -> bool {
    url.scheme() == site.scheme()
        && url.host_str().is_some()
        && url.host_str() == site.host_str()
        && url.port_or_known_default() == site.port_or_known_default()
}

/// Whether an off-site navigation may go to the system's opener: web pages
/// and mail only. Any other scheme (`file:`, `smb:`, another app's own) would
/// have macOS open a file or launch an app on a link's say.
fn opens_externally(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "https" | "http" | "mailto")
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
<title>Signed in — outrunner</title>
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
    <p>You can close this tab and return to outrunner.</p>
  </main>
</body>
</html>"#;

/// Send an authorization callback into the webview so the code exchange (and
/// therefore the session cookie) happens there rather than in the browser.
/// Shared by the loopback listener and the deep-link fallback.
fn deliver_callback(app: &tauri::AppHandle, site: &str, query: &str) {
    // A browser onboarding handoff must match the native attempt. Never route
    // it through the legacy OAuth exchange or navigate before redeeming it.
    if tauri::Url::parse(&format!("http://localhost/?{query}"))
        .is_ok_and(|url| url.query_pairs().any(|(name, _)| name == "desktop_ticket"))
    {
        if desktop_signin::accept_callback(
            &app.state::<desktop_signin::DesktopSigninState>(),
            query,
        ) {
            show_main(app);
        }
        return;
    }
    let target = format!("{site}/auth/callback?{query}");
    if let (Some(window), Ok(parsed)) = (app.get_webview_window("main"), target.parse()) {
        let _ = window.navigate(parsed);
    }
    show_main(app);
}

/// Injected into the page so the web app knows it runs inside the desktop shell
/// and can route sign-in through the system browser.
const INIT_JS: &str = "window.__RUNTIME_DESKTOP__ = true;";

/// The app's dark background (globals.css `--background`, #060505), for the window
/// behind the page and its title bar.
const APP_BACKGROUND: Color = Color(6, 5, 5, 255);

/// Reveal + focus the main window (from the tray, dock, or a second launch).
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Give rustls its crypto provider. The updater's rustls-tls feature switches
/// every reqwest client in the app to rustls without one, and installs it only
/// before its own update check: until then building any client panics, the
/// local agent relay's included.
fn install_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // Fails only if another thread installed one first, which is as good.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_crypto_provider();
    tauri::Builder::default()
        .manage(claude_login::ClaudeLoginState::default())
        .manage(desktop_signin::DesktopSigninState::default())
        .manage(local_runtime::LocalRuntime::default())
        .manage(updater::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            desktop_signin::desktop_signin_start,
            desktop_signin::desktop_signin_poll,
            claude_login::connect_claude_start,
            claude_login::connect_claude_submit,
            claude_login::connect_claude_poll,
            claude_login::connect_claude_debug,
            claude_login::connect_claude_cancel,
            local_runtime::local_status,
            local_runtime::local_claude_login,
            local_runtime::local_claude_login_cancel,
            local_runtime::local_codex_login,
            local_runtime::local_codex_login_cancel,
            local_runtime::local_claude_setup,
            local_runtime::local_pick_folder,
            local_runtime::local_check_folder,
            local_runtime::local_clone_repo,
            local_runtime::local_list_sessions,
            local_runtime::local_agent_request,
            local_runtime::local_socket_open,
            local_runtime::local_socket_send,
            local_runtime::local_socket_close,
            import::import_scan,
            import::import_session,
            import::import_environment,
            import::import_config,
            updater::update_status,
            updater::restart_to_update,
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
            let site_url: tauri::Url = site.parse().unwrap();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(site_url.clone()))
                .title("outrunner")
                // Dark, like the app: what shows before the page has painted,
                // and on a Mac the title bar, take its background, not the
                // system grey.
                .theme(Some(Theme::Dark))
                .background_color(APP_BACKGROUND);
            #[cfg(target_os = "macos")]
            let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent);
            builder
                // Leave room for the sidebar, conversation, and inspector.
                .inner_size(1440.0, 900.0)
                .min_inner_size(720.0, 480.0)
                .initialization_script(INIT_JS)
                // Files dropped on the window go to the page, as in a browser:
                // the composer takes images that way. Tauri's own handler would
                // keep them for drag-drop events the app doesn't listen for.
                .disable_drag_drop_handler()
                // A reload drops the page's ends of any relayed local-session
                // sockets; close ours so none keeps the terminal's writer slot.
                .on_page_load(|window, payload| {
                    if payload.event() == PageLoadEvent::Started {
                        window.state::<local_runtime::LocalRuntime>().close_all_sockets();
                    }
                })
                .on_navigation(move |url| {
                    // Allow the app's own pages and internal webview loads.
                    if same_origin(url, &site_url) || matches!(url.scheme(), "about" | "data" | "blob") {
                        return true;
                    }
                    // Web pages elsewhere (OAuth provider, external links) open
                    // in the system browser instead of the embedded webview;
                    // anything else goes nowhere.
                    if opens_externally(url) {
                        let _ = open::that(url.as_str());
                    }
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
            let show_i = MenuItem::with_id(app, "show", "Show outrunner", true, None::<&str>)?;
            let new_i = MenuItem::with_id(app, "new", "New Workspace", true, None::<&str>)?;
            let reload_i = MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let update_i =
                MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit outrunner", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&show_i, &new_i, &reload_i, &sep, &update_i, &quit_i])?;

            TrayIconBuilder::with_id("tray")
                // The app icon's "o" alone, as a template image: macOS tints
                // it for a light or dark menu bar, where the app icon's tile
                // would sit as a dark square.
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("outrunner")
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
            // Outrunner's own Claude Code, if it runs one, follows Anthropic's
            // releases; a Mac whose own Claude Code works has nothing to update.
            tauri::async_runtime::spawn(managed_claude::refresh());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Outrunner")
        .run(|app, event| {
            // Closing the only window quits the app. Stop the local agent on
            // quit; tmux keeps its Claude sessions running, and the next
            // launch's agent reattaches to them.
            if let RunEvent::Exit = event {
                app.state::<local_runtime::LocalRuntime>().shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_sites_own_origin_loads_in_the_window() {
        let site: tauri::Url = "https://app.outrunner.sh".parse().unwrap();
        let at = |u: &str| super::same_origin(&u.parse().unwrap(), &site);
        assert!(at("https://app.outrunner.sh/sessions/1"));
        assert!(at("https://app.outrunner.sh:443/"));
        assert!(!at("http://app.outrunner.sh/"));
        assert!(!at("https://app.outrunner.sh:8443/"));
        assert!(!at("https://evil.example/"));
        assert!(!at("file:///Users/x/app.outrunner.sh"));
    }

    #[test]
    fn only_web_and_mail_links_go_to_the_systems_opener() {
        let opens = |u: &str| super::opens_externally(&u.parse().unwrap());
        assert!(opens("https://github.com/login/oauth/authorize"));
        assert!(opens("http://example.com/"));
        assert!(opens("mailto:hi@example.com"));
        assert!(!opens("file:///Users/x/Downloads/evil.app"));
        assert!(!opens("smb://attacker/share"));
        assert!(!opens("vscode://file/etc/passwd"));
        assert!(!opens("javascript:alert(1)"));
    }

    #[test]
    fn http_clients_build_once_the_crypto_provider_is_installed() {
        super::install_crypto_provider();
        // Without it: "No rustls crypto provider is configured".
        let _ = reqwest::Client::new();
    }
}
