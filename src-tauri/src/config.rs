//! App configuration: Documents/muse-local/config.json, seeded from the
//! bundled default on first run (same pattern as auto-media-player).

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

pub const APP_DIR_NAME: &str = "muse-local";
const CONFIG_FILE: &str = "config.json";
const DEFAULT_CONFIG: &str = include_str!("../defaults/config.json");

pub fn app_dir() -> PathBuf {
    dirs::document_dir()
        .map(|d| d.join(APP_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(APP_DIR_NAME))
}

/// Create the app dir and seed config.json from the bundled default if it
/// does not exist yet. Returns the config file path.
pub fn ensure_config() -> Result<PathBuf, String> {
    let dir = app_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create app dir: {}", e))?;

    let path = dir.join(CONFIG_FILE);
    if !path.exists() {
        // Validate the bundled default before writing it.
        let _: Value =
            serde_json::from_str(DEFAULT_CONFIG).map_err(|e| format!("invalid bundled default config: {}", e))?;
        fs::write(&path, DEFAULT_CONFIG)
            .map_err(|e| format!("failed to write default config: {}", e))?;
    }
    Ok(path)
}

#[tauri::command]
pub fn get_config() -> Result<Value, String> {
    let path = ensure_config()?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("failed to read {}: {}", CONFIG_FILE, e))?;
    let mut cfg: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid {}: {}", CONFIG_FILE, e))?;

    // The token lives in Windows Credential Manager, not on disk. Merge it
    // into the response so the injected page script works unchanged.
    let disk_token = cfg
        .pointer("/firebase/token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let token = match super::secret::load_token()? {
        Some(t) => t,
        None if is_placeholder(&disk_token) => String::new(),
        None => disk_token,
    };
    if let Some(fb) = cfg.get_mut("firebase") {
        fb["token"] = Value::String(token);
    }
    Ok(cfg)
}

fn is_placeholder(token: &str) -> bool {
    token.is_empty() || token.contains("REPLACE")
}

/// Store the Firebase token in Windows Credential Manager and scrub any
/// real token out of the on-disk config so it never sits in plaintext.
#[tauri::command]
pub fn set_firebase_token(token: String) -> Result<(), String> {
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("token must be letters and numbers only".to_string());
    }
    super::secret::store_firebase_token(token)?;

    // Scrub the disk copy: leave the placeholder so a stray real token
    // can never linger in config.json.
    let path = ensure_config()?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut cfg: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if let Some(fb) = cfg.get_mut("firebase") {
        let cur = fb.get("token").and_then(|v| v.as_str()).unwrap_or("");
        if !is_placeholder(cur) {
            fb["token"] = Value::String(String::new());
            let out =
                serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
            fs::write(&path, out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
