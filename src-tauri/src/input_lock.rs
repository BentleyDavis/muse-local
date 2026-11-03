use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

// Low bit is locked; the remaining bits invalidate an in-flight relock when
// Escape is pressed. A single atomic prevents relocking over an emergency stop.
static CONTROL: AtomicU64 = AtomicU64::new(0);
static READY: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static PAUSED: AtomicBool = AtomicBool::new(false);
static CONFIRMATION: AtomicU64 = AtomicU64::new(0);
static CONFIRMATION_KEY: AtomicU64 = AtomicU64::new(0);

pub fn confirmation_key(key: u32, down: bool) -> bool {
    if !down && CONFIRMATION_KEY.load(Ordering::SeqCst) == u64::from(key) {
        CONFIRMATION_KEY.store(0, Ordering::SeqCst);
        return true;
    }
    if down && CONFIRMATION_KEY.load(Ordering::SeqCst) == u64::from(key) {
        return true;
    }
    let response = match key {
        0x59 => 2, // Y
        0x4e => 3, // N
        _ => return false,
    };
    if down
        && CONFIRMATION
            .compare_exchange(1, response, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        CONFIRMATION_KEY.store(u64::from(key), Ordering::SeqCst);
        return true;
    }
    false
}

pub fn cancel_confirmation() {
    let _ = CONFIRMATION.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
        if state == 1 || state == 2 {
            Some(4)
        } else {
            None
        }
    });
}

#[tauri::command]
pub async fn wait_confirmation() -> Result<u64, String> {
    loop {
        if !ready() {
            return Err("input protection unavailable; confirmation cancelled".into());
        }
        let response = CONFIRMATION.load(Ordering::SeqCst);
        if response != 1 {
            if response == 2 && !locked() {
                return Err("Approval cancelled: input was unlocked".into());
            }
            return Ok(response);
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[cfg(windows)]
fn start_safety_hotkeys() {
    std::thread::spawn(|| unsafe {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            PeekMessageW, MSG, PM_REMOVE, WM_HOTKEY,
        };
        let mut escape_registered = false;
        let mut confirmation_registered = false;
        loop {
            let active = ACTIVE.load(Ordering::SeqCst);
            let pending = CONFIRMATION.load(Ordering::SeqCst) == 1;
            if active != escape_registered {
                if active {
                    if RegisterHotKey(std::ptr::null_mut(), 1, MOD_NOREPEAT, 0x1b) == 0 {
                        fail("Cannot register emergency Escape hotkey; automation disabled".into());
                        return;
                    }
                } else {
                    UnregisterHotKey(std::ptr::null_mut(), 1);
                }
                escape_registered = active;
            }
            if pending != confirmation_registered {
                if pending {
                    if RegisterHotKey(std::ptr::null_mut(), 2, MOD_NOREPEAT, 0x59) == 0
                        || RegisterHotKey(std::ptr::null_mut(), 3, MOD_NOREPEAT, 0x4e) == 0
                    {
                        UnregisterHotKey(std::ptr::null_mut(), 1);
                        UnregisterHotKey(std::ptr::null_mut(), 2);
                        UnregisterHotKey(std::ptr::null_mut(), 3);
                        fail(
                            "Cannot register confirmation Y/N hotkeys; automation disabled".into(),
                        );
                        return;
                    }
                } else {
                    UnregisterHotKey(std::ptr::null_mut(), 2);
                    UnregisterHotKey(std::ptr::null_mut(), 3);
                }
                confirmation_registered = pending;
            }
            let mut message: MSG = std::mem::zeroed();
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                if message.message == WM_HOTKEY {
                    match message.wParam {
                        1 => unlock(),
                        2 => {
                            let _ = CONFIRMATION.compare_exchange(
                                1,
                                2,
                                Ordering::SeqCst,
                                Ordering::SeqCst,
                            );
                        }
                        3 => {
                            let _ = CONFIRMATION.compare_exchange(
                                1,
                                3,
                                Ordering::SeqCst,
                                Ordering::SeqCst,
                            );
                        }
                        _ => {}
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    });
}

#[tauri::command]
pub fn confirmation_control(pending: Option<bool>) -> Result<u64, String> {
    if let Some(pending) = pending {
        if pending && !ready() {
            return Err("input hooks unavailable; confirmation keys cannot be used".into());
        }
        if pending && !locked() {
            return Err("Input is unlocked; confirmation not armed".into());
        }
        CONFIRMATION.store(if pending { 1 } else { 0 }, Ordering::SeqCst);
        if pending && !locked() {
            cancel_confirmation();
        }
    }
    Ok(CONFIRMATION.load(Ordering::SeqCst))
}
static ERROR: Mutex<Option<String>> = Mutex::new(None);
static ACTIVITY: Mutex<(String, usize)> = Mutex::new((String::new(), 0));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    locked: bool,
    active: bool,
    paused: bool,
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
    cancel_confirmation();
    if ACTIVE.load(Ordering::SeqCst) || locked() {
        PAUSED.store(true, Ordering::SeqCst);
    }
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
    #[cfg(windows)]
    start_safety_hotkeys();
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
        active: ACTIVE.load(Ordering::SeqCst),
        paused: PAUSED.load(Ordering::SeqCst),
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
        PAUSED.store(true, Ordering::SeqCst);
        unlock();
        return input_lock_status();
    }
    if !ACTIVE.load(Ordering::SeqCst) {
        PAUSED.store(false, Ordering::SeqCst);
        return input_lock_status();
    }
    PAUSED.store(false, Ordering::SeqCst);
    if let Err(error) = lock_input(app).await {
        PAUSED.store(true, Ordering::SeqCst);
        return Err(error);
    }
    input_lock_status()
}

async fn lock_input(app: tauri::AppHandle) -> Result<(), String> {
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
    Ok(())
}

#[tauri::command]
pub async fn begin_automation(app: tauri::AppHandle) -> Result<(), String> {
    ACTIVE.store(true, Ordering::SeqCst);
    loop {
        if !ready() {
            ACTIVE.store(false, Ordering::SeqCst);
            return Err("input protection unavailable; automation stopped".into());
        }
        if PAUSED.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            continue;
        }
        match lock_input(app.clone()).await {
            Ok(()) => return Ok(()),
            Err(_) if PAUSED.load(Ordering::SeqCst) => continue,
            Err(error) => {
                ACTIVE.store(false, Ordering::SeqCst);
                return Err(error);
            }
        }
    }
}

#[tauri::command]
pub fn end_automation() {
    ACTIVE.store(false, Ordering::SeqCst);
    let _ = CONTROL.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
        Some(state.wrapping_add(2) & !1)
    });
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
            } else if status.paused {
                ("MUSE - UNLOCKED - automation paused", "#205b39")
            } else {
                ("MUSE - UNLOCKED - idle / ready", "#205b39")
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
