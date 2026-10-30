//! Private, verified native Codex installation. No npm, Node or shell changes.
use crate::{
    local_runtime::{random_hex, root_dir, session_path, user_command},
    managed_claude::Version,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha512};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

// Keep in step with lib/runtime/box-image.ts. Runtime protocol support is pinned.
pub(crate) const VERSION: &str = "0.162.1";
static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn installed() -> Option<PathBuf> {
    Some(
        root_dir()
            .ok()?
            .join("codex")
            .join(VERSION)
            .join("bin")
            .join("codex"),
    )
}

fn version(path: &Path) -> Option<Version> {
    let mut child = user_command(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let until = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                return None;
            }
            let mut out = String::new();
            child.stdout.take()?.read_to_string(&mut out).ok()?;
            return out
                .strip_prefix("codex-cli ")
                .and_then(|v| Version::parse(v.trim()));
        }
        if std::time::Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

pub(crate) fn find() -> Option<PathBuf> {
    let link_dir = root_dir().ok()?.join("bin");
    let minimum = Version::parse(VERSION)?;
    let found = session_path()
        .split(':')
        .map(PathBuf::from)
        .filter(|p| p != &link_dir)
        .map(|p| p.join("codex"))
        .filter(|p| p.is_file())
        .find(|p| version(p).is_some_and(|v| v >= minimum))
        .or_else(|| {
            installed().filter(|p| p.is_file() && version(p).is_some_and(|v| v >= minimum))
        });
    if let Some(binary) = &found {
        let _ = std::fs::create_dir_all(&link_dir);
        let link = link_dir.join("codex");
        if !std::fs::read_link(&link).is_ok_and(|p| p == *binary) {
            let staged = link_dir.join(format!(".codex-{}", random_hex(4)));
            if std::os::unix::fs::symlink(binary, &staged).is_ok() {
                let _ = std::fs::rename(&staged, &link);
                let _ = std::fs::remove_file(&staged);
            }
        }
    } else {
        let _ = std::fs::remove_file(link_dir.join("codex"));
    }
    found
}

pub(crate) async fn ensure() -> Result<PathBuf, String> {
    let _one = INSTALL.lock().await;
    if let Some(binary) = tauri::async_runtime::spawn_blocking(find)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(binary);
    }
    install().await
}

async fn install() -> Result<PathBuf, String> {
    let (platform, triple) = platform()?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "Couldn't reach Codex's download service.")?;
    let package_version = format!("{VERSION}-{platform}");
    let meta: serde_json::Value = client
        .get(format!(
            "https://registry.npmjs.org/@openai/codex/{package_version}"
        ))
        .send()
        .await
        .map_err(net)?
        .error_for_status()
        .map_err(net)?
        .json()
        .await
        .map_err(net)?;
    let integrity = meta["dist"]["integrity"]
        .as_str()
        .and_then(|s| s.strip_prefix("sha512-"))
        .and_then(|s| STANDARD.decode(s).ok())
        .filter(|s| s.len() == 64)
        .ok_or("Codex's release integrity is missing.")?;
    let url = format!("https://registry.npmjs.org/@openai/codex/-/codex-{package_version}.tgz");
    if meta["dist"]["tarball"].as_str() != Some(url.as_str()) {
        return Err("Unexpected Codex release location.".into());
    }
    let dir = root_dir()?.join("codex");
    std::fs::create_dir_all(&dir).map_err(io)?;
    let staging = dir.join(format!(".download-{}", random_hex(8)));
    std::fs::create_dir(&staging).map_err(io)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700)).map_err(io)?;
    let result = async {
        let archive = staging.join("codex.tgz");
        let mut file = std::fs::File::create(&archive).map_err(io)?;
        let mut response = client
            .get(&url)
            .send()
            .await
            .map_err(net)?
            .error_for_status()
            .map_err(net)?;
        let mut hash = Sha512::new();
        let mut received = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(net)? {
            received += chunk.len() as u64;
            if received > 200_000_000 {
                return Err("Codex download exceeded its size limit.".into());
            }
            hash.update(&chunk);
            file.write_all(&chunk).map_err(io)?;
        }
        drop(file);
        if hash.finalize().as_slice() != integrity.as_slice() {
            return Err("Codex download didn't match its checksum.".into());
        }
        let member = format!("package/vendor/{triple}");
        let (archive_copy, staging_copy, member_copy) =
            (archive.clone(), staging.clone(), member.clone());
        let extracted = tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new("/usr/bin/tar")
                .arg("-xzf")
                .arg(archive_copy)
                .arg("-C")
                .arg(staging_copy)
                .arg(member_copy)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(io)?;
        if !extracted.success() {
            return Err("Couldn't unpack Codex. Try again.".into());
        }
        let binary = staging.join(&member).join("bin").join("codex");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).map_err(io)?;
        let check = binary.clone();
        if !tauri::async_runtime::spawn_blocking(move || {
            version(&check).is_some_and(|v| Some(v) == Version::parse(VERSION))
        })
        .await
        .unwrap_or(false)
        {
            return Err("The downloaded Codex could not run on this Mac.".into());
        }
        let destination = installed().ok_or("Outrunner has no home folder.")?;
        let target = dir.join(VERSION);
        if target.exists() {
            std::fs::remove_dir_all(&target).map_err(io)?;
        }
        std::fs::rename(staging.join(&member), &target).map_err(io)?;
        let _ = tauri::async_runtime::spawn_blocking(find).await;
        Ok(destination)
    }
    .await;
    let _ = std::fs::remove_dir_all(&staging);
    result
}

fn platform() -> Result<(&'static str, &'static str), String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok(("darwin-arm64", "aarch64-apple-darwin")),
        ("macos", "x86_64") => Ok(("darwin-x64", "x86_64-apple-darwin")),
        ("linux", "aarch64") => Ok(("linux-arm64", "aarch64-unknown-linux-musl")),
        ("linux", "x86_64") => Ok(("linux-x64", "x86_64-unknown-linux-musl")),
        _ => Err("Codex isn't available for this platform.".into()),
    }
}
fn net(_: reqwest::Error) -> String {
    "Couldn't download Codex. Check your connection and try again.".into()
}
fn io(error: std::io::Error) -> String {
    format!("Couldn't prepare Codex: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pin_matches_runtime() {
        assert!(include_str!("../../../lib/runtime/box-image.ts")
            .contains(&format!("codex: \"{VERSION}\"")));
    }
    #[test]
    #[ignore = "downloads the official native binary"]
    fn downloads_and_runs() {
        crate::install_crypto_provider();
        let binary = tauri::async_runtime::block_on(install()).unwrap();
        assert!(version(&binary).unwrap() >= Version::parse(VERSION).unwrap());
    }
}
