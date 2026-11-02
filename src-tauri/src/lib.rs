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

/// Default sidebar width in physical pixels (the saved value in
/// config.json wins once the user drags the divider).
const DEFAULT_SIDEBAR_W: u32 = 400;
const MIN_SIDEBAR_W: u32 = 200;
const MAX_SIDEBAR_W: u32 = 800;

struct AppState {
    sidebar_width: Mutex<u32>,
}

/// Re-split the window: sidebar `sidebar_w` px on the left, site takes the
/// rest. Used at startup, on window resize, and while dragging the divider.
fn apply_layout(app: &tauri::AppHandle, sidebar_w: u32) -> Result<(), String> {
    let window = app.get_window("main").ok_or("main window not found")?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let w = sidebar_w
        .clamp(MIN_SIDEBAR_W, MAX_SIDEBAR_W)
        .min(size.width.saturating_sub(200));
    let sidebar = app.get_webview("sidebar").ok_or("sidebar not found")?;
    let site = app.get_webview("site").ok_or("site not found")?;
    sidebar
        .set_size(tauri::PhysicalSize::new(w, size.height))
        .map_err(|e| e.to_string())?;
    site.set_position(tauri::PhysicalPosition::new(w, 0))
        .map_err(|e| e.to_string())?;
    site.set_size(tauri::PhysicalSize::new(
        size.width.saturating_sub(w),
        size.height,
    ))
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Drag handler for the sidebar divider. Returns the clamped width so the
/// frontend can snap its handle; the frontend persists it to config.json
/// on drag end.
#[tauri::command]
fn set_sidebar_width(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    width: u32,
) -> Result<u32, String> {
    let w = width.clamp(MIN_SIDEBAR_W, MAX_SIDEBAR_W);
    *state
        .sidebar_width
        .lock()
        .map_err(|e| e.to_string())? = w;
    apply_layout(&app, w)?;
    Ok(w)
}

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
    // Seed Documents/muse-local/config.json from the bundled default on
    // first run (same pattern as auto-media-player), then read the saved
    // sidebar width before building so the initial layout matches it.
    if let Err(e) = config::ensure_config() {
        eprintln!("config setup failed: {}", e);
    }
    let initial_w = config::get_config()
        .ok()
        .and_then(|c| {
            c.pointer("/sidebarWidth")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
        })
        .unwrap_or(DEFAULT_SIDEBAR_W)
        .clamp(MIN_SIDEBAR_W, MAX_SIDEBAR_W);

    tauri::Builder::default()
        .manage(AppState {
            sidebar_width: Mutex::new(initial_w),
        })
        .invoke_handler(tauri::generate_handler![
            set_sidebar_width,
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
        .setup(move |app| {
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
            window.add_child(
                sidebar,
                tauri::LogicalPosition::new(0, 0),
                tauri::PhysicalSize::new(initial_w, size.height),
            )?;

            // Site: the target website with the control bridge injected.
            // The init script runs before page scripts on every navigation,
            // in every frame — no extension needed.
            //
            // The webview is created on a local page and then navigated
            // explicitly: a single navigation through the documented
            // navigate() API (which re-runs the init scripts), instead of
            // relying on the builder's initial URL.
            let target_url = config::get_config()
                .ok()
                .and_then(|c| {
                    c.pointer("/targetUrl")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                })
                .unwrap_or_default();
            eprintln!("muse-local: target_url from config = {:?}", target_url);
            let target: Option<tauri::webview::Url> = target_url.parse().ok();
            let blank: tauri::webview::Url = "about:blank".parse().unwrap();
            let site = tauri::webview::WebviewBuilder::new(
                "site",
                tauri::WebviewUrl::External(blank),
            )
            .initialization_script(CONTROL_JS);
            let site_wv = window.add_child(
                site,
                tauri::PhysicalPosition::new(initial_w, 0),
                tauri::PhysicalSize::new(size.width.saturating_sub(initial_w), size.height),
            )?;
            match target {
                Some(u) => {
                    if let Err(e) = site_wv.navigate(u) {
                        eprintln!("muse-local: site navigate failed: {}", e);
                    }
                }
                None => {
                    eprintln!("muse-local: no valid targetUrl — site webview left on about:blank");
                }
            };

            // Child webviews keep a fixed size by default — re-split the
            // window on resize using the current (possibly dragged) width.
            let app_h = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(_) = event {
                    let w = app_h
                        .state::<AppState>()
                        .sidebar_width
                        .lock()
                        .map(|g| *g)
                        .unwrap_or(DEFAULT_SIDEBAR_W);
                    let _ = apply_layout(&app_h, w);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
