mod capture;
mod config;
mod input;
mod input_lock;
mod secret;
mod scripts;
mod logging;

use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::Manager;
use tokio::sync::oneshot;
use uuid::Uuid;

/// Default sidebar width in physical pixels (the saved value in
/// config.json wins once the user drags the divider).
const DEFAULT_SIDEBAR_W: u32 = 400;
const MIN_SIDEBAR_W: u32 = 200;
const MAX_SIDEBAR_W: u32 = 800;
const MAX_PAGE_SCRIPT_BYTES: usize = 1_000_000;
const MAX_PAGE_ARGS_BYTES: usize = 1_000_000;
const MAX_PAGE_RESULT_BYTES: usize = 8_000_000;
const PAGE_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

type PageResponse = Result<serde_json::Value, String>;

struct PendingNavigation {
    id: String,
    expected_url: String,
    started: bool,
    sender: oneshot::Sender<String>,
}

pub(crate) async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("blocking task failed: {e}"))?
}

struct AppState {
    sidebar_width: Mutex<u32>,
    /// Webview handles captured at setup. Used directly by commands
    /// instead of label lookup, so a registry quirk can never lose them.
    sidebar: Mutex<Option<tauri::Webview>>,
    site: Mutex<Option<tauri::Webview>>,
    site_loaded: Mutex<bool>,
    pending_page_results: Mutex<HashMap<String, oneshot::Sender<PageResponse>>>,
    pending_navigation: Mutex<Option<PendingNavigation>>,
}

fn lock_webview(
    slot: &Mutex<Option<tauri::Webview>>,
    what: &str,
) -> Result<tauri::Webview, String> {
    slot.lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| format!("{} webview not found", what))
}

/// Re-split the window: sidebar `sidebar_w` px on the left, site takes the
/// rest. Used at startup, on window resize, and while dragging the divider.
fn clamped_sidebar_width(width: u32, window_width: u32) -> u32 {
    width.clamp(MIN_SIDEBAR_W, MAX_SIDEBAR_W)
        .min(window_width.saturating_sub(200))
}

fn apply_layout(state: tauri::State<'_, AppState>, sidebar_w: u32) -> Result<u32, String> {
    let sidebar = lock_webview(&state.sidebar, "sidebar")?;
    let site = lock_webview(&state.site, "site")?;
    let window = site.window();
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let w = clamped_sidebar_width(sidebar_w, size.width);
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
    Ok(w)
}

/// Drag handler for the sidebar divider. Returns the clamped width so the
/// frontend can snap its handle; the frontend persists it to config.json
/// on drag end.
#[tauri::command]
fn set_sidebar_width(state: tauri::State<'_, AppState>, width: u32) -> Result<u32, String> {
    let w = width.clamp(MIN_SIDEBAR_W, MAX_SIDEBAR_W);
    *state.sidebar_width.lock().map_err(|e| e.to_string())? = w;
    apply_layout(state, w)
}

fn clear_navigation(state: &AppState, id: &str) -> Result<(), String> {
    let mut pending = state.pending_navigation.lock().map_err(|e| e.to_string())?;
    if pending.as_ref().map(|request| request.id.as_str()) == Some(id) {
        *pending = None;
    }
    Ok(())
}

/// Navigate to any HTTP(S) page and resolve with its final URL after the
/// webview reports a finished page load.
#[tauri::command]
async fn site_navigate(state: tauri::State<'_, AppState>, url: String) -> Result<String, String> {
    let parsed: tauri::webview::Url = url.parse().map_err(|e| format!("bad URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("site URL must use http or https".to_string());
    }
    let expected_url = parsed.as_str().to_string();
    let webview = lock_webview(&state.site, "site")?;
    let id = Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = state.pending_navigation.lock().map_err(|e| e.to_string())?;
        if pending.is_some() {
            return Err("a site navigation is already in progress".to_string());
        }
        *pending = Some(PendingNavigation {
            id: id.clone(),
            expected_url,
            started: false,
            sender,
        });
    }

    if let Err(error) = webview.navigate(parsed) {
        clear_navigation(&state, &id)?;
        return Err(error.to_string());
    }

    let result = match tokio::time::timeout(PAGE_REQUEST_TIMEOUT, receiver).await {
        Ok(Ok(url)) => Ok(url),
        Ok(Err(_)) => Err("site navigation response channel closed".to_string()),
        Err(_) => Err("site navigation timed out".to_string()),
    };
    clear_navigation(&state, &id)?;
    result
}

fn page_request_script(id: &str, script: &str, args: &serde_json::Value) -> Result<String, String> {
    let id = serde_json::to_string(id).map_err(|e| e.to_string())?;
    let args = serde_json::to_string(args).map_err(|e| e.to_string())?;
    Ok(format!(
        r#"void (async () => {{
  const __museId = {id};
  try {{
    const args = {args};
    const value = await (async (args) => {{
{script}
    }})(args);
    const payload = JSON.stringify(value === undefined ? null : value);
    if (typeof payload !== "string") throw new Error("page result is not JSON serializable");
    if (payload.length > {max_result}) throw new Error("page result too large");
    await window.__TAURI__.core.invoke("page_result", {{ id: __museId, ok: true, payload }});
  }} catch (error) {{
    const payload = String(error).slice(0, 4096);
    await window.__TAURI__.core.invoke("page_result", {{ id: __museId, ok: false, payload }});
  }}
}})();"#,
        max_result = MAX_PAGE_RESULT_BYTES
    ))
}

async fn run_page_script(
    state: &AppState,
    script: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !*state.site_loaded.lock().map_err(|e| e.to_string())? {
        return Err("site page is not loaded".to_string());
    }
    if script.len() > MAX_PAGE_SCRIPT_BYTES {
        return Err("page script exceeds the 1 MB limit".to_string());
    }
    if serde_json::to_vec(&args).map_err(|e| e.to_string())?.len() > MAX_PAGE_ARGS_BYTES {
        return Err("page script arguments exceed the 1 MB limit".to_string());
    }

    let webview = lock_webview(&state.site, "site")?;
    let id = Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    state
        .pending_page_results
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), sender);

    let source = match page_request_script(&id, &script, &args) {
        Ok(source) => source,
        Err(error) => {
            state
                .pending_page_results
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&id);
            return Err(error);
        }
    };
    if let Err(error) = webview.eval(&source) {
        state
            .pending_page_results
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&id);
        return Err(error.to_string());
    }

    let response = match tokio::time::timeout(PAGE_REQUEST_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("page action response channel closed".to_string()),
        Err(_) => Err("page action timed out".to_string()),
    };
    state
        .pending_page_results
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    response
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SiteInfo {
    url: String,
    title: String,
}

#[tauri::command]
async fn site_run(
    state: tauri::State<'_, AppState>,
    script: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    run_page_script(&state, script, args).await
}

#[tauri::command]
async fn site_info(state: tauri::State<'_, AppState>) -> Result<SiteInfo, String> {
    let webview = lock_webview(&state.site, "site")?;
    let url = webview.url().map_err(|e| e.to_string())?.to_string();
    if !*state.site_loaded.lock().map_err(|e| e.to_string())? {
        return Ok(SiteInfo {
            url,
            title: String::new(),
        });
    }
    let title = run_page_script(
        &state,
        "return document.title;".to_string(),
        serde_json::Value::Null,
    )
    .await?
    .as_str()
    .ok_or_else(|| "page returned a non-string title".to_string())?
    .to_string();
    Ok(SiteInfo { url, title })
}

#[tauri::command]
fn reload_site(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let webview = lock_webview(&state.site, "site")?;
    *state.site_loaded.lock().map_err(|e| e.to_string())? = false;
    webview.reload().map_err(|e| e.to_string())
}

/// Receives a bounded JSON result for a pending page request. Only the site
/// webview has this command permission; the label check is defense in depth.
#[tauri::command]
fn page_result(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    id: String,
    ok: bool,
    payload: String,
) -> Result<(), String> {
    if webview.label() != "site" {
        return Err("page results are accepted only from the site webview".to_string());
    }
    if id.len() > 64 {
        return Err("invalid page request id".to_string());
    }
    if payload.len() > MAX_PAGE_RESULT_BYTES {
        return Err("page result exceeds the 8 MB limit".to_string());
    }

    let result = if ok {
        serde_json::from_str(&payload).map_err(|e| format!("invalid page result: {e}"))
    } else {
        Err(payload)
    };
    let sender = state
        .pending_page_results
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
        .ok_or_else(|| "no matching page request".to_string())?;
    sender
        .send(result)
        .map_err(|_| "page request is no longer waiting".to_string())
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
            sidebar: Mutex::new(None),
            site: Mutex::new(None),
            site_loaded: Mutex::new(false),
            pending_page_results: Mutex::new(HashMap::new()),
            pending_navigation: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            set_sidebar_width,
            site_navigate,
            site_info,
            site_run,
            page_result,
            reload_site,
            config::get_config,
            config::save_config,
            config::set_firebase_token,
            secret::delete_firebase_token,
            scripts::list_scripts,
            scripts::load_script,
            logging::append_console_log,
            input::pointer_geometry,
            input::mouse_path,
            input::click_at,
            input::scroll_wheel,
            input::type_text,
            input::start_recording,
            input::stop_recording,
            input::recording_status,
            input_lock::input_lock_status,
            input_lock::set_input_locked,
            input_lock::wait_for_automation,
            input_lock::input_activity,
            input_lock::begin_automation,
            input_lock::end_automation,
            input_lock::confirmation_control,
            input_lock::wait_confirmation,
            input::list_recordings,
            input::load_recording,
            input::delete_recording,
            capture::screenshot,
        ])
        .setup(move |app| {
            let window = tauri::window::WindowBuilder::new(app, "main")
                .title("Muse Local")
                .inner_size(1440.0, 900.0)
                .maximized(true)
                .build()?;
            let size = window.inner_size()?;
            let initial_w = clamped_sidebar_width(initial_w, size.width);

            // Sidebar: the app's own control panel — settings, recordings,
            // connection test. This pane is "the app".
            let sidebar = tauri::webview::WebviewBuilder::new(
                "sidebar",
                tauri::WebviewUrl::App("index.html".into()),
            );
            let sidebar_wv = window.add_child(
                sidebar,
                tauri::LogicalPosition::new(0, 0),
                tauri::PhysicalSize::new(initial_w, size.height),
            )?;
            // Keep the handles: commands use these directly instead of
            // label lookup.
            app.state::<AppState>()
                .sidebar
                .lock()
                .map_err(|e| e.to_string())?
                .replace(sidebar_wv);

            // Site: an ordinary webview. Page code is injected only on demand
            // by site_run; it never owns the command channel or native actions.
            //
            // Create on a local blank page, then navigate after attaching the
            // page-load handler.
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
            let load_app = app.handle().clone();
            let site =
                tauri::webview::WebviewBuilder::new("site", tauri::WebviewUrl::External(blank))
                    .on_page_load(move |webview, payload| {
                        if webview.label() != "site" {
                            return;
                        }
                        let state = load_app.state::<AppState>();
                        if let Ok(mut loaded) = state.site_loaded.lock() {
                            *loaded =
                                matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                                    && matches!(payload.url().scheme(), "http" | "https");
                        }
                        let Ok(mut pending) = state.pending_navigation.lock() else {
                            eprintln!("muse-local: navigation state lock poisoned");
                            return;
                        };
                        let Some(request) = pending.as_mut() else {
                            return;
                        };
                        match payload.event() {
                            tauri::webview::PageLoadEvent::Started
                                if payload.url().as_str() == request.expected_url =>
                            {
                                request.started = true;
                            }
                            tauri::webview::PageLoadEvent::Finished if request.started => {
                                if let Some(request) = pending.take() {
                                    let _ = request.sender.send(payload.url().to_string());
                                }
                            }
                            _ => {}
                        }
                    });
            let site_wv = window.add_child(
                site,
                tauri::PhysicalPosition::new(initial_w, 0),
                tauri::PhysicalSize::new(size.width.saturating_sub(initial_w), size.height),
            )?;
            app.state::<AppState>()
                .site
                .lock()
                .map_err(|e| e.to_string())?
                .replace(site_wv.clone());
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
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    input_lock::unlock();
                    app_h.exit(0);
                    return;
                }
                if let tauri::WindowEvent::Resized(_) = event {
                    let state = app_h.state::<AppState>();
                    let w = state
                        .sidebar_width
                        .lock()
                        .map(|g| *g)
                        .unwrap_or(DEFAULT_SIDEBAR_W);
                    let _ = apply_layout(state, w);
                }
            });

            input_lock::install_indicator(app.handle()).map_err(std::io::Error::other)?;
            if let Err(error) = input_lock::initialize() {
                input_lock::fail(error);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
