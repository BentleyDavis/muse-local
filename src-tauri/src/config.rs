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
    serde_json::from_str(&raw).map_err(|e| format!("invalid {}: {}", CONFIG_FILE, e))
}
