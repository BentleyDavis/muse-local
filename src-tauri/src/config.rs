//! App configuration: Documents/muse-local/config.json, seeded from the
//! bundled default on first run (same pattern as auto-media-player).
//!
//! The Firebase token is NOT kept here — it lives in Windows Credential
//! Manager (see secret.rs). get_config merges it into the response at
//! runtime; save_config refuses to write a real token to disk.

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
        let _: Value = serde_json::from_str(DEFAULT_CONFIG)
            .map_err(|e| format!("invalid bundled default config: {}", e))?;
        fs::write(&path, DEFAULT_CONFIG)
            .map_err(|e| format!("failed to write default config: {}", e))?;
    }
    Ok(path)
}

fn bundled_default() -> Value {
    // Validated by ensure_config before first write; a parse failure here
    // would be a programming error.
    serde_json::from_str(DEFAULT_CONFIG).expect("bundled default config is invalid")
}

/// Config with missing keys backfilled from the bundled default, so old
/// config files keep working when new settings are added.
fn merged_config() -> Result<Value, String> {
    let path = ensure_config()?;
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("failed to read {}: {}", CONFIG_FILE, e))?;
    let disk: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid {}: {}", CONFIG_FILE, e))?;

    let mut cfg = bundled_default();
    if let (Some(base), Some(over)) = (cfg.as_object_mut(), disk.as_object()) {
        for (k, v) in over {
            match (base.get_mut(k), v) {
                (Some(bv), Value::Object(ov)) => {
                    if let Some(bo) = bv.as_object_mut() {
                        for (sk, sv) in ov {
                            bo.insert(sk.clone(), sv.clone());
                        }
                        continue;
                    }
                    base.insert(k.clone(), v.clone());
                }
                _ => {
                    base.insert(k.clone(), v.clone());
                }
            }
        }
    }
    Ok(cfg)
}

fn is_placeholder(token: &str) -> bool {
    token.is_empty() || token.contains("REPLACE")
}

#[tauri::command]
pub fn get_config() -> Result<Value, String> {
    let mut cfg = merged_config()?;

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

fn validate(cfg: &Value) -> Result<(), String> {
    let db = cfg
        .pointer("/firebase/databaseURL")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !db.starts_with("https://") {
        return Err("firebase.databaseURL must be an https URL".to_string());
    }
    let target = cfg.pointer("/targetUrl").and_then(|v| v.as_str()).unwrap_or("");
    if !target.starts_with("https://") {
        return Err("targetUrl must be an https URL".to_string());
    }
    let wpm = cfg
        .pointer("/humanInput/typingWpm")
        .and_then(|v| v.as_f64())
        .unwrap_or(55.0);
    if !(15.0..=160.0).contains(&wpm) {
        return Err("humanInput.typingWpm must be 15–160".to_string());
    }
    let speed = cfg
        .pointer("/humanInput/mouseSpeed")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    if !(0.25..=4.0).contains(&speed) {
        return Err("humanInput.mouseSpeed must be 0.25–4.0".to_string());
    }
    Ok(())
}

/// Save settings from the settings screen. The token field is always
/// scrubbed — tokens are managed separately via set_firebase_token.
#[tauri::command]
pub fn save_config(mut cfg: Value) -> Result<(), String> {
    validate(&cfg)?;
    if let Some(fb) = cfg.get_mut("firebase") {
        if let Some(obj) = fb.as_object_mut() {
            obj.insert("token".to_string(), Value::String(String::new()));
        }
    }
    // Keep a stable key order and don't drop unknown keys the user added.
    let mut full = merged_config()?;
    if let (Some(base), Some(over)) = (full.as_object_mut(), cfg.as_object()) {
        for (k, v) in over {
            if k == "firebase" {
                continue;
            }
            base.insert(k.clone(), v.clone());
        }
        if let (Some(bfb), Some(ofb)) = (base.get_mut("firebase"), over.get("firebase")) {
            if let (Some(bfo), Some(ofo)) = (bfb.as_object_mut(), ofb.as_object()) {
                for (sk, sv) in ofo {
                    if sk != "token" {
                        bfo.insert(sk.clone(), sv.clone());
                    }
                }
            }
        }
        if let (Some(bhi), Some(ohi)) = (base.get_mut("humanInput"), over.get("humanInput")) {
            if let (Some(bhio), Some(ohio)) = (bhi.as_object_mut(), ohi.as_object()) {
                for (sk, sv) in ohio {
                    bhio.insert(sk.clone(), sv.clone());
                }
            }
        }
    }
    let path = ensure_config()?;
    let out = serde_json::to_string_pretty(&full).map_err(|e| e.to_string())?;
    fs::write(&path, out).map_err(|e| format!("failed to write {}: {}", CONFIG_FILE, e))?;
    Ok(())
}

/// Store the Firebase token in Windows Credential Manager and scrub any
/// real token out of the on-disk config so it never sits in plaintext.
#[tauri::command]
pub fn set_firebase_token(token: String) -> Result<(), String> {
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("token must be letters and numbers only".to_string());
    }
    super::secret::store_firebase_token(token)?;

    // Safety scrub: a real token should never linger in config.json.
    let path = ensure_config()?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut cfg: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if let Some(fb) = cfg.get_mut("firebase") {
        let cur = fb.get("token").and_then(|v| v.as_str()).unwrap_or("");
        if !is_placeholder(cur) {
            fb["token"] = Value::String(String::new());
            let out = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
            fs::write(&path, out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
