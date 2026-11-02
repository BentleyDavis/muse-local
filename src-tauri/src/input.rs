//! Native input (Windows): OS-level mouse movement/clicks/typing via
//! SendInput, plus low-level mouse-hook recording of the user's real
//! movements for the human-movement model.
//!
//! No browser-automation library is involved anywhere — this is raw Win32.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedPoint {
    pub x: i32,
    pub y: i32,
    pub dt_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub id: String,
    pub points: usize,
    pub length_px: f64,
    pub created: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecPoint {
    pub t: u64,
    pub x: i32,
    pub y: i32,
}

#[cfg(windows)]
mod win {
    use super::{RecPoint, RecordingInfo, TimedPoint};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Instant, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    fn screen_size() -> (i32, i32) {
        unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
    }

    fn to_absolute(x: i32, y: i32) -> (i32, i32) {
        let (w, h) = screen_size();
        let w = w.max(1) as i64;
        let h = h.max(1) as i64;
        (
            ((x.max(0) as i64 * 65535) / w) as i32,
            ((y.max(0) as i64 * 65535) / h) as i32,
        )
    }

    fn send_mouse(mi: MOUSEINPUT) -> Result<(), String> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi },
        };
        let sent = unsafe {
            SendInput(
                1,
                &input as *const INPUT,
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if sent != 1 {
            return Err("SendInput (mouse) failed".to_string());
        }
        Ok(())
    }

    fn mouse_move_abs(x: i32, y: i32) -> Result<(), String> {
        let (ax, ay) = to_absolute(x, y);
        send_mouse(MOUSEINPUT {
            dx: ax,
            dy: ay,
            mouseData: 0,
            dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
            time: 0,
            dwExtraInfo: 0,
        })
    }

    fn mouse_button(down: bool, button: &str) -> Result<(), String> {
        let flag = match (button, down) {
            ("left", true) => MOUSEEVENTF_LEFTDOWN,
            ("left", false) => MOUSEEVENTF_LEFTUP,
            ("right", true) => MOUSEEVENTF_RIGHTDOWN,
            ("right", false) => MOUSEEVENTF_RIGHTUP,
            ("middle", true) => MOUSEEVENTF_MIDDLEDOWN,
            ("middle", false) => MOUSEEVENTF_MIDDLEUP,
            _ => return Err(format!("unknown mouse button: {}", button)),
        };
        send_mouse(MOUSEINPUT {
            dx: 0,
            dy: 0,
            mouseData: 0,
            dwFlags: flag,
            time: 0,
            dwExtraInfo: 0,
        })
    }

    pub fn mouse_path(points: &[TimedPoint]) -> Result<(), String> {
        for p in points {
            mouse_move_abs(p.x, p.y)?;
            if p.dt_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(p.dt_ms.min(2000)));
            }
        }
        Ok(())
    }

    pub fn click_at(x: i32, y: i32, button: &str) -> Result<(), String> {
        mouse_move_abs(x, y)?;
        std::thread::sleep(std::time::Duration::from_millis(30));
        mouse_button(true, button)?;
        std::thread::sleep(std::time::Duration::from_millis(40));
        mouse_button(false, button)?;
        Ok(())
    }

    pub fn type_text(text: &str) -> Result<(), String> {
        // Each UTF-16 unit goes out as a KEYEVENTF_UNICODE keypress, so the
        // target app receives genuine key events (works in password fields,
        // chat boxes, and anywhere synthetic DOM events are distrusted).
        for scan in text.encode_utf16() {
            for key_up in [false, true] {
                let ki = KEYBDINPUT {
                    wVk: 0,
                    wScan: scan,
                    dwFlags: if key_up {
                        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                    } else {
                        KEYEVENTF_UNICODE
                    },
                    time: 0,
                    dwExtraInfo: 0,
                };
                let input = INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 { ki },
                };
                let sent = unsafe {
                    SendInput(
                        1,
                        &input as *const INPUT,
                        std::mem::size_of::<INPUT>() as i32,
                    )
                };
                if sent != 1 {
                    return Err("SendInput (keyboard) failed".to_string());
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        Ok(())
    }

    // ---------- movement recording (WH_MOUSE_LL hook) ----------

    struct RecState {
        active: bool,
        start: Option<Instant>,
        points: Vec<RecPoint>,
    }

    static REC: OnceLock<Mutex<RecState>> = OnceLock::new();
    static HOOK_THREAD: OnceLock<()> = OnceLock::new();

    fn rec_state() -> &'static Mutex<RecState> {
        REC.get_or_init(|| {
            Mutex::new(RecState {
                active: false,
                start: None,
                points: Vec::new(),
            })
        })
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && wparam.0 as u32 == WM_MOUSEMOVE {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            if let Ok(mut st) = rec_state().lock() {
                if st.active {
                    let start = *st.start.get_or_insert_with(Instant::now);
                    let t = start.elapsed().as_millis() as u64;
                    // Thin out: keep a point only if it moved >= 2px or
                    // >= 16ms elapsed since the previous kept point.
                    let keep = match st.points.last() {
                        None => true,
                        Some(prev) => {
                            (info.pt.x - prev.x).abs() + (info.pt.y - prev.y).abs() >= 2
                                || t.saturating_sub(prev.t) >= 16
                        }
                    };
                    if keep {
                        st.points.push(RecPoint {
                            t,
                            x: info.pt.x,
                            y: info.pt.y,
                        });
                    }
                }
            }
        }
        CallNextHookEx(0, code, wparam, lparam)
    }

    fn ensure_hook_thread() {
        HOOK_THREAD.get_or_init(|| {
            std::thread::spawn(|| unsafe {
                // WH_MOUSE_LL must live on a thread that pumps messages.
                let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), 0, 0);
                if hook == 0 {
                    return;
                }
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, 0, 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            });
        });
    }

    fn recordings_dir() -> Result<std::path::PathBuf, String> {
        let dir = crate::config::app_dir().join("recordings");
        std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create recordings dir: {}", e))?;
        Ok(dir)
    }

    fn epoch_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    fn path_length(points: &[RecPoint]) -> f64 {
        points
            .windows(2)
            .map(|w| {
                let dx = (w[1].x - w[0].x) as f64;
                let dy = (w[1].y - w[0].y) as f64;
                dx.hypot(dy)
            })
            .sum()
    }

    pub fn start_recording() -> Result<(), String> {
        ensure_hook_thread();
        let mut st = rec_state().lock().map_err(|e| e.to_string())?;
        st.active = true;
        st.start = None;
        st.points.clear();
        Ok(())
    }

    pub fn stop_recording() -> Result<RecordingInfo, String> {
        let (points, id) = {
            let mut st = rec_state().lock().map_err(|e| e.to_string())?;
            st.active = false;
            let pts = std::mem::take(&mut st.points);
            (pts, format!("rec-{}", epoch_secs()))
        };
        if points.len() < 2 {
            return Err("recording too short — no usable movement captured".to_string());
        }
        let info = RecordingInfo {
            id: id.clone(),
            points: points.len(),
            length_px: path_length(&points),
            created: epoch_secs().to_string(),
        };
        let dir = recordings_dir()?;
        let raw = serde_json::to_string(&points).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(format!("{}.json", id)), raw).map_err(|e| e.to_string())?;
        Ok(info)
    }

    pub fn list_recordings() -> Result<Vec<RecordingInfo>, String> {
        let dir = recordings_dir()?;
        let mut out = Vec::new();
        let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let (count, length) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Vec<RecPoint>>(&raw).ok())
                .map(|pts| (pts.len(), path_length(&pts)))
                .unwrap_or((0, 0.0));
            out.push(RecordingInfo {
                id,
                points: count,
                length_px: length,
                created: String::new(),
            });
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    pub fn load_recording(id: &str) -> Result<Vec<RecPoint>, String> {
        if id.contains(['/', '\\', '.', ':']) {
            return Err("invalid recording id".to_string());
        }
        let path = recordings_dir()?.join(format!("{}.json", id));
        let raw = std::fs::read_to_string(&path).map_err(|_| format!("recording not found: {}", id))?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn mouse_path(points: Vec<TimedPoint>) -> Result<(), String> {
    #[cfg(windows)]
    return win::mouse_path(&points);
    #[cfg(not(windows))]
    {
        let _ = &points;
        Err("mouse_path is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn click_at(x: i32, y: i32, button: String) -> Result<(), String> {
    #[cfg(windows)]
    return win::click_at(x, y, &button);
    #[cfg(not(windows))]
    {
        let _ = (&x, &y, &button);
        Err("click_at is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn type_text(text: String) -> Result<(), String> {
    #[cfg(windows)]
    return win::type_text(&text);
    #[cfg(not(windows))]
    {
        let _ = &text;
        Err("type_text is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn start_recording() -> Result<(), String> {
    #[cfg(windows)]
    return win::start_recording();
    #[cfg(not(windows))]
    Err("recording is only supported on Windows".to_string())
}

#[tauri::command]
pub fn stop_recording() -> Result<RecordingInfo, String> {
    #[cfg(windows)]
    return win::stop_recording();
    #[cfg(not(windows))]
    Err("recording is only supported on Windows".to_string())
}

#[tauri::command]
pub fn list_recordings() -> Result<Vec<RecordingInfo>, String> {
    #[cfg(windows)]
    return win::list_recordings();
    #[cfg(not(windows))]
    Err("recording is only supported on Windows".to_string())
}

#[tauri::command]
pub fn load_recording(id: String) -> Result<Vec<RecPoint>, String> {
    #[cfg(windows)]
    return win::load_recording(&id);
    #[cfg(not(windows))]
    {
        let _ = &id;
        Err("recording is only supported on Windows".to_string())
    }
}
