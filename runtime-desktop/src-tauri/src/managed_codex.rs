//! Outrunner's own copy of Codex, for a Mac whose own is missing or too old to
//! run a session (managed_claude.rs does the same for Claude Code).
//!
//! It is OpenAI's release package from GitHub (`codex-package-<target>.tar.zst`,
//! the layout npm installs: `bin/codex`, its `codex-code-mode-host`, and
//! `codex-path/rg`), checked against the SHA-256 digest GitHub publishes for it
//! and unpacked with the system's tar, without the package's voice libraries.
//! It lives in `~/.outrunner/codex/<version>` and is never put on the user's
//! PATH: only Outrunner runs it, through the link
//! [`crate::local_runtime::find_codex`] makes. Set up only for a user who
//! chooses Codex.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::managed_claude::{Setup, Version};

const LATEST_RELEASE: &str = "https://api.github.com/repos/openai/codex/releases/latest";

/// The oldest Codex a session runs on. 0.138's models are refused to a ChatGPT
/// login ("not supported when using Codex with a ChatGPT account"); 0.162's
/// work.
pub(crate) const MIN_VERSION: Version = Version::new(0, 162, 0);

/// What `codex --version` prints: "codex-cli 0.162.1".
pub(crate) fn parse_version(out: &str) -> Option<Version> {
    let rest = out.trim().strip_prefix("codex-cli")?;
    Version::parse(rest.trim())
}

static SETUP: Mutex<Option<Setup>> = Mutex::new(None);
static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) fn setup_status() -> Option<Setup> {
    SETUP.lock().unwrap_or_else(PoisonError::into_inner).clone()
}

fn set_setup(setup: Option<Setup>) {
    *SETUP.lock().unwrap_or_else(PoisonError::into_inner) = setup;
}

fn versions_dir() -> Option<PathBuf> {
    crate::local_runtime::root_dir().ok().map(|root| root.join("codex"))
}

/// Whether `path` is (in) one of Outrunner's copies.
pub(crate) fn is_managed(path: &Path) -> bool {
    versions_dir().is_some_and(|dir| path.starts_with(dir))
}

/// The newest copy on disk, if any: its version and its `codex`.
pub(crate) fn installed() -> Option<(Version, PathBuf)> {
    newest_in(&versions_dir()?)
}

fn newest_in(dir: &Path) -> Option<(Version, PathBuf)> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let version = Version::parse(entry.file_name().to_str()?)?;
            let codex = entry.path().join("bin").join("codex");
            codex.is_file().then_some((version, codex))
        })
        .max_by_key(|(version, _)| *version)
}

/// Set the copy up in the background, unless that is already under way.
pub(crate) fn start() {
    {
        let mut setup = SETUP.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(*setup, Some(Setup::Installing { .. })) {
            return;
        }
        *setup = Some(Setup::Installing { received: 0, total: 0 });
    }
    tauri::async_runtime::spawn(async {
        let _ = ensure().await;
    });
}

/// The copy that runs, downloading the latest release first when there is
/// none. Sessions are then pointed at it.
pub(crate) async fn ensure() -> Result<PathBuf, String> {
    let _one = INSTALL.lock().await;
    let result = match installed_that_runs().await {
        Some(codex) => Ok(codex),
        None => {
            set_setup(Some(Setup::Installing { received: 0, total: 0 }));
            install(true).await
        }
    };
    match &result {
        Ok(_) => {
            set_setup(None);
            relink().await;
        }
        Err(message) => set_setup(Some(Setup::Failed { message: message.clone() })),
    }
    result
}

/// Bring the copy up to the latest release, quietly, when it is the one
/// sessions run. Once per launch.
pub(crate) async fn refresh() {
    let Some((have, _)) = installed() else { return };
    if !crate::local_runtime::linked_codex().is_some_and(|codex| is_managed(&codex)) {
        return;
    }
    let Ok(client) = client() else { return };
    match latest(&client).await {
        Ok(release) if release.version > have => {}
        _ => return,
    }
    let _one = INSTALL.lock().await;
    if install(false).await.is_ok() {
        relink().await;
    }
}

async fn installed_that_runs() -> Option<PathBuf> {
    let (_, codex) = installed()?;
    let runs = {
        let codex = codex.clone();
        tauri::async_runtime::spawn_blocking(move || crate::local_runtime::codex_version(&codex).is_some())
    };
    if runs.await.unwrap_or(false) {
        return Some(codex);
    }
    // Damaged: drop it, so the download below replaces it.
    if let Some(dir) = codex.parent().and_then(Path::parent) {
        let _ = std::fs::remove_dir_all(dir);
    }
    None
}

async fn relink() {
    let _ = tauri::async_runtime::spawn_blocking(crate::local_runtime::find_codex).await;
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        // GitHub's API refuses a request without one.
        .user_agent("Outrunner")
        .build()
        .map_err(|error| error.to_string())
}

/// The latest release's package for this Mac.
#[derive(Debug)]
struct Release {
    version: Version,
    url: String,
    sha256: String,
    size: u64,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

async fn latest(client: &reqwest::Client) -> Result<Release, String> {
    let release: GithubRelease = get(client, LATEST_RELEASE).await?.json().await.map_err(net)?;
    release_for(release, target())
}

/// This Mac's package in a release, with its digest checked for shape. The
/// download URL must be GitHub's own, whatever the API answered.
fn release_for(release: GithubRelease, target: &str) -> Result<Release, String> {
    let version = release
        .tag_name
        .strip_prefix("rust-v")
        .and_then(Version::parse)
        .ok_or("Codex's latest release has no version in its name.")?;
    let name = format!("codex-package-{target}.tar.zst");
    let asset = release
        .assets
        .into_iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| format!("Codex {version} has no build for {target}."))?;
    let sha256 = asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("Codex's release publishes no checksum for its package.")?
        .to_string();
    if !asset.browser_download_url.starts_with("https://github.com/openai/codex/releases/download/") {
        return Err("Codex's release points somewhere other than GitHub.".into());
    }
    Ok(Release { version, url: asset.browser_download_url, sha256, size: asset.size })
}

/// Download the latest release into its own folder, verified and unpacked, and
/// drop the older copies. `report` shows the progress on the page.
async fn install(report: bool) -> Result<PathBuf, String> {
    let client = client()?;
    let release = latest(&client).await?;
    let dir = versions_dir().ok_or("Outrunner has no home folder to keep Codex in.")?;
    std::fs::create_dir_all(&dir).map_err(io)?;
    let staging = dir.join(format!(".download-{}", crate::local_runtime::random_hex(4)));
    std::fs::create_dir_all(&staging).map_err(io)?;
    let result = async {
        let package = staging.join("codex-package.tar.zst");
        download(&client, &release, &package, report).await?;
        let (package_path, out) = (package.clone(), staging.clone());
        tauri::async_runtime::spawn_blocking(move || unpack(&package_path, &out))
            .await
            .map_err(|error| error.to_string())??;
        let _ = std::fs::remove_file(&package);
        let codex = staging.join("bin").join("codex");
        let runs = {
            let codex = codex.clone();
            tauri::async_runtime::spawn_blocking(move || crate::local_runtime::codex_version(&codex))
                .await
                .map_err(|error| error.to_string())?
        };
        if runs != Some(release.version) {
            return Err(format!("Codex {} didn't run after unpacking.", release.version));
        }
        let target = dir.join(release.version.to_string());
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&staging, &target).map_err(io)?;
        Ok(target.join("bin").join("codex"))
    }
    .await;
    match &result {
        Ok(codex) => prune(&dir, codex),
        Err(_) => {
            let _ = std::fs::remove_dir_all(&staging);
        }
    }
    result
}

/// Remove every copy but the one `keep` is in, and any unfinished download.
fn prune(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        if !keep.starts_with(entry.path()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Stream the package into `path`, failing unless it is exactly the size and
/// SHA-256 GitHub publishes for it.
async fn download(client: &reqwest::Client, release: &Release, path: &Path, report: bool) -> Result<(), String> {
    let mut response = get(client, &release.url).await?;
    let mut file = std::fs::File::create(path).map_err(io)?;
    let mut hash = Sha256::new();
    let mut received = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(net)? {
        received += chunk.len() as u64;
        if received > release.size {
            return Err("Codex's download was larger than its release says.".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(io)?;
        if report {
            set_setup(Some(Setup::Installing { received, total: release.size }));
        }
    }
    file.sync_all().map_err(io)?;
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if received != release.size || !got.eq_ignore_ascii_case(&release.sha256) {
        return Err("Codex's download didn't match its checksum.".into());
    }
    Ok(())
}

/// Unpack what a session needs from a verified package: the binary, its helper
/// and ripgrep, and the layout file. macOS's tar reads zstd itself.
fn unpack(package: &Path, out: &Path) -> Result<(), String> {
    let status = Command::new("/usr/bin/tar")
        .arg("-xf")
        .arg(package)
        .arg("-C")
        .arg(out)
        .args(["bin", "codex-path", "codex-package.json"])
        .status()
        .map_err(io)?;
    if !status.success() {
        return Err("Couldn't unpack Codex.".into());
    }
    Ok(())
}

async fn get(client: &reqwest::Client, url: &str) -> Result<reqwest::Response, String> {
    let response = client.get(url).send().await.map_err(net)?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {} for Codex's release.", response.status()));
    }
    Ok(response)
}

/// The release's name for this Mac. An Intel build under Rosetta on Apple
/// silicon still gets the native one.
fn target() -> &'static str {
    if cfg!(target_arch = "aarch64") || crate::managed_claude::under_rosetta() {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    }
}

fn net(error: reqwest::Error) -> String {
    format!("Couldn't download Codex: {error}")
}

fn io(error: std::io::Error) -> String {
    format!("Couldn't save Codex: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_codexs_version() {
        assert_eq!(parse_version("codex-cli 0.162.1\n"), Some(Version::new(0, 162, 1)));
        assert_eq!(parse_version("codex-cli 0.138.0"), Some(Version::new(0, 138, 0)));
        assert!(Version::new(0, 138, 0) < MIN_VERSION && MIN_VERSION <= Version::new(0, 162, 1));
        for junk in ["", "codex 1.0.0", "claude 2.1.0 (Claude Code)", "codex-cli"] {
            assert_eq!(parse_version(junk), None, "{junk:?}");
        }
    }

    fn release(assets: &str) -> GithubRelease {
        serde_json::from_str(&format!(r#"{{"tag_name":"rust-v0.162.1","assets":[{assets}]}}"#)).unwrap()
    }

    const HEX: &str = "dc06760225b926169df1e90944986484037890a85edbc3af8904097a901722ba";

    #[test]
    fn picks_this_macs_package_and_its_checksum() {
        let asset = |name: &str, digest: &str| {
            format!(
                r#"{{"name":"{name}","size":95822628,"digest":"{digest}","browser_download_url":"https://github.com/openai/codex/releases/download/rust-v0.162.1/{name}"}}"#
            )
        };
        let r = release(&[
            asset("codex-aarch64-apple-darwin.zst", &format!("sha256:{HEX}")),
            asset("codex-package-aarch64-apple-darwin.tar.zst", &format!("sha256:{HEX}")),
            asset("codex-package-x86_64-apple-darwin.tar.zst", &format!("sha256:{HEX}")),
        ]
        .join(","));
        let got = release_for(r, "aarch64-apple-darwin").unwrap();
        assert_eq!(got.version, Version::new(0, 162, 1));
        assert!(got.url.ends_with("/codex-package-aarch64-apple-darwin.tar.zst"));
        assert_eq!((got.sha256.as_str(), got.size), (HEX, 95822628));

        // No checksum, or a package served from elsewhere: nothing is downloaded.
        let unsigned = release(&asset("codex-package-aarch64-apple-darwin.tar.zst", ""));
        assert!(release_for(unsigned, "aarch64-apple-darwin").is_err());
        let elsewhere = release(&format!(
            r#"{{"name":"codex-package-aarch64-apple-darwin.tar.zst","size":1,"digest":"sha256:{HEX}","browser_download_url":"https://example.com/codex.tar.zst"}}"#
        ));
        assert!(release_for(elsewhere, "aarch64-apple-darwin").is_err());
    }

    #[test]
    fn the_newest_copy_on_disk_is_used() {
        let dir = std::env::temp_dir().join(format!("outrunner-codex-{}", crate::local_runtime::random_hex(4)));
        for (name, has_binary) in [("0.162.1", true), ("0.163.0", true), ("0.164.0", false)] {
            std::fs::create_dir_all(dir.join(name).join("bin")).unwrap();
            if has_binary {
                std::fs::write(dir.join(name).join("bin").join("codex"), "").unwrap();
            }
        }
        assert_eq!(newest_in(&dir), Some((Version::new(0, 163, 0), dir.join("0.163.0/bin/codex"))));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The real thing: the latest release, downloaded, verified, unpacked and
    /// run. `cargo test -- --ignored downloads_and_runs_the_latest_codex` (~100MB).
    #[test]
    #[ignore]
    fn downloads_and_runs_the_latest_codex() {
        let root = std::env::temp_dir().join(format!("outrunner-root-{}", crate::local_runtime::random_hex(4)));
        std::env::set_var("OUTRUNNER_ROOT", &root);
        crate::install_crypto_provider();
        let codex = tauri::async_runtime::block_on(install(false)).expect("installs");
        assert!(is_managed(&codex));
        let version = crate::local_runtime::codex_version(&codex).expect("runs");
        assert!(version >= MIN_VERSION, "{version}");
        assert!(codex.parent().unwrap().join("codex-code-mode-host").is_file());
        assert_eq!(installed().map(|(v, _)| v), Some(version));
        let _ = std::fs::remove_dir_all(root);
    }
}
