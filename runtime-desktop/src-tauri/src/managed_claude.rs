//! Outrunner's own copy of Claude Code, for a Mac whose own is missing, broken
//! or too old to run a session.
//!
//! It is Anthropic's native build, fetched the way Anthropic's installer
//! (claude.ai/install.sh) fetches it: the channel names a version, that
//! version's manifest gives each platform's SHA-256, and nothing is kept that
//! doesn't match. It lives in `~/.outrunner/claude/<version>/claude` and is
//! never put on the user's own PATH: only Outrunner runs it, through the link
//! [`crate::local_runtime::find_claude`] makes. Its own auto-updater stays off
//! (it would install Claude Code for the user's shell); [`refresh`] keeps it
//! current instead.

use std::fmt;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const RELEASES: &str = "https://downloads.claude.ai/claude-code-releases";
/// Anthropic's `stable` channel: a release that has had a week on `latest`.
const CHANNEL: &str = "stable";

/// The oldest Claude Code a session runs on. Older ones lack `--session-id`
/// (1.0.55), which a session in a plain folder starts with: Claude exits at
/// once, and the session is gone before its first prompt.
pub(crate) const MIN_VERSION: Version = Version(2, 0, 0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Version(u64, u64, u64);

impl Version {
    /// The version `claude --version` or a release channel starts with:
    /// "2.1.287 (Claude Code)", "2.1.287". A pre-release suffix is ignored.
    pub(crate) fn parse(text: &str) -> Option<Version> {
        let word = text.split_whitespace().next()?;
        let core = word.split(['-', '+']).next()?;
        let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
        let version = Version(parts.next()??, parts.next()??, parts.next()??);
        parts.next().is_none().then_some(version)
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// Setting up the copy, for the page to show; None when nothing is under way
/// and the last attempt didn't fail.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Setup {
    Installing { received: u64, total: u64 },
    Failed { message: String },
}

static SETUP: Mutex<Option<Setup>> = Mutex::new(None);
/// One download at a time, whoever asks.
static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) fn setup_status() -> Option<Setup> {
    SETUP.lock().unwrap_or_else(PoisonError::into_inner).clone()
}

fn set_setup(setup: Option<Setup>) {
    *SETUP.lock().unwrap_or_else(PoisonError::into_inner) = setup;
}

/// Where the copies live: `~/.outrunner/claude`, one folder per version.
fn versions_dir() -> Option<PathBuf> {
    crate::local_runtime::root_dir().ok().map(|root| root.join("claude"))
}

/// Whether `path` is one of Outrunner's copies.
pub(crate) fn is_managed(path: &Path) -> bool {
    versions_dir().is_some_and(|dir| path.starts_with(dir))
}

/// The newest copy on disk, if any.
pub(crate) fn installed() -> Option<(Version, PathBuf)> {
    newest_in(&versions_dir()?)
}

fn newest_in(dir: &Path) -> Option<(Version, PathBuf)> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let version = Version::parse(entry.file_name().to_str()?)?;
            let claude = entry.path().join("claude");
            claude.is_file().then_some((version, claude))
        })
        .max_by_key(|(version, _)| *version)
}

/// Set the copy up in the background, unless that is already under way. The
/// page follows it through [`setup_status`].
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

/// The copy that runs, downloading the channel's version first when there is
/// none. Sessions are then pointed at it.
pub(crate) async fn ensure() -> Result<PathBuf, String> {
    let _one = INSTALL.lock().await;
    let result = match installed_that_runs().await {
        Some(claude) => Ok(claude),
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

/// Bring the copy up to the channel's version, quietly, when it is the one
/// sessions run. Once per launch; a failure waits for the next.
pub(crate) async fn refresh() {
    let Some((have, _)) = installed() else { return };
    if !crate::local_runtime::linked_claude().is_some_and(|claude| is_managed(&claude)) {
        return;
    }
    let Ok(client) = client() else { return };
    match channel_version(&client).await {
        Ok(latest) if latest > have => {}
        _ => return,
    }
    let _one = INSTALL.lock().await;
    if install(false).await.is_ok() {
        relink().await;
    }
}

async fn installed_that_runs() -> Option<PathBuf> {
    let (_, claude) = installed()?;
    let runs = {
        let claude = claude.clone();
        tauri::async_runtime::spawn_blocking(move || crate::local_runtime::claude_version(&claude).is_some())
    };
    if runs.await.unwrap_or(false) {
        return Some(claude);
    }
    // Damaged: drop it, so the download below replaces it.
    if let Some(dir) = claude.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
    None
}

/// Point sessions at the Claude Code to run now.
async fn relink() {
    let _ = tauri::async_runtime::spawn_blocking(crate::local_runtime::find_claude).await;
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // Per read, not for the whole download: a slow connection is fine, a
        // stalled one is not.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())
}

async fn channel_version(client: &reqwest::Client) -> Result<Version, String> {
    let text = get(client, &format!("{RELEASES}/{CHANNEL}")).await?.text().await.map_err(net)?;
    // Anything else (an error page, a region block) must not reach a URL.
    Version::parse(text.trim()).ok_or_else(|| {
        "Claude Code's download service didn't answer with a version. It may not be available in your region.".into()
    })
}

/// One platform's file in a release manifest.
#[derive(Clone, Debug, Deserialize)]
struct Artifact {
    checksum: String,
    size: u64,
}

#[derive(Deserialize)]
struct Manifest {
    platforms: std::collections::HashMap<String, Artifact>,
}

async fn artifact(client: &reqwest::Client, url: &str, platform: &str) -> Result<Artifact, String> {
    let manifest: Manifest = get(client, url).await?.json().await.map_err(net)?;
    let artifact = manifest
        .platforms
        .get(platform)
        .cloned()
        .ok_or_else(|| format!("Claude Code has no build for {platform}."))?;
    let hex = artifact.checksum.len() == 64 && artifact.checksum.bytes().all(|b| b.is_ascii_hexdigit());
    if !hex || artifact.size == 0 {
        return Err("Claude Code's release manifest is malformed.".into());
    }
    Ok(artifact)
}

/// Download the channel's version into its own folder, verified, and drop the
/// older copies. `report` shows the progress on the page.
async fn install(report: bool) -> Result<PathBuf, String> {
    let client = client()?;
    let version = channel_version(&client).await?;
    let platform = platform();
    let base = format!("{RELEASES}/{version}");
    let binary = artifact(&client, &format!("{base}/manifest.json"), platform).await?;
    // The zstd file is about a third the size; the plain one is the fallback.
    let packed = artifact(&client, &format!("{base}/manifest.zst.json"), platform).await.ok();

    let dir = versions_dir().ok_or("Outrunner has no home folder to keep Claude Code in.")?;
    std::fs::create_dir_all(&dir).map_err(io)?;
    let staging = dir.join(format!(".download-{}", crate::local_runtime::random_hex(4)));
    std::fs::create_dir_all(&staging).map_err(io)?;
    let staged = staging.join("claude");

    let mut fetched = false;
    if let Some(packed) = packed {
        let zst = staging.join("claude.zst");
        let url = format!("{base}/{platform}/claude.zst");
        if download(&client, &url, &zst, &packed, report).await.is_ok() {
            let (zst, out, binary) = (zst.clone(), staged.clone(), binary.clone());
            fetched = tauri::async_runtime::spawn_blocking(move || unpack(&zst, &out, &binary))
                .await
                .is_ok_and(|unpacked| unpacked.is_ok());
        }
        let _ = std::fs::remove_file(&zst);
    }
    let result = async {
        if !fetched {
            download(&client, &format!("{base}/{platform}/claude"), &staged, &binary, report).await?;
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).map_err(io)?;
        let target = dir.join(version.to_string());
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&staging, &target).map_err(io)?;
        Ok(target.join("claude"))
    }
    .await;
    match &result {
        Ok(claude) => prune(&dir, claude),
        Err(_) => {
            let _ = std::fs::remove_dir_all(&staging);
        }
    }
    result
}

/// Remove every copy but `keep`, and any download a crash left behind. A
/// session still running an older one keeps it until it exits: the file goes,
/// its open copy doesn't.
fn prune(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        if !keep.starts_with(entry.path()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Stream `url` into `path`, failing unless it is exactly `want`'s size and
/// checksum.
async fn download(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    want: &Artifact,
    report: bool,
) -> Result<(), String> {
    let mut response = get(client, url).await?;
    let mut file = std::fs::File::create(path).map_err(io)?;
    let mut hash = Sha256::new();
    let mut received = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(net)? {
        received += chunk.len() as u64;
        if received > want.size {
            return Err("Claude Code's download was larger than its manifest says.".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(io)?;
        if report {
            set_setup(Some(Setup::Installing { received, total: want.size }));
        }
    }
    file.sync_all().map_err(io)?;
    verify(received, hash, want)
}

/// Decompress a verified `claude.zst` into `out`, which must then match the
/// plain binary's size and checksum too.
fn unpack(zst: &Path, out: &Path, want: &Artifact) -> Result<(), String> {
    let input = BufReader::new(std::fs::File::open(zst).map_err(io)?);
    let mut decoder = ruzstd::decoding::StreamingDecoder::new(input).map_err(|error| error.to_string())?;
    let mut file = std::fs::File::create(out).map_err(io)?;
    let mut hash = Sha256::new();
    let mut written = 0u64;
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = decoder.read(&mut buf).map_err(io)?;
        if n == 0 {
            break;
        }
        written += n as u64;
        if written > want.size {
            return Err("Claude Code unpacked larger than its manifest says.".into());
        }
        hash.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(io)?;
    }
    file.sync_all().map_err(io)?;
    verify(written, hash, want)
}

fn verify(size: u64, hash: Sha256, want: &Artifact) -> Result<(), String> {
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if size != want.size || !got.eq_ignore_ascii_case(&want.checksum) {
        return Err("Claude Code's download didn't match its checksum.".into());
    }
    Ok(())
}

async fn get(client: &reqwest::Client, url: &str) -> Result<reqwest::Response, String> {
    let response = client.get(url).send().await.map_err(net)?;
    if !response.status().is_success() {
        return Err(format!("Claude Code's download service answered {}.", response.status()));
    }
    Ok(response)
}

/// Anthropic's name for this Mac's build. An Intel build under Rosetta on Apple
/// silicon still gets the native one, as the official installer does.
fn platform() -> &'static str {
    if cfg!(target_arch = "aarch64") || under_rosetta() {
        "darwin-arm64"
    } else {
        "darwin-x64"
    }
}

fn under_rosetta() -> bool {
    std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "sysctl.proc_translated"])
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == "1")
}

fn net(error: reqwest::Error) -> String {
    format!("Couldn't download Claude Code: {error}")
}

fn io(error: std::io::Error) -> String {
    format!("Couldn't save Claude Code: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_version_from_the_cli_and_the_channel() {
        assert_eq!(Version::parse("2.1.287 (Claude Code)"), Some(Version(2, 1, 287)));
        assert_eq!(Version::parse("2.1.287\n"), Some(Version(2, 1, 287)));
        assert_eq!(Version::parse("2.2.0-beta.1"), Some(Version(2, 2, 0)));
        assert_eq!(Version::parse("1.0.30 (Claude Code)"), Some(Version(1, 0, 30)));
        for junk in ["", "<html>", "2.1", "2.1.x", "2.1.0.4", "../../etc 1.2.3"] {
            assert_eq!(Version::parse(junk), None, "{junk:?}");
        }
        assert!(Version(1, 0, 30) < MIN_VERSION && MIN_VERSION <= Version(2, 0, 0));
        assert!(Version(2, 1, 9) < Version(2, 1, 10), "compared as numbers, not text");
    }

    #[test]
    fn the_newest_copy_on_disk_is_used() {
        let dir = std::env::temp_dir().join(format!("outrunner-managed-{}", crate::local_runtime::random_hex(4)));
        for (name, has_binary) in [("2.1.9", true), ("2.1.10", true), ("2.1.11", false), (".download-ab", true)] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
            if has_binary {
                std::fs::write(dir.join(name).join("claude"), "").unwrap();
            }
        }
        assert_eq!(newest_in(&dir), Some((Version(2, 1, 10), dir.join("2.1.10/claude"))));

        prune(&dir, &dir.join("2.1.10/claude"));
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, ["2.1.10"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_download_must_match_its_manifest() {
        let want = |data: &[u8]| Artifact {
            checksum: Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect(),
            size: data.len() as u64,
        };
        let hashed = |data: &[u8]| {
            let mut hash = Sha256::new();
            hash.update(data);
            hash
        };
        assert!(verify(5, hashed(b"hello"), &want(b"hello")).is_ok());
        assert!(verify(5, hashed(b"hellO"), &want(b"hello")).is_err());
        assert!(verify(4, hashed(b"hell"), &want(b"hello")).is_err());
    }

    /// The real thing: Anthropic's stable build, downloaded, verified and run.
    /// `cargo test -- --ignored downloads_and_runs` (about 80MB).
    #[test]
    #[ignore]
    fn downloads_and_runs_the_stable_claude_code() {
        let root = std::env::temp_dir().join(format!("outrunner-root-{}", crate::local_runtime::random_hex(4)));
        std::env::set_var("OUTRUNNER_ROOT", &root);
        crate::install_crypto_provider(); // as run() does
        let claude = tauri::async_runtime::block_on(install(false)).expect("installs");
        assert!(is_managed(&claude));
        let version = crate::local_runtime::claude_version(&claude).expect("runs");
        assert!(version >= MIN_VERSION, "{version}");
        assert_eq!(installed().map(|(v, _)| v), Some(version));
        let _ = std::fs::remove_dir_all(root);
    }
}
