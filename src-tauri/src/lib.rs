mod capture;
mod config;
mod input;
mod secret;

// Built by `npm run build:control` (vite) into src-tauri/injected/control.js
// and checked in, so the app always has an initialization script even when
// the Tauri CLI is run directly without the npm wrapper scripts.
const CONTROL_JS: &str = include_str!("../injected/control.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            config::get_config,
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
