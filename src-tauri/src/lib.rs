mod capture;
mod config;
mod input;
mod secret;

use std::sync::Mutex;
use tauri::Manager;

// Built by `npm run build:control` (vite) into src-tauri/injected/control.js
// and checked in, so the app always has an initialization script even when
// the Tauri CLI is run directly without the npm wrapper scripts.
const CONTROL_JS: &str = include_str!("../injected/control.js");

/// The loader page's own URL (dev server or tauri://), reported by the
/// loader via set_home_url so open_settings can navigate back to it.
struct AppState {
    home_url: Mutex<Option<String>>,
}

#[tauri::command]
fn set_home_url(state: tauri::State<'_, AppState>, url: String) {
    *state.home_url.lock().unwrap() = Some(url);
}

/// Navigate the main window back to the loader/settings page.
/// Called from the injected badge's gear button on any target page.
#[tauri::command]
fn open_settings(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let url = state
        .home_url
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "home url not set yet".to_string())?;
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    win.eval(&format!("window.location.href={:?};", url))
        .map_err(|e: tauri::Error| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            home_url: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            set_home_url,
            open_settings,
            config::get_config,
            config::save_config,
            input::mouse_path,
            input::click_at,
            input::type_text,
            input::start_recording,
            input::stop_recording,
            input::list_recordings,
            input::load_recording,
            capture::screenshot,
            secret::store_firebase_token,
            secret::delete_firebase_token,
            config::set_firebase_token,
        ])
        .setup(|app| {
            // Seed Documents/muse-local/config.json from the bundled default
            // on first run (same pattern as auto-media-player).
            if let Err(e) = config::ensure_config() {
                eprintln!("config setup failed: {}", e);
            }

            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Muse Local")
            .inner_size(1280.0, 800.0)
            // Runs before page scripts on every navigation, in every frame.
            // This is the automation bridge — no extension needed.
            .initialization_script(CONTROL_JS)
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
