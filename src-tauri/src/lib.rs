mod capture;
mod config;
mod input;
mod secret;

use tauri::Manager;

// Built by `npm run build:control` (vite) into src-tauri/injected/control.js
// and checked in, so the app always has an initialization script even when
// the Tauri CLI is run directly without the npm wrapper scripts.
const CONTROL_JS: &str = include_str!("../injected/control.js");

/// Width of the app sidebar in physical pixels. Everything left of it is
/// the app (control panel); everything right of it is the website under
/// control.
const SIDEBAR_W: u32 = 320;

/// Navigate the site webview to a new URL (used when the target URL changes
/// in the sidebar). The initialization script re-runs on navigation, so the
/// control bridge keeps working.
#[tauri::command]
fn navigate_site(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let wv = app.get_webview("site").ok_or("site webview not found")?;
    let parsed = url.parse().map_err(|e| format!("bad URL: {e}"))?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

/// Current URL of the site webview, shown in the sidebar.
#[tauri::command]
fn site_url(app: tauri::AppHandle) -> Result<String, String> {
    let wv = app.get_webview("site").ok_or("site webview not found")?;
    wv.url().map(|u| u.to_string()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            navigate_site,
            site_url,
            config::get_config,
            config::save_config,
            config::set_firebase_token,
            secret::store_firebase_token,
            secret::delete_firebase_token,
            input::mouse_path,
            input::click_at,
            input::type_text,
            input::start_recording,
            input::stop_recording,
            input::list_recordings,
            input::load_recording,
            input::delete_recording,
            capture::screenshot,
        ])
        .setup(|app| {
            // Seed Documents/muse-local/config.json from the bundled default
            // on first run (same pattern as auto-media-player).
            if let Err(e) = config::ensure_config() {
                eprintln!("config setup failed: {}", e);
            }
            let target_url = config::get_config()
                .ok()
                .and_then(|c| {
                    c.pointer("/targetUrl")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                })
                .unwrap_or_default();

            let window = tauri::window::WindowBuilder::new(app, "main")
                .title("Muse Local")
                .inner_size(1440.0, 900.0)
                .build()?;
            let size = window.inner_size()?;

            // Sidebar: the app's own control panel — settings, recordings,
            // connection test. This pane is "the app".
            let sidebar = tauri::webview::WebviewBuilder::new(
                "sidebar",
                tauri::WebviewUrl::App("index.html".into()),
            );
            let sidebar_wv = window.add_child(
                sidebar,
                tauri::LogicalPosition::new(0, 0),
                tauri::PhysicalSize::new(SIDEBAR_W, size.height),
            )?;

            // Site: the target website with the control bridge injected.
            // The init script runs before page scripts on every navigation,
            // in every frame — no extension needed.
            let start = match target_url.parse() {
                Ok(u) => tauri::WebviewUrl::External(u),
                Err(_) => tauri::WebviewUrl::External("about:blank".parse().unwrap()),
            };
            let site = tauri::webview::WebviewBuilder::new("site", start)
                .initialization_script(CONTROL_JS);
            let site_wv = window.add_child(
                site,
                tauri::PhysicalPosition::new(SIDEBAR_W, 0),
                tauri::PhysicalSize::new(size.width.saturating_sub(SIDEBAR_W), size.height),
            )?;

            // Child webviews keep a fixed size by default — re-split the
            // window on resize so the sidebar stays 320px and the site
            // takes the rest.
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(s) = event {
                    let _ = sidebar_wv.set_size(tauri::PhysicalSize::new(SIDEBAR_W, s.height));
                    let _ = site_wv.set_position(tauri::PhysicalPosition::new(SIDEBAR_W, 0));
                    let _ = site_wv.set_size(tauri::PhysicalSize::new(
                        s.width.saturating_sub(SIDEBAR_W),
                        s.height,
                    ));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
