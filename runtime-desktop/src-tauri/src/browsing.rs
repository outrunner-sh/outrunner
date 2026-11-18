// What the app's windows do with links, new windows and downloads.
//
// A WKWebView on its own does none of what a browser's chrome does: it refuses
// every `window.open` and `target="_blank"` link unless the app takes them,
// drops every download unless the app takes it, and has no Back button. So:
//
// - A page on the site loads in the window; any other web page (or mail link)
//   opens in the system's browser, and anything else nowhere.
// - A new window for the site (a Canvas file, a reply's image) opens as a
//   window of the app's own, sharing the main window's sign-in. One for
//   anywhere else goes to the browser, as a navigation would.
// - A download is saved to ~/Downloads (numbered past a file already there,
//   as a browser does) and shown in Finder when it's done.

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
};

use tauri::{
    webview::{DownloadEvent, NewWindowFeatures, NewWindowResponse},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_plugin_opener::OpenerExt;

/// Whether `url` is on `site`'s origin: its scheme, host and port (the spec's
/// tuple origin), not its host alone, so `http://` or another port of the same
/// host never loads in a window. A `file:` or `data:` URL's origin is opaque
/// and equals none.
pub fn same_origin(url: &Url, site: &Url) -> bool {
    url.origin() == site.origin()
}

/// Whether an off-site URL may go to the system's opener: web pages and mail
/// only. Any other scheme (`file:`, `smb:`, another app's own) would have macOS
/// open a file or launch an app on a link's say.
pub fn opens_externally(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http" | "mailto")
}

/// Whether a window may load `url` itself: the site's pages, and the
/// webview's own internal loads.
fn loads_in_window(url: &Url, site: &Url) -> bool {
    same_origin(url, site) || matches!(url.scheme(), "about" | "data" | "blob")
}

/// Hand an off-site URL to the system's browser, or drop it. Only the scheme
/// is logged: a URL's query may hold a token.
fn open_elsewhere(url: &Url) {
    if opens_externally(url) {
        if let Err(error) = open::that(url.as_str()) {
            eprintln!("could not open a {}: URL externally: {error}", url.scheme());
        }
    } else {
        eprintln!("blocked a link to a {}: URL", url.scheme());
    }
}

/// Give a window the app's handling of navigations, new windows and
/// downloads. The main window and every window it opens get the same.
pub fn browse<'a, M: Manager<Wry>>(
    builder: WebviewWindowBuilder<'a, Wry, M>,
    app: &AppHandle,
    site: &Url,
) -> WebviewWindowBuilder<'a, Wry, M> {
    let navigation_site = site.clone();
    let window_site = site.clone();
    let app = app.clone();
    builder
        .on_navigation(move |url| {
            if loads_in_window(url, &navigation_site) {
                return true;
            }
            open_elsewhere(url);
            false
        })
        .on_new_window(move |url, features| {
            if same_origin(&url, &window_site) {
                match open_site_window(&app, &window_site, features) {
                    Ok(window) => return NewWindowResponse::Create { window },
                    Err(error) => eprintln!("could not open a window: {error}"),
                }
            } else {
                // `about:blank` included: a page that opens one to fill in
                // later gets null, as from a blocked pop-up, rather than an
                // empty window it may never fill.
                open_elsewhere(&url);
            }
            NewWindowResponse::Deny
        })
        .on_download(|webview, event| {
            let downloads = webview.state::<Downloads>();
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let Ok(folder) = webview.path().download_dir() else {
                        eprintln!("refused a download: no Downloads folder");
                        return false;
                    };
                    downloads.requested(url.as_str(), destination, &folder)
                }
                DownloadEvent::Finished { url, success, .. } => {
                    if let Some(path) = downloads.finished(url.as_str()) {
                        if success {
                            if let Err(error) = webview.opener().reveal_item_in_dir(&path) {
                                eprintln!("could not show a download in Finder: {error}");
                            }
                        }
                    }
                    true
                }
                _ => true,
            }
        })
}

/// A window of the app's own for a page of the site a page opened, sharing
/// the opener's webview configuration (its cookies, so its sign-in). It gets
/// no commands: the capability names the main window alone.
fn open_site_window(
    app: &AppHandle,
    site: &Url,
    features: NewWindowFeatures,
) -> tauri::Result<WebviewWindow> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let label = format!("site-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    // The webview loads the page itself once it's handed back; until then
    // it shows nothing.
    let blank = WebviewUrl::External("about:blank".parse().expect("about:blank is a URL"));
    let builder = WebviewWindowBuilder::new(app, label, blank)
        .title("outrunner")
        .theme(Some(tauri::Theme::Dark))
        .background_color(crate::APP_BACKGROUND)
        .inner_size(1100.0, 800.0)
        .min_inner_size(480.0, 360.0)
        // Last, so a size the page asked for wins over the default above.
        .window_features(features)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        });
    browse(builder, app, site).build()
}

/// Where each download in progress is being saved, by its URL: WebKit says
/// where a download went only when it starts. A URL downloaded twice at once
/// finishes in the order it started, near enough for showing it in Finder.
#[derive(Default)]
pub struct Downloads(Mutex<Vec<(String, PathBuf)>>);

impl Downloads {
    /// Take a download WebKit is about to save at `destination`: wry has put
    /// it in the Downloads `folder` under the name the response suggests,
    /// numbered past any file already there. Refused if that name would leave
    /// the folder.
    fn requested(&self, url: &str, destination: &Path, folder: &Path) -> bool {
        if !saves_in(folder, destination) {
            eprintln!("refused a download outside the Downloads folder");
            return false;
        }
        self.pending()
            .push((url.to_string(), destination.to_path_buf()));
        true
    }

    /// The list, past a panic that held it: it's only ever pushed to and
    /// taken from whole.
    fn pending(&self) -> MutexGuard<'_, Vec<(String, PathBuf)>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Where the download of `url` that finished was saved, if it was taken.
    fn finished(&self, url: &str) -> Option<PathBuf> {
        let mut pending = self.pending();
        let at = pending.iter().position(|(started, _)| started == url)?;
        Some(pending.remove(at).1)
    }
}

/// Whether `destination` is a file directly in `folder`: its name a plain
/// one, neither a hidden file nor a way out of the folder.
fn saves_in(folder: &Path, destination: &Path) -> bool {
    let Some(name) = destination.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    destination.parent() == Some(folder) && !name.starts_with('.')
}

#[cfg(test)]
mod tests {
    use std::path::Path;

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

        let loads = |u: &str| super::loads_in_window(&u.parse().unwrap(), &site);
        assert!(loads("about:blank"));
        assert!(loads("blob:https://app.outrunner.sh/1f0e"));
        assert!(!loads("https://github.com/"));
    }

    #[test]
    fn only_web_and_mail_links_go_to_the_systems_opener() {
        let opens = |u: &str| super::opens_externally(&u.parse().unwrap());
        assert!(opens("https://github.com/login/oauth/authorize"));
        assert!(opens("http://example.com/"));
        assert!(opens("mailto:hi@example.com"));
        assert!(!opens("about:blank"));
        assert!(!opens("file:///Users/x/Downloads/evil.app"));
        assert!(!opens("smb://attacker/share"));
        assert!(!opens("vscode://file/etc/passwd"));
        assert!(!opens("javascript:alert(1)"));
    }

    #[test]
    fn downloads_save_only_as_plain_files_in_the_folder() {
        let folder = Path::new("/Users/x/Downloads");
        let saves = |p: &str| super::saves_in(folder, Path::new(p));
        assert!(saves("/Users/x/Downloads/outrunner-slack-icon.png"));
        assert!(saves("/Users/x/Downloads/report (1).pdf"));
        assert!(!saves("/Users/x/Downloads/.zshrc"));
        assert!(!saves("/Users/x/Downloads/sub/file.png"));
        assert!(!saves("/Users/x/Library/LaunchAgents/evil.plist"));
        assert!(!saves("/Users/x/Downloads/../.ssh/authorized_keys"));
        assert!(!saves("/Users/x/Downloads"));
    }

    #[test]
    fn a_finished_download_is_found_by_its_url_once() {
        let downloads = super::Downloads::default();
        let folder = Path::new("/Users/x/Downloads");
        let first = folder.join("a.png");
        let second = folder.join("a (1).png");
        let hidden = folder.join(".a.png");
        assert!(downloads.requested("https://app.outrunner.sh/a", &first, folder));
        assert!(downloads.requested("https://app.outrunner.sh/a", &second, folder));
        assert!(!downloads.requested("https://app.outrunner.sh/b", &hidden, folder));
        assert_eq!(
            downloads.finished("https://app.outrunner.sh/a"),
            Some(first)
        );
        assert_eq!(
            downloads.finished("https://app.outrunner.sh/a"),
            Some(second)
        );
        assert_eq!(downloads.finished("https://app.outrunner.sh/a"), None);
        assert_eq!(downloads.finished("https://app.outrunner.sh/b"), None);
    }
}
