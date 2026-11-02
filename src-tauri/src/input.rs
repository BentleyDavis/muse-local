//! Native input (Windows): OS-level mouse movement/clicks/typing via
//! SendInput, plus low-level mouse-hook recording of the user's real
//! movements for the human-movement model.
//!
//! No browser-automation library is involved anywhere — this is raw Win32.

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ScreenPoint {
    x: i32,
    y: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerFrame {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    url: String,
}

impl PointerFrame {
    fn contains(&self, x: i32, y: i32) -> bool {
        i64::from(x) >= i64::from(self.x)
            && i64::from(y) >= i64::from(self.y)
            && i64::from(x) < i64::from(self.x) + i64::from(self.width)
            && i64::from(y) < i64::from(self.y) + i64::from(self.height)
    }

    fn clamp(&self, x: i32, y: i32) -> (i32, i32) {
        (
            i64::from(x).clamp(
                i64::from(self.x),
                i64::from(self.x) + i64::from(self.width) - 1,
            ) as i32,
            i64::from(y).clamp(
                i64::from(self.y),
                i64::from(self.y) + i64::from(self.height) - 1,
            ) as i32,
        )
    }
}

#[derive(Debug, Serialize)]
pub struct PointerGeometry {
    frame: PointerFrame,
    cursor: ScreenPoint,
}

fn site_frame(site: &tauri::Webview) -> Result<PointerFrame, String> {
    let state = site.app_handle().state::<crate::AppState>();
    if !*state.site_loaded.lock().map_err(|e| e.to_string())? {
        return Err("target webpage is not loaded".to_string());
    }
    let window = site.window();
    if window.is_minimized().map_err(|e| e.to_string())?
        || !window.is_visible().map_err(|e| e.to_string())?
    {
        return Err("target webpage must be visible".to_string());
    }
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let client = window.inner_size().map_err(|e| e.to_string())?;
    let position = site.position().map_err(|e| e.to_string())?;
    let size = site.size().map_err(|e| e.to_string())?;
    let sidebar = crate::lock_webview(&state.sidebar, "sidebar")?;
    let sidebar_position = sidebar.position().map_err(|e| e.to_string())?;
    let sidebar_size = sidebar.size().map_err(|e| e.to_string())?;
    if i64::from(sidebar_position.x) + i64::from(sidebar_size.width) > i64::from(position.x) {
        return Err("sidebar overlaps the target webpage; wait for layout to finish".to_string());
    }
    if position.x < 0 || position.y < 0 {
        return Err("target webpage has an invalid client position".to_string());
    }
    let width = size.width.min(client.width.saturating_sub(position.x as u32));
    let height = size
        .height
        .min(client.height.saturating_sub(position.y as u32));
    if width == 0 || height == 0 {
        return Err("target webpage has no visible area".to_string());
    }
    let x = origin
        .x
        .checked_add(position.x)
        .ok_or("invalid webpage x position")?;
    let y = origin
        .y
        .checked_add(position.y)
        .ok_or("invalid webpage y position")?;
    if i64::from(x) + i64::from(width) > i64::from(i32::MAX)
        || i64::from(y) + i64::from(height) > i64::from(i32::MAX)
    {
        return Err("invalid webpage bounds".to_string());
    }
    Ok(PointerFrame {
        x,
        y,
        width,
        height,
        scale_factor: window.scale_factor().map_err(|e| e.to_string())?,
        url: site.url().map_err(|e| e.to_string())?.to_string(),
    })
}

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
    use super::{PointerFrame, RecPoint, RecordingInfo, ScreenPoint, TimedPoint};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Instant, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        MonitorFromPoint, ScreenToClient, MONITOR_DEFAULTTONULL,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    pub fn cursor_position() -> Result<ScreenPoint, String> {
        let mut point = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0 {
            return Err("GetCursorPos failed".to_string());
        }
        Ok(ScreenPoint {
            x: point.x,
            y: point.y,
        })
    }

    pub fn validate_target(hwnd: isize, x: i32, y: i32) -> Result<(), String> {
        let hwnd = hwnd as HWND;
        unsafe {
            if GetForegroundWindow() != hwnd || IsIconic(hwnd) != 0 || IsWindowVisible(hwnd) == 0 {
                return Err(
                    "app must be visible and in the foreground for native pointer input".to_string(),
                );
            }
            if MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL).is_null() {
                return Err("pointer target is not on a connected monitor".to_string());
            }
            let hit = WindowFromPoint(POINT { x, y });
            if hit.is_null() || GetAncestor(hit, GA_ROOT) != hwnd {
                return Err(
                    "target webpage is covered or outside the visible desktop".to_string(),
                );
            }
            let mut client_point = POINT { x, y };
            let mut client_rect = std::mem::zeroed();
            if ScreenToClient(hwnd, &mut client_point) == 0
                || GetClientRect(hwnd, &mut client_rect) == 0
                || client_point.x < client_rect.left
                || client_point.x >= client_rect.right
                || client_point.y < client_rect.top
                || client_point.y >= client_rect.bottom
            {
                return Err("pointer target is outside the app client area".to_string());
            }
        }
        Ok(())
    }

    fn to_absolute(x: i32, y: i32) -> Result<(i32, i32), String> {
        let (left, top, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if width <= 1
            || height <= 1
            || i64::from(x) < i64::from(left)
            || i64::from(y) < i64::from(top)
            || i64::from(x) >= i64::from(left) + i64::from(width)
            || i64::from(y) >= i64::from(top) + i64::from(height)
        {
            return Err("pointer target is outside the virtual desktop".to_string());
        }
        // Aim at the pixel center so absolute-input quantization cannot
        // round an edge point into the sidebar or the next window.
        if width > 65536 || height > 65536 {
            return Err("virtual desktop exceeds absolute pointer resolution".to_string());
        }
        Ok((
            (((i64::from(x) - i64::from(left)) * 65536 + 32768) / i64::from(width))
                .min(65535) as i32,
            (((i64::from(y) - i64::from(top)) * 65536 + 32768) / i64::from(height))
                .min(65535) as i32,
        ))
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

    fn mouse_move_abs(x: i32, y: i32, button_flag: u32) -> Result<(), String> {
        let (ax, ay) = to_absolute(x, y)?;
        send_mouse(MOUSEINPUT {
            dx: ax,
            dy: ay,
            mouseData: 0,
            dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | button_flag,
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

    pub fn mouse_path(
        points: &[TimedPoint],
        speed: f64,
        frame: &PointerFrame,
        check: impl Fn(i32, i32) -> Result<(), String>,
    ) -> Result<(), String> {
        // speed multiplies replay tempo: 1.0 = as recorded, 2.0 = twice as
        // fast. Only boundary clipping below changes the recorded trajectory.
        let speed = speed.clamp(0.25, 4.0);
        for p in points {
            // Recorded curves can overshoot even when both endpoints are safe.
            let (x, y) = frame.clamp(p.x, p.y);
            check(x, y)?;
            mouse_move_abs(x, y, 0)?;
            let dt = ((p.dt_ms as f64) / speed).round() as u64;
            if dt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(dt.min(2000)));
            }
        }
        Ok(())
    }

    pub fn click_at(
        x: i32,
        y: i32,
        button: &str,
        check: impl Fn(i32, i32) -> Result<(), String>,
    ) -> Result<(), String> {
        let down = match button {
            "left" => MOUSEEVENTF_LEFTDOWN,
            "right" => MOUSEEVENTF_RIGHTDOWN,
            "middle" => MOUSEEVENTF_MIDDLEDOWN,
            _ => return Err(format!("unknown mouse button: {button}")),
        };
        check(x, y)?;
        mouse_move_abs(x, y, 0)?;
        std::thread::sleep(std::time::Duration::from_millis(30));
        check(x, y)?;
        // Position and button-down are one input event, not a click at a
        // potentially different cursor position after the settling delay.
        mouse_move_abs(x, y, down)?;
        std::thread::sleep(std::time::Duration::from_millis(40));
        mouse_button(false, button)?;
        Ok(())
    }

    /// Dependency-free xorshift64* — good enough for humanizing timing.
    struct Lcg(u64);
    impl Lcg {
        fn new() -> Self {
            let seed = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0x9E3779B97F4A7C15)
                | 1;
            Lcg(seed)
        }
        fn next_f64(&mut self) -> f64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            ((x.wrapping_mul(0x2545F4914F6CDD1D) >> 11) as f64) / (u64::MAX as f64)
        }
    }

    fn key_press(scan: u16) -> Result<(), String> {
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
        Ok(())
    }

    pub fn type_text(text: &str, wpm: f64) -> Result<(), String> {
        // Human typing: base rate from WPM with per-keystroke variance,
        // slightly longer on spaces and sentence-ending punctuation, and an
        // occasional "thinking pause". Each char is still a genuine
        // KEYEVENTF_UNICODE keypress, so it works in password fields and
        // anywhere synthetic DOM events are distrusted.
        let wpm = wpm.clamp(15.0, 160.0);
        let base_ms = 12000.0 / wpm; // ~5 chars per word
        let mut rng = Lcg::new();
        let mut buf = [0u16; 2];
        for ch in text.chars() {
            for scan in ch.encode_utf16(&mut buf) {
                key_press(*scan)?;
            }
            let mut delay = base_ms * (0.6 + rng.next_f64() * 0.8);
            if ch == ' ' {
                delay += 40.0;
            }
            if ".!?".contains(ch) {
                delay += 250.0 + rng.next_f64() * 350.0;
            }
            if rng.next_f64() < 0.04 {
                delay += 400.0 + rng.next_f64() * 800.0;
            }
            std::thread::sleep(std::time::Duration::from_millis(
                delay.round().max(1.0) as u64
            ));
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
        // Note: in windows-sys 0.59 WPARAM/LPARAM are primitive aliases
        // (usize/isize), not tuple structs — no `.0` field access.
        if code >= 0 && wparam as u32 == WM_MOUSEMOVE {
            let info = &*(lparam as *const MSLLHOOKSTRUCT);
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
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    fn ensure_hook_thread() {
        HOOK_THREAD.get_or_init(|| {
            std::thread::spawn(|| unsafe {
                // WH_MOUSE_LL must live on a thread that pumps messages.
                let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), std::ptr::null_mut(), 0);
                if hook.is_null() {
                    return;
                }
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            });
        });
    }

    fn recordings_dir() -> Result<std::path::PathBuf, String> {
        let dir = crate::config::app_dir().join("recordings");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create recordings dir: {}", e))?;
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

    pub fn delete_recording(id: &str) -> Result<(), String> {
        if id.contains('/') || id.contains('\\') || id.contains("..") {
            return Err("bad recording id".to_string());
        }
        let path = recordings_dir()?.join(format!("{}.json", id));
        std::fs::remove_file(&path).map_err(|e| e.to_string())
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
        let raw =
            std::fs::read_to_string(&path).map_err(|_| format!("recording not found: {}", id))?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn pointer_geometry(
    state: tauri::State<'_, crate::AppState>,
) -> Result<PointerGeometry, String> {
    let site = crate::lock_webview(&state.site, "site")?;
    #[cfg(windows)]
    return crate::run_blocking(move || {
        Ok(PointerGeometry {
            frame: site_frame(&site)?,
            cursor: win::cursor_position()?,
        })
    })
    .await;
    #[cfg(not(windows))]
    {
        let _ = site;
        Err("pointer geometry is only supported on Windows".to_string())
    }
}

#[cfg(windows)]
fn check_pointer(
    site: &tauri::Webview,
    frame: &PointerFrame,
    hwnd: isize,
    x: i32,
    y: i32,
) -> Result<(), String> {
    if site_frame(site)? != *frame {
        return Err(
            "target webpage moved, resized, changed scale, or navigated; resolve the target again"
                .to_string(),
        );
    }
    if !frame.contains(x, y) {
        return Err("native pointer input must stay inside the target webpage".to_string());
    }
    win::validate_target(hwnd, x, y)
}

#[tauri::command]
pub async fn mouse_path(
    state: tauri::State<'_, crate::AppState>,
    points: Vec<TimedPoint>,
    speed: f64,
    frame: PointerFrame,
) -> Result<(), String> {
    if !speed.is_finite() {
        return Err("mouse speed must be finite".to_string());
    }
    if points.is_empty() || points.len() > 100_000 {
        return Err("mouse path must contain 1 to 100000 points".to_string());
    }
    let site = crate::lock_webview(&state.site, "site")?;
    #[cfg(windows)]
    {
        let hwnd = site.window().hwnd().map_err(|e| e.to_string())?.0 as isize;
        return crate::run_blocking(move || {
            if site_frame(&site)? != frame {
                return Err("webpage geometry changed; resolve the target again".to_string());
            }
            if !frame.contains(points[0].x, points[0].y)
                || !frame.contains(points[points.len() - 1].x, points[points.len() - 1].y)
            {
                return Err("movement endpoints must be inside the target webpage".to_string());
            }
            win::mouse_path(&points, speed, &frame, |x, y| {
                check_pointer(&site, &frame, hwnd, x, y)
            })
        })
        .await;
    }
    #[cfg(not(windows))]
    {
        let _ = (&points, &speed, &frame, &site);
        Err("mouse_path is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub async fn click_at(
    state: tauri::State<'_, crate::AppState>,
    x: i32,
    y: i32,
    button: String,
    frame: PointerFrame,
) -> Result<(), String> {
    let site = crate::lock_webview(&state.site, "site")?;
    #[cfg(windows)]
    {
        let hwnd = site.window().hwnd().map_err(|e| e.to_string())?.0 as isize;
        return crate::run_blocking(move || {
            win::click_at(x, y, &button, |x, y| check_pointer(&site, &frame, hwnd, x, y))
        })
        .await;
    }
    #[cfg(not(windows))]
    {
        let _ = (&x, &y, &button, &frame, &site);
        Err("click_at is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub async fn type_text(text: String, wpm: f64) -> Result<(), String> {
    #[cfg(windows)]
    return crate::run_blocking(move || win::type_text(&text, wpm)).await;
    #[cfg(not(windows))]
    {
        let _ = (&text, &wpm);
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
pub async fn stop_recording() -> Result<RecordingInfo, String> {
    #[cfg(windows)]
    return crate::run_blocking(win::stop_recording).await;
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

#[tauri::command]
pub fn delete_recording(id: String) -> Result<(), String> {
    #[cfg(windows)]
    return win::delete_recording(&id);
    #[cfg(not(windows))]
    {
        let _ = &id;
        Err("recording is only supported on Windows".to_string())
    }
}
