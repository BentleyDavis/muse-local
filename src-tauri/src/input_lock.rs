use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

// Low bit is locked; the remaining bits invalidate an in-flight relock when
// Escape is pressed. A single atomic prevents relocking over an emergency stop.
static CONTROL: AtomicU64 = AtomicU64::new(0);
static READY: AtomicBool = AtomicBool::new(false);
static ERROR: Mutex<Option<String>> = Mutex::new(None);
static ACTIVITY: Mutex<(String, usize)> = Mutex::new((String::new(), 0));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    locked: bool,
    ready: bool,
    error: Option<String>,
}

pub fn locked() -> bool {
    CONTROL.load(Ordering::SeqCst) & 1 != 0
}

pub fn ready() -> bool {
    READY.load(Ordering::SeqCst)
}

pub fn unlock() {
    let _ = CONTROL.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
        Some((state.wrapping_add(2)) & !1)
    });
}

pub fn fail(message: String) {
    unlock();
    READY.store(false, Ordering::SeqCst);
    eprintln!("input protection failed: {message}");
    if let Ok(mut error) = ERROR.lock() {
        *error = Some(message);
    }
}

pub fn initialize() -> Result<(), String> {
    crate::input::initialize_hooks()?;
    READY.store(true, Ordering::SeqCst);
    let _ = CONTROL.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst);
    Ok(())
}

pub fn wait_until_running() -> Result<(), String> {
    loop {
        if !READY.load(Ordering::SeqCst) {
            return Err("input protection is unavailable; automation is stopped".to_string());
        }
        if locked() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[tauri::command]
pub fn input_lock_status() -> Result<LockStatus, String> {
    Ok(LockStatus {
        locked: locked(),
        ready: READY.load(Ordering::SeqCst),
        error: ERROR.lock().map_err(|e| e.to_string())?.clone(),
    })
}

#[tauri::command]
pub async fn wait_for_automation() -> Result<(), String> {
    crate::run_blocking(wait_until_running).await
}

#[tauri::command]
pub fn input_activity(action: String, queued: usize) -> Result<(), String> {
    *ACTIVITY.lock().map_err(|e| e.to_string())? = (action.chars().take(80).collect(), queued);
    Ok(())
}

#[tauri::command]
pub async fn set_input_locked(app: tauri::AppHandle, locked: bool) -> Result<LockStatus, String> {
    if !locked {
        unlock();
        return input_lock_status();
    }
    if !READY.load(Ordering::SeqCst) {
        return Err("input protection is unavailable; restart the app".to_string());
    }
    if crate::input::recording_status()?.active {
        return Err("stop recording before locking input".to_string());
    }
    let generation = CONTROL.load(Ordering::SeqCst);
    let site = crate::lock_webview(&app.state::<crate::AppState>().site, "site")?;
    let window = site.window();
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    site.set_focus().map_err(|e| e.to_string())?;
    // Let the physical click on Lock finish before suppressing real button-up.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    if !READY.load(Ordering::SeqCst) {
        return Err("input protection became unavailable; input remains unlocked".to_string());
    }
    if !window.is_focused().map_err(|e| e.to_string())? {
        return Err("could not focus Muse; input remains unlocked".to_string());
    }
    CONTROL
        .compare_exchange(
            generation,
            generation | 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .map_err(|_| "lock cancelled by Escape; input remains unlocked".to_string())?;
    input_lock_status()
}

pub fn install_indicator(app: &tauri::AppHandle) -> Result<(), String> {
    let banner = tauri::WebviewWindowBuilder::new(
        app,
        "input-status",
        tauri::WebviewUrl::App("input-status.html".into()),
    )
    .title("Muse input status")
    .inner_size(640.0, 44.0)
    .position(20.0, 0.0)
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .build()
    .map_err(|e| e.to_string())?;
    banner
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    let main = app.get_window("main").ok_or("main window not found")?;
    std::thread::spawn(move || {
        let mut previous = String::new();
        loop {
            let status = match input_lock_status() {
                Ok(status) => status,
                Err(error) => {
                    fail(error);
                    return;
                }
            };
            let (text, color) = if !status.ready {
                (
                    "MUSE - protection unavailable - automation stopped",
                    "#8b2020",
                )
            } else if status.locked {
                ("MUSE - INPUT LOCKED - Escape unlocks / pauses", "#7c2525")
            } else {
                ("MUSE - UNLOCKED - automation paused", "#205b39")
            };
            let activity = match ACTIVITY.lock() {
                Ok(activity) => activity.clone(),
                Err(error) => {
                    fail(format!("input activity state failed: {error}"));
                    return;
                }
            };
            let text = format!(
                "{text} | {} | {} queued",
                if activity.0.is_empty() {
                    "Idle"
                } else {
                    &activity.0
                },
                activity.1
            );
            let current = format!("{text}|{color}");
            // Repeat evaluation until the webview finishes loading as well.
            if let Err(error) = banner.eval(&format!(
                "document.body.textContent={};document.body.style.background={};",
                serde_json::json!(text),
                serde_json::json!(color),
            )) {
                fail(format!("input status indicator failed: {error}"));
                return;
            }
            if current != previous {
                if let Err(error) = main.set_title(&format!("{text} | Muse Local")) {
                    fail(format!("input status title failed: {error}"));
                    return;
                }
                previous = current;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });
    Ok(())
}
