//! Screenshots (Windows): GDI BitBlt of the app window's screen region,
//! encoded to PNG and returned as a data URL for the Firebase channel.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn screenshot(window: tauri::Window) -> Result<Screenshot, String> {
    #[cfg(windows)]
    return win::screenshot(&window);
    #[cfg(not(windows))]
    {
        let _ = &window;
        Err("screenshot is only supported on Windows".to_string())
    }
}

#[cfg(windows)]
mod win {
    use super::Screenshot;
    use image::ImageEncoder;
    use windows_sys::Win32::Graphics::Gdi::*;

    pub fn screenshot(window: &tauri::Window) -> Result<Screenshot, String> {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let (x, y) = (pos.x, pos.y);
        let (w, h) = (size.width, size.height);
        if w == 0 || h == 0 {
            return Err("window has zero size".to_string());
        }

        unsafe {
            let screen_dc = GetDC(0);
            if screen_dc == 0 {
                return Err("GetDC failed".to_string());
            }
            let mem_dc = CreateCompatibleDC(screen_dc);
            if mem_dc == 0 {
                ReleaseDC(0, screen_dc);
                return Err("CreateCompatibleDC failed".to_string());
            }
            let bmp = CreateCompatibleBitmap(screen_dc, w as i32, h as i32);
            if bmp == 0 {
                DeleteDC(mem_dc);
                ReleaseDC(0, screen_dc);
                return Err("CreateCompatibleBitmap failed".to_string());
            }
            let old = SelectObject(mem_dc, bmp);
            let blt_ok = BitBlt(
                mem_dc,
                0,
                0,
                w as i32,
                h as i32,
                screen_dc,
                x,
                y,
                SRCCOPY,
            );
            SelectObject(mem_dc, old);
            ReleaseDC(0, screen_dc);
            if blt_ok == 0 {
                DeleteObject(bmp);
                DeleteDC(mem_dc);
                return Err("BitBlt failed".to_string());
            }

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    biHeight: -(h as i32), // top-down DIB
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [RGBQUAD {
                    rgbBlue: 0,
                    rgbGreen: 0,
                    rgbRed: 0,
                    rgbReserved: 0,
                }],
            };
            let mut bgra = vec![0u8; w as usize * h as usize * 4];
            let lines = GetDIBits(
                mem_dc,
                bmp,
                0,
                h,
                bgra.as_mut_ptr() as *mut std::ffi::c_void,
                &mut bmi,
                DIB_RGB_COLORS,
            );
            DeleteObject(bmp);
            DeleteDC(mem_dc);
            if lines == 0 {
                return Err("GetDIBits failed".to_string());
            }

            let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
            for px in bgra.chunks_exact(4) {
                rgb.push(px[2]);
                rgb.push(px[1]);
                rgb.push(px[0]);
            }
            let img = image::RgbImage::from_raw(w, h, rgb)
                .ok_or_else(|| "failed to build image buffer".to_string())?;
            let mut png = Vec::new();
            PngEncoder::new(&mut png)
                .write_image(&img, w, h, image::ExtendedColorType::Rgb8)
                .map_err(|e| e.to_string())?;

            use base64::Engine as _;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
            Ok(Screenshot {
                data_url: format!("data:image/png;base64,{}", b64),
                width: w,
                height: h,
            })
        }
    }
}
