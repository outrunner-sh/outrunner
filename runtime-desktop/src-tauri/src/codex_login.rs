//! Cloud ChatGPT connection. Only progress and the approval URL/code cross IPC.
use crate::local_runtime::{agent_binary, user_command};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

/// Read the local CLI's actual catalog, using its own login without exporting it.
#[tauri::command]
pub async fn local_codex_models() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let binary = crate::managed_codex::find().ok_or("Codex isn't installed.")?;
        let mut child = user_command(binary).arg("app-server").stdin(Stdio::piped())
            .stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "Couldn't read Codex models.")?;
        let input = concat!(
            "{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"outrunner\",\"version\":\"0.1.0\"}}}\n",
            "{\"method\":\"initialized\"}\n",
            "{\"id\":2,\"method\":\"model/list\",\"params\":{\"includeHidden\":false}}\n"
        );
        if child.stdin.as_mut().unwrap().write_all(input.as_bytes()).is_err() {
            let _ = child.kill(); let _ = child.wait(); return Err("Couldn't read Codex models.".into());
        }
        let (send, receive) = std::sync::mpsc::channel();
        let output = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
                if value["id"] == 2 { let _ = send.send(value); break; }
            }
        });
        let result = receive.recv_timeout(Duration::from_secs(20));
        let _ = child.kill(); let _ = child.wait();
        result.ok().and_then(|v| catalog(&v)).ok_or("Couldn't read Codex's models. Check its login and try again.".into())
    }).await.map_err(|_| "Couldn't read Codex models.".to_string())?
}

fn catalog(value: &Value) -> Option<Value> {
    let models = value["result"]["data"].as_array()?;
    let parsed: Vec<Value> = models.iter().filter(|m| m["hidden"] != true).filter_map(|model| {
        let id = model["model"].as_str().or_else(|| model["id"].as_str())?;
        let efforts: Vec<&str> = model["supportedReasoningEfforts"].as_array().into_iter().flatten()
            .filter_map(|e| e["reasoningEffort"].as_str()).filter(|e| matches!(*e, "low" | "medium" | "high" | "xhigh" | "max")).collect();
        Some(json!({ "id": id, "label": model["displayName"].as_str().unwrap_or(id), "provider": "codex", "efforts": efforts,
            "defaultEffort": model["defaultReasoningEffort"], "isDefault": model["isDefault"] == true, "supportsImages": model["inputModalities"].as_array().is_some_and(|a| a.iter().any(|v| v == "image")) }))
    }).collect();
    Some(json!(parsed))
}

struct Attempt {
    id: String,
    canceled: Arc<AtomicBool>,
    progress: Arc<Mutex<Value>>,
}
impl Drop for Attempt {
    fn drop(&mut self) {
        self.canceled.store(true, Ordering::SeqCst);
    }
}
#[derive(Default)]
pub struct CodexLoginState {
    attempt: Mutex<Option<Attempt>>,
}

#[tauri::command]
pub async fn connect_codex_start(
    state: tauri::State<'_, CodexLoginState>,
    attempt: String,
    bearer: String,
) -> Result<(), String> {
    if !regex::Regex::new(r"^[0-9a-fA-F-]{36}$")
        .unwrap()
        .is_match(&attempt)
        || bearer.len() > 8192
    {
        return Err("Invalid connection attempt.".into());
    }
    let endpoint = format!("{}/api/desktop/codex", crate::site());
    let progress = Arc::new(Mutex::new(json!({ "state": "preparing" })));
    let canceled = Arc::new(AtomicBool::new(false));
    *state.attempt.lock().unwrap() = Some(Attempt {
        id: attempt,
        canceled: Arc::clone(&canceled),
        progress: Arc::clone(&progress),
    });
    tauri::async_runtime::spawn(async move {
        let result = async {
            let binary = crate::managed_codex::ensure().await?;
            if canceled.load(Ordering::SeqCst) {
                return Ok(());
            }
            let (progress, canceled) = (Arc::clone(&progress), Arc::clone(&canceled));
            tauri::async_runtime::spawn_blocking(move || {
                run(
                    endpoint,
                    bearer,
                    binary.to_string_lossy().into_owned(),
                    progress,
                    canceled,
                )
            })
            .await
            .map_err(|_| "Codex connection stopped. Try again.".to_string())?
        }
        .await;
        if !canceled.load(Ordering::SeqCst) {
            *progress.lock().unwrap() = match result {
                Ok(()) => json!({ "state": "done" }),
                Err(message) => json!({ "state": "error", "message": message }),
            };
        }
    });
    Ok(())
}

fn run(
    endpoint: String,
    bearer: String,
    binary: String,
    progress: Arc<Mutex<Value>>,
    canceled: Arc<AtomicBool>,
) -> Result<(), String> {
    let mut child = user_command(&agent_binary()?)
        .arg("desktop-codex-auth")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Couldn't start the Codex connection. Update Outrunner and try again.")?;
    let input =
        json!({ "endpoint": endpoint, "bearer": bearer, "binary": binary }).to_string() + "\n";
    if child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(input.as_bytes())
        .is_err()
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Couldn't start the Codex connection.".into());
    }
    let pipe = child.stdout.take().unwrap();
    let shared = Arc::clone(&progress);
    let stopped = Arc::clone(&canceled);
    let reader = std::thread::spawn(move || {
        let mut url: Option<String> = None;
        let mut code: Option<String> = None;
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            let line = line.trim();
            if approval_url(line) {
                url = Some(line.into());
            }
            if regex::Regex::new(r"^[A-Z0-9]{4}-[A-Z0-9]{4,5}$")
                .unwrap()
                .is_match(line)
            {
                code = Some(line.into());
            }
            if let (Some(url), Some(code)) = (&url, &code) {
                let mut value = shared.lock().unwrap();
                if value["state"] != "waiting" {
                    let _ = open::that(url);
                }
                *value = json!({ "state": "waiting", "url": url, "code": code });
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(610);
    let mut closing = None;
    let result = loop {
        if canceled.load(Ordering::SeqCst) || Instant::now() >= deadline {
            // EOF lets the Go helper cancel its entire CLI process group and
            // remove temporary credentials before exiting.
            child.stdin.take();
            let since = closing.get_or_insert_with(Instant::now);
            if since.elapsed() > Duration::from_secs(25) {
                let _ = child.kill();
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err("Codex sign-in did not finish. Enable device-code login in ChatGPT security settings, then try again.".to_string())
                }
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("Codex connection stopped. Try again.".to_string());
            }
            _ => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    let _ = reader.join();
    result
}

fn approval_url(value: &str) -> bool {
    regex::Regex::new(
        r"^https://auth\.openai\.com/(?:codex/)?device(?:auth)?(?:/[A-Za-z0-9/_-]*)?$",
    )
    .unwrap()
    .is_match(value)
}

#[tauri::command]
pub fn connect_codex_poll(state: tauri::State<'_, CodexLoginState>, attempt: String) -> Value {
    let current = state.attempt.lock().unwrap();
    current
        .as_ref()
        .filter(|a| a.id == attempt)
        .map(|a| a.progress.lock().unwrap().clone())
        .unwrap_or(json!({ "state": "ended" }))
}

#[tauri::command]
pub fn connect_codex_cancel(state: tauri::State<'_, CodexLoginState>, attempt: String) {
    let mut current = state.attempt.lock().unwrap();
    if current.as_ref().is_some_and(|a| a.id == attempt) {
        current.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_stays_on_official_device_page() {
        assert!(approval_url("https://auth.openai.com/codex/device"));
        assert!(approval_url("https://auth.openai.com/deviceauth"));
        assert!(!approval_url(
            "https://auth.openai.com.evil.test/codex/device"
        ));
        assert!(!approval_url(
            "https://auth.openai.com/codex/device?token=secret"
        ));
    }
    #[test]
    fn local_catalog_uses_native_model_ids_and_capabilities() {
        let models = catalog(&json!({"result":{"data":[{"id":"ui-id","model":"account-native", "displayName":"Native coding", "hidden":false,"inputModalities":["text","image"],"defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"high"}]},{"id":"hidden", "hidden":true}]}})).unwrap();
        assert_eq!(models.as_array().unwrap().len(), 1);
        assert_eq!(models[0]["id"], "account-native");
        assert_eq!(models[0]["supportsImages"], true);
    }
}
