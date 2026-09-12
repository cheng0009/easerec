//! DirectorCam on-screen overlay — dead simple.
//! Color-key transparency: magenta = invisible, everything else = visible.
//! Freezes frame, draws effects via GDI, done.

use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};

use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, ShowWindow, SW_SHOW, SW_HIDE,
    SM_CXSCREEN, SM_CYSCREEN, GetSystemMetrics,
    WS_EX_LAYERED, WS_EX_TOPMOST, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
    CreateWindowExW, WS_POPUP, SetWindowPos,
    SWP_NOZORDER, SWP_NOACTIVATE,
    UpdateLayeredWindow, ULW_ALPHA,
    RegisterClassExW, WNDCLASSEXW, DefWindowProcW,
};
use windows::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BLENDFUNCTION, HBRUSH};
use windows::Win32::Foundation::{HWND, POINT, SIZE, COLORREF, GetLastError, ERROR_CLASS_ALREADY_EXISTS, WPARAM, LPARAM, LRESULT, HINSTANCE};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;

use crate::overlay::window::OverlayState;
use crate::overlay::effects::cursor::CursorSmoother;

type HGDIOBJ = *mut std::ffi::c_void;
type BOOL = i32;

extern "system" {
    fn CreateCompatibleDC(hdc: HGDIOBJ) -> HGDIOBJ;
    fn DeleteDC(hdc: HGDIOBJ) -> BOOL;
    fn CreateDIBSection(hdc: HGDIOBJ, pbmi: *const BITMAPINFOHEADER, usage: u32,
        ppvBits: *mut *mut u8, hSection: HGDIOBJ, offset: u32) -> HGDIOBJ;
    fn SelectObject(hdc: HGDIOBJ, h: HGDIOBJ) -> HGDIOBJ;
    fn DeleteObject(h: HGDIOBJ) -> BOOL;
    fn StretchBlt(hdcDst: HGDIOBJ, xDst: i32, yDst: i32, wDst: i32, hDst: i32,
        hdcSrc: HGDIOBJ, xSrc: i32, ySrc: i32, wSrc: i32, hSrc: i32, rop: u32) -> BOOL;
    fn CreateSolidBrush(color: COLORREF) -> HGDIOBJ;
    fn Ellipse(hdc: HGDIOBJ, left: i32, top: i32, right: i32, bottom: i32) -> BOOL;
    fn CreatePen(style: i32, width: i32, color: COLORREF) -> HGDIOBJ;
    fn MoveToEx(hdc: HGDIOBJ, x: i32, y: i32, pt: *mut POINT) -> BOOL;
    fn LineTo(hdc: HGDIOBJ, x: i32, y: i32) -> BOOL;
    fn SetBkMode(hdc: HGDIOBJ, mode: i32) -> i32;
    fn SetTextColor(hdc: HGDIOBJ, color: COLORREF) -> COLORREF;
    fn TextOutW(hdc: HGDIOBJ, x: i32, y: i32, text: *const u16, len: i32) -> BOOL;
    fn GetDC(hwnd: HGDIOBJ) -> HGDIOBJ;
    fn ReleaseDC(hwnd: HGDIOBJ, hdc: HGDIOBJ) -> i32;
    fn GetStockObject(index: i32) -> HGDIOBJ;
    fn BitBlt(hdcDst: HGDIOBJ, x: i32, y: i32, w: i32, h: i32, hdcSrc: HGDIOBJ, sx: i32, sy: i32, rop: u32) -> BOOL;
    fn CreateFontW(h: i32, w: i32, escapement: i32, orientation: i32, weight: i32, italic: u32, underline: u32, strikeout: u32, charset: u32, outputprecision: u32, clipprecision: u32, quality: u32, pitchandfamily: u32, facename: *const u16) -> HGDIOBJ;
    fn CreateEllipticRgn(left: i32, top: i32, right: i32, bottom: i32) -> HGDIOBJ;
    fn SelectClipRgn(hdc: HGDIOBJ, hrgn: HGDIOBJ) -> i32;
    fn Rectangle(hdc: HGDIOBJ, left: i32, top: i32, right: i32, bottom: i32) -> BOOL;
    fn GetAsyncKeyState(vKey: i32) -> i16;
    fn SetWindowDisplayAffinity(hwnd: HGDIOBJ, affinity: u32) -> BOOL;
}


const SRCCOPY: u32 = 0x00CC0020;
const DIB_RGB_COLORS: u32 = 0;
const NULL_BRUSH: i32 = 5;
// Windows 10 2004+: the overlay never appears in screen captures (GDI BitBlt,
// DXGI duplication), so the magnifier can sample a bright clean desktop and the
// effect artwork is re-applied by the video compositor instead of being baked in.
const WDA_EXCLUDEFROMPRIMARY: u32 = 0x00000011;

fn make_cr(r: u8, g: u8, b: u8) -> COLORREF { COLORREF(r as u32 | (g as u32) << 8 | (b as u32) << 16) }

unsafe extern "system" fn ovl_wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wp, lp)
}

fn create_raw_window(w: i32, h: i32) -> Option<isize> {
    use std::mem;

    let class_name = windows::core::w!("DC_OVL_V4");
    let hinst = match unsafe { GetModuleHandleW(None) } {
        Ok(h) => HINSTANCE(h.0), Err(_) => return None,
    };

    unsafe {
        let wc = WNDCLASSEXW {
            cbSize: mem::size_of::<WNDCLASSEXW>() as u32,
            style: windows::Win32::UI::WindowsAndMessaging::WNDCLASS_STYLES(0),
            lpfnWndProc: Some(ovl_wndproc),
            hInstance: hinst,
            hbrBackground: HBRUSH::default(),
            lpszClassName: class_name,
            ..Default::default()
        };
        let atom = RegisterClassExW(&wc);
        if atom == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
            log::error!("[OVL] RegisterClassExW failed");
            return None;
        }
    }

    match unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
            class_name, windows::core::w!(""),
            WS_POPUP, 0, 0, w, h,
            None, None, Some(hinst), None,
        )
    } {
        Ok(hw) => {
            // Using UpdateLayeredWindow with per-pixel alpha ? no color key needed
            Some(hw.0 as isize)
        }
        Err(e) => { log::error!("[OVL] CreateWindowExW: {:?}", e); None }
    }
}

pub struct D2DOverlay {
    sw: i32, sh: i32,
    hwnd: HWND,
    running: Arc<AtomicBool>,
    state: Arc<Mutex<OverlayState>>,
    thread: Option<std::thread::JoinHandle<()>>,
    webcam_frame_src: Option<Arc<Mutex<Option<(Vec<u8>, u32, u32)>>>>,
    overlay_sink: Option<Arc<Mutex<crate::overlay::OverlayManager>>>,
}

unsafe impl Send for D2DOverlay {}
unsafe impl Sync for D2DOverlay {}

impl D2DOverlay {
    pub fn new() -> Self {
        Self {
            sw: unsafe { GetSystemMetrics(SM_CXSCREEN) },
            sh: unsafe { GetSystemMetrics(SM_CYSCREEN) },
            hwnd: HWND::default(),
            running: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(OverlayState::default())),
            thread: None,
            webcam_frame_src: None,
            overlay_sink: None,
        }
    }

    pub fn state_ref(&self) -> Arc<Mutex<OverlayState>> { self.state.clone() }
    pub fn update_dimensions(&mut self, w: i32, h: i32) { self.sw = w; self.sh = h; }

    /// Handles to the shared OverlayManager, used to mirror strokes drawn on the
    /// overlay into the video-compositor command stream and to track the cursor.
    pub fn set_overlay_sink(&mut self, sink: Arc<Mutex<crate::overlay::OverlayManager>>) {
        self.overlay_sink = Some(sink);
    }

    pub fn set_webcam_source(&mut self, src: Arc<Mutex<Option<(Vec<u8>, u32, u32)>>>) {
        self.webcam_frame_src = Some(src);
    }

    pub fn set_hwnd(&self, _h: HWND) {}

    pub fn init(&mut self) -> bool {
        // Defer window creation to show() when we have real capture dimensions.
        // GetSystemMetrics may return DPI-virtualized coords (e.g. 1920x1080 on 4K).
        log::info!("[OVL] init deferred (will create window at capture resolution)");
        true
    }

    pub fn show(&mut self) {
        if self.running.load(Ordering::SeqCst) { return; }
        // Create window lazily with real capture dimensions (not DPI-virtualized)
        if self.hwnd.0.is_null() {
            let sw = self.sw; let sh = self.sh;
            let raw = match create_raw_window(sw, sh) {
                Some(r) => r, None => { log::error!("[OVL] failed to create window {}x{}", sw, sh); return; }
            };
            self.hwnd = HWND(raw as *mut _);
            log::info!("[OVL] window created at {}x{} (capture resolution)", sw, sh);
        }
        self.running.store(true, Ordering::SeqCst);
        let hwnd = self.hwnd;
        let sw = self.sw; let sh = self.sh;
        log::info!("[OVL] show {}x{} hwnd={:?}", sw, sh, hwnd);
        // Force window to exact full-screen size and position, show once
        unsafe {
            let _ = SetWindowPos(hwnd, None, 0, 0, sw, sh, SWP_NOACTIVATE | SWP_NOZORDER);
            // Defer ShowWindow to render_loop after first frame is drawn
        }
        let sref = self.state.clone();
        let run = self.running.clone();
        let hwnd_raw = hwnd.0 as isize;
        let wc_src = self.webcam_frame_src.clone();
        let ov_sink = self.overlay_sink.clone();
        self.thread = Some(std::thread::spawn(move || {
            let hwnd = HWND(hwnd_raw as *mut _);
            render_loop(&sref, &run, hwnd, sw, sh, wc_src, ov_sink);
        }));
    }

    pub fn hide(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(t) = self.thread.take() { let _ = t.join(); }
        unsafe { let _ = ShowWindow(self.hwnd, SW_HIDE); }
    }
}

fn render_loop(state: &Arc<Mutex<OverlayState>>, running: &Arc<AtomicBool>, hwnd: HWND, sw: i32, sh: i32, wc_src: Option<Arc<Mutex<Option<(Vec<u8>, u32, u32)>>>>, overlay_sink: Option<Arc<Mutex<crate::overlay::OverlayManager>>>) {
    // Full-resolution DIB ? 1:1 with screen, no coordinate scaling needed.
    let dw = sw; let dh = sh;

    let (dc, _dib, bits, _) = unsafe {
        let sc = GetDC(std::ptr::null_mut());
        let dc = CreateCompatibleDC(sc);
        ReleaseDC(std::ptr::null_mut(), sc);
        let bi = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: dw, biHeight: -dh, biPlanes: 1, biBitCount: 32,
            biCompression: 0, biSizeImage: 0,
            biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
        };
        let mut b: *mut u8 = std::ptr::null_mut();
        let dib = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &mut b, std::ptr::null_mut(), 0);
        SelectObject(dc, dib);
        (dc, dib, b, (dw * dh * 4) as usize)
    };

    // Request that the OS never include this overlay in screen captures. When it
    // works, the lens source below is always a clean, bright desktop capture and
    // there is no hide/flicker cycle. Falls back to hide-around-capture otherwise.
    let affinity_ok = unsafe { SetWindowDisplayAffinity(hwnd.0, WDA_EXCLUDEFROMPRIMARY) != 0 };
    log::info!("[OVL] WDA_EXCLUDEFROMPRIMARY {}",
        if affinity_ok { "set (clean lens source)" } else { "unavailable — using hide-around-capture fallback" });
    // Source DIB - refreshed periodically while the overlay window is hidden so
    // the lens pixels come from a CLEAN desktop capture (bright, never includes
    // our own overlay artwork; avoids the hall-of-mirrors freeze problem).
    let mut src_dc: Option<isize> = None;
    let mut src_dib: Option<isize> = None;
    let mut src_w: i32 = 0;
    let mut src_h: i32 = 0;
    // Refresh cadence: keep the lens content roughly in sync with the cursor.
    const MAG_REFRESH_MS: u64 = 300;
    // On the fallback path we must wait out at least one compositor vblank (~16ms
    // at 60Hz) after hiding, otherwise the capture still contains our overlay.
    const MAG_HIDE_MS: u64 = 40;
    let mut last_src_refresh = std::time::Instant::now() - std::time::Duration::from_secs(10);

    let mut last_cx = -1000i32;
    let mut last_cy = -1000i32;
    log::info!("[OVL] render {}x{} (full-res)", sw, sh);
    // Diagnostic: dump initial overlay state before render loop
    { let st_init = state.lock().unwrap(); log::info!("[OVL] init-state: magnifier={} frame_w={} frame_h={} markers={} strokes={}", st_init.magnifier_enabled, st_init.frame_w, st_init.frame_h, st_init.step_markers.len(), st_init.highlighter_strokes.len()); }
    let mut frame_count: u64 = 0;

    // --- Highlighter interactive drawing state (uses GetAsyncKeyState for mouse polling) ---
    let mut hl_drawing: bool = false;
    let mut hl_current: Vec<(f32, f32)> = vec![];
    const VK_LBUTTON: i32 = 0x01;
    let mut sm_was_pressed: bool = false;  // step_marker click debounce
    let mut ripple_btn_down: bool = false;

    // --- Cursor trajectory smoothing (Catmull-Rom spline) ---
    let mut cursor_smoother = CursorSmoother::new();
    cursor_smoother.enabled = true;
    loop {
        if !running.load(Ordering::SeqCst) { break; }
        let st = match state.lock() { Ok(s) => s.clone(), Err(_) => break };
        if !st.privacy_paused && !st.magnifier_enabled && !st.step_marker_active && !st.highlighter_active && st.step_markers.is_empty() && st.highlighter_strokes.is_empty() {
            unsafe { let _ = ShowWindow(hwnd, SW_HIDE); }
            std::thread::sleep(std::time::Duration::from_millis(100));
            continue;
        }

        let mut pt = POINT { x: 0, y: 0 };
        unsafe { let _ = GetCursorPos(&mut pt); }
        let (raw_cx, raw_cy) = (pt.x, pt.y);
        cursor_smoother.push(raw_cx as f32, raw_cy as f32);
        let smooth = cursor_smoother.smooth_position().unwrap_or((raw_cx as f32, raw_cy as f32));
        let cx = smooth.0 as i32; let cy = smooth.1 as i32;  // smoothed for display effects
        if (cx - last_cx).abs() <= 2 && (cy - last_cy).abs() <= 2 && !st.frame_data.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(16)); continue;
        }
        last_cx = cx; last_cy = cy;


        // --- Step marker click-to-add ---
        if st.step_marker_active && !st.highlighter_active {
            let lbtn = unsafe { GetAsyncKeyState(VK_LBUTTON) as u32 & 0x8000 != 0 };
            let nx = pt.x as f32 / sw as f32;
            let ny = pt.y as f32 / sh as f32;
            if lbtn && !sm_was_pressed {
                if let Ok(mut ost) = state.lock() {
                    let idx = ost.step_markers.len() as u32 + 1;
                    ost.step_markers.push((idx, nx, ny));
                }
            }
            sm_was_pressed = lbtn;
        } else if !st.step_marker_active {
            sm_was_pressed = false;

        // --- Ripple click-to-add ---
        {
            let lbtn = unsafe { GetAsyncKeyState(VK_LBUTTON) as u32 & 0x8000 != 0 };
            let was_down = ripple_btn_down;
            ripple_btn_down = lbtn;
            if lbtn && !was_down {
                let nx = pt.x as f32 / sw as f32;
                let ny = pt.y as f32 / sh as f32;
                if let Ok(mut ost) = state.lock() {
                    ost.ripples.push((nx, ny, 0.02, 0.6));
                }
            }
            // Animate existing ripples: grow radius, fade alpha, remove expired
            if let Ok(mut ost) = state.lock() {
                let new_rips: Vec<(f32, f32, f32, f32)> = ost.ripples.iter()
                    .map(|&(x, y, r, a)| (x, y, r + 0.006, a - 0.025))
                    .filter(|(_,_,_,a)| *a > 0.01)
                    .collect();
                ost.ripples = new_rips;
            }
        }
        }
        // --- Highlighter interactive drawing (polls left mouse button globally) ---
        if st.highlighter_active {
            let lbtn = unsafe { GetAsyncKeyState(VK_LBUTTON) as u32 & 0x8000 != 0 };
            let nx = pt.x as f32 / sw as f32;
            let ny = pt.y as f32 / sh as f32;
            if lbtn && !hl_drawing {
                hl_drawing = true;
                hl_current = vec![(nx, ny)];
                if let Some(os) = &overlay_sink {
                    if let Ok(ov) = os.lock() { ov.highlighter_start(nx, ny); }
                }
            } else if lbtn && hl_drawing {
                if hl_current.last().map(|&(px, py)| (px - nx).abs() > 0.001 || (py - ny).abs() > 0.001).unwrap_or(true) {
                    hl_current.push((nx, ny));
                    if let Some(os) = &overlay_sink {
                        if let Ok(ov) = os.lock() { ov.highlighter_move(nx, ny); }
                    }
                }
            } else if !lbtn && hl_drawing {
                hl_drawing = false;
                if hl_current.len() > 1 {
                    if let Ok(mut ost) = state.lock() {
                        ost.highlighter_strokes.push(hl_current.clone());
                    }
                }
                if let Some(os) = &overlay_sink {
                    if let Ok(ov) = os.lock() { ov.highlighter_end(); }
                }
                hl_current = vec![];
            }
        }

        // --- Fill with alpha=1 everywhere (catches clicks, visually transparent) ---
        unsafe {
            // Zero RGB, set alpha=1. Two-pass: zero all, then set every 4th byte.
            std::ptr::write_bytes(bits, 0, dw as usize * dh as usize * 4);
            let total = dw as usize * dh as usize;
            // Alpha=0 means click-through; magnifier circle sets alpha=255 inside
        }

        // --- Magnifier ---
        if st.magnifier_enabled {
            // Track cursor into the shared manager so the recorded video lens
            // follows the mouse as well.
            if let Some(os) = &overlay_sink {
                if let Ok(ov) = os.lock() { ov.track_cursor(sw, sh); }
            }

            let capw = if st.frame_w > 0 { st.frame_w as i32 } else { sw };
            let caph = if st.frame_h > 0 { st.frame_h as i32 } else { sh };
            if frame_count == 0 {
                log::info!("[OVL] magnifier: enabled=true fw={} fh={} cx={:.3} cy={:.3} zoom={} mr={} fallback={}",
                    capw, caph, st.magnifier_cx, st.magnifier_cy, st.magnifier_zoom,
                    ((sw.min(sh)) as f32 * 0.15) as i32, st.frame_w == 0);
            }
            let zoom = match st.magnifier_zoom { 1=>1.5, 2=>2.5, 3=>4.0, _=>1.5 };
            // Magnifier circle radius: ~15% of smaller screen dimension.
            let mr = ((sw.min(sh)) as f32 * 0.15) as i32;
            // Source region half-size (screen pixels sampled, shrunk by zoom).
            let sr = (mr as f32 / zoom) as i32;

            // Re-capture the lens source periodically so lens content is bright, current,
            // and tracks the cursor (never a frozen-forced dark frame).
            let now = std::time::Instant::now();
            if capw > 0 && caph > 0 && (src_dc.is_none()
                || now.duration_since(last_src_refresh) >= std::time::Duration::from_millis(MAG_REFRESH_MS)) {
                // With the affinity flag the overlay is invisible to captures, so
                // we can sample the desktop directly. Fallback: hide the window
                // for a couple of vsyncs first so the capture is clean.
                let first = src_dc.is_none();
                unsafe {
                    if !affinity_ok {
                        let _ = ShowWindow(hwnd, SW_HIDE);
                        std::thread::sleep(std::time::Duration::from_millis(MAG_HIDE_MS));
                    }
                    // Drop the old source: delete the DC first (releases the
                    // selected DIB), then the DIB object — avoids leaking GDI
                    // handles every refresh.
                    if let Some(d) = src_dc { let _ = DeleteDC(d as HGDIOBJ); }
                    if let Some(d) = src_dib { let _ = DeleteObject(d as HGDIOBJ); }
                    let sc = GetDC(std::ptr::null_mut());
                    let sdc = CreateCompatibleDC(sc);
                    let bi = BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: capw, biHeight: -caph, biPlanes: 1, biBitCount: 32,
                        biCompression: 0, biSizeImage: 0,
                        biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
                    };
                    let mut bp: *mut u8 = std::ptr::null_mut();
                    let sdi = CreateDIBSection(sdc, &bi, DIB_RGB_COLORS, &mut bp, std::ptr::null_mut(), 0);
                    SelectObject(sdc, sdi);
                    // Clean desktop content — our overlay is excluded from the capture
                    BitBlt(sdc, 0, 0, capw, caph, sc, 0, 0, SRCCOPY);
                    ReleaseDC(std::ptr::null_mut(), sc);
                    if !affinity_ok { let _ = ShowWindow(hwnd, SW_SHOW); }
                    src_dc = Some(sdc as isize);
                    src_dib = Some(sdi as isize);
                    src_w = capw; src_h = caph;
                    if first {
                        log::info!("[OVL] src DIB refreshed {}x{} (frame_count={})", capw, caph, frame_count);
                    }
                }
                last_src_refresh = now;
            }

            if let Some(sdc) = src_dc {
                let r2 = mr*mr;
                unsafe {
                    // Step 1: light dim overlay outside the lens circle
                    for py in 0..dh {
                        let dy2 = py - cy; let row = bits.add((py*dw*4) as usize);
                        for px in 0..dw {
                            let dx2 = px - cx; let o = (px*4) as usize;
                            if dx2*dx2 + dy2*dy2 > r2 {
                                *row.add(o) = 16; *row.add(o+1)=16; *row.add(o+2)=16; *row.add(o+3)=100;
                            }
                        }
                    }

                    // Step 2: StretchBlt magnified content, clipped to circle
                    let (sw_, sh_) = (src_w.max(1), src_h.max(1));
                    let sx0 = (cx - sr).max(0); let sy0 = (cy - sr).max(0);
                    let ss = (sr*2).min(sw_-sx0).min(sh_-sy0);
                    let dx = cx - mr; let dy = cy - mr; let ds = mr*2;
                    // Create elliptical clip region to restrict StretchBlt to circle only
                    let clip = CreateEllipticRgn(dx, dy, dx + ds, dy + ds);
                    SelectClipRgn(dc, clip);
                    StretchBlt(dc, dx, dy, ds, ds, sdc as _, sx0, sy0, ss, ss, SRCCOPY);
                    SelectClipRgn(dc, std::ptr::null_mut()); // restore no-clip
                    DeleteObject(clip);

                    // Fix alpha inside circle: GDI StretchBlt doesn't write alpha.
                    // Without this, magnified content is nearly invisible (alpha=1).
                    for py in (cy - mr).max(0)..(cy + mr).min(dh) {
                        let dy2 = py - cy;
                        let row = bits.add((py * dw * 4) as usize);
                        for px in (cx - mr).max(0)..(cx + mr).min(dw) {
                            let dx2 = px - cx;
                            if (dx2 as i64) * (dx2 as i64) + (dy2 as i64) * (dy2 as i64) <= (r2 as i64) {
                                *row.add((px * 4 + 3) as usize) = 255;
                            }
                        }
                    }
                }
            }
        }

        // --- Step markers (coords stored as 0..1 normalized) ---
        for (n, mx, my) in &st.step_markers {
            let px = (*mx * sw as f32) as i32; let py = (*my * sh as f32) as i32;
            unsafe {
                let red = CreateSolidBrush(make_cr(220, 40, 40));
                let old_br = SelectObject(dc, red);
                let pen = CreatePen(0, 3, make_cr(255, 255, 255));
                let old_pen = SelectObject(dc, pen);
                Ellipse(dc, px-56, py-56, px+56, py+56);
                SelectObject(dc, old_pen); DeleteObject(pen);
                SelectObject(dc, old_br); DeleteObject(red);
                let font_name: Vec<u16> = "Segoe UI ".encode_utf16().collect();
                let font = CreateFontW(64, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 4, 0, font_name.as_ptr());
                let old_font = SelectObject(dc, font);
                SetBkMode(dc, 1); SetTextColor(dc, make_cr(255, 255, 255));
                let ts: Vec<u16> = format!("{}", n).encode_utf16().collect();
                TextOutW(dc, px-20, py-34, ts.as_ptr(), ts.len() as i32);
                SelectObject(dc, old_font); DeleteObject(font);
                // Fix alpha in marker region: GDI doesn't write alpha
                let r2 = 56i32*56;
                for dy in -56..=56 {
                    let y = py + dy; if y < 0 || y >= dh { continue; }
                    let row = bits.add((y * dw * 4) as usize);
                    for dx in -56..=56 {
                        if dx*dx + dy*dy > r2 { continue; }
                        let x = px + dx; if x < 0 || x >= dw { continue; }
                        let o = (x * 4) as usize;
                        if *row.add(o) != 0 || *row.add(o+1) != 0 || *row.add(o+2) != 0 {
                            *row.add(o+3) = 255;
                        }
                    }
                }
            }
        }



        // --- Highlighter cursor indicator (simple crosshair via pixels, no GDI) ---
        if st.highlighter_active {
            unsafe {
                let r: u8 = 255; let g: u8 = 100; let b: u8 = 0;
                // Draw a 5x5 cross at cursor position (no GDI, pure pixel write)
                for py in (cy-2).max(0)..(cy+3).min(dh) {
                    let row = bits.add((py * dw * 4) as usize);
                    for px in (cx-2).max(0)..(cx+3).min(dw) {
                        let o = (px * 4) as usize;
                        if (px - cx).abs() <= 1 || (py - cy).abs() <= 1 {
                            *row.add(o) = b; *row.add(o+1) = g; *row.add(o+2) = r; *row.add(o+3) = 255;
                        }
                    }
                }
            }
        }
        // --- Current highlighter stroke being drawn (real-time preview) ---
        if hl_drawing && hl_current.len() >= 2 {
            unsafe {
                let pen = CreatePen(0, 6, make_cr(255, 100, 0)); let old = SelectObject(dc, pen);
                MoveToEx(dc, (hl_current[0].0 * sw as f32) as i32, (hl_current[0].1 * sh as f32) as i32, std::ptr::null_mut());
                for pt in &hl_current[1..] { LineTo(dc, (pt.0 * sw as f32) as i32, (pt.1 * sh as f32) as i32); }
                SelectObject(dc, old); DeleteObject(pen);
            }
            // Fix alpha for current stroke pixels
            let pad = 6i32;
            let (mut min_x, mut min_y, mut max_x, mut max_y) = (dw, dh, 0i32, 0i32);
            for pt in &hl_current {
                let x = (pt.0 * sw as f32) as i32; let y = (pt.1 * sh as f32) as i32;
                min_x = min_x.min(x); min_y = min_y.min(y);
                max_x = max_x.max(x); max_y = max_y.max(y);
            }
            min_x = (min_x - pad).max(0); min_y = (min_y - pad).max(0);
            max_x = (max_x + pad).min(dw-1); max_y = (max_y + pad).min(dh-1);
            unsafe {
                for py in min_y..=max_y {
                    let row = bits.add((py * dw * 4) as usize);
                    for px in min_x..=max_x {
                        let o = (px * 4) as usize;
                        if *row.add(o) != 0 || *row.add(o+1) != 0 || *row.add(o+2) != 0 {
                            *row.add(o+3) = 255;
                        }
                    }
                }
            }
        }

        // --- Highlighter (coords stored as 0..1 normalized) ---
        for stroke in &st.highlighter_strokes {
            if stroke.len()<2 { continue; }
            unsafe {
                let pen = CreatePen(0, 6, make_cr(255, 100, 0)); let old = SelectObject(dc, pen);
                MoveToEx(dc, (stroke[0].0 * sw as f32) as i32, (stroke[0].1 * sh as f32) as i32, std::ptr::null_mut());
                for pt in &stroke[1..] { LineTo(dc, (pt.0 * sw as f32) as i32, (pt.1 * sh as f32) as i32); }
                SelectObject(dc, old); DeleteObject(pen);
            }
            // Fix alpha: GDI doesn't write alpha. Compute stroke bounding box and set alpha=255.
            let pad = 6i32; // pen width + some margin
            let (mut min_x, mut min_y, mut max_x, mut max_y) = (dw, dh, 0i32, 0i32);
            for pt in stroke {
                let x = (pt.0 * sw as f32) as i32; let y = (pt.1 * sh as f32) as i32;
                min_x = min_x.min(x); min_y = min_y.min(y);
                max_x = max_x.max(x); max_y = max_y.max(y);
            }
            min_x = (min_x - pad).max(0); min_y = (min_y - pad).max(0);
            max_x = (max_x + pad).min(dw-1); max_y = (max_y + pad).min(dh-1);
            unsafe {
                for py in min_y..=max_y {
                    let row = bits.add((py * dw * 4) as usize);
                    for px in min_x..=max_x {
                        let o = (px * 4) as usize;
                        if *row.add(o) != 0 || *row.add(o+1) != 0 || *row.add(o+2) != 0 {
                            *row.add(o+3) = 255;
                        }
                    }
                }
            }
        }


        // --- Privacy Adjust phase: show rewind offset and instructions ---
        if st.privacy_paused {
            // Dark overlay
            for i in 0..(dw as usize * dh as usize) {
                let o = i * 4;
                unsafe {
                    if *bits.add(o+3) < 20 {
                        *bits.add(o) = 20; *bits.add(o+1) = 20; *bits.add(o+2) = 20; *bits.add(o+3) = 180;
                    }
                }
            }
            // Center instructions
            let offset = st.privacy_rewind_offset;
            let msg: String = format!("\u{25C0}\u{25B6} \u{9000}\u{56DE} {}s | Alt+P \u{786E}\u{8BA4}", offset as i32);
            let txt: Vec<u16> = msg.encode_utf16().collect();
            unsafe {
                let font_name: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
                let font = CreateFontW(48, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 4, 0, font_name.as_ptr());
                let old_font = SelectObject(dc, font);
                SetBkMode(dc, 1); SetTextColor(dc, make_cr(255, 255, 255));
                let tx = (dw - txt.len() as i32 * 30) / 2;
                TextOutW(dc, tx.max(40), dh/2 - 30, txt.as_ptr(), txt.len() as i32);
                SelectObject(dc, old_font); DeleteObject(font);
                // Fix alpha
                for py in (dh/2-50).max(0)..(dh/2+50).min(dh) {
                    let row = bits.add((py * dw * 4) as usize);
                    for px in 0..dw {
                        let o = (px * 4) as usize;
                        if *row.add(o) != 0 || *row.add(o+1) != 0 || *row.add(o+2) != 0 {
                            *row.add(o+3) = 255;
                        }
                    }
                }
            }
        }

        // --- Mosaic rectangles (during privacy pause) ---
        // Draw completed regions
        for &(x1, y1, x2, y2) in &st.mosaic_regions {
            if x1 < 0.0 { continue; }
            let px1 = (x1 * sw as f32) as i32; let py1 = (y1 * sh as f32) as i32;
            let px2 = (x2 * sw as f32) as i32; let py2 = (y2 * sh as f32) as i32;
            unsafe {
                // Red semi-transparent fill
                for yy in py1..py2 {
                    if yy < 0 || yy >= dh { continue; }
                    let row = bits.add((yy * dw * 4) as usize);
                    for xx in px1..px2 {
                        if xx < 0 || xx >= dw { continue; }
                        let o = (xx * 4) as usize;
                        *row.add(o) = 40; *row.add(o+1) = 40; *row.add(o+2) = 220; *row.add(o+3) = 100;
                    }
                }
                // Red border
                let pen = CreatePen(0, 3, make_cr(220, 40, 40));
                let old_pen = SelectObject(dc, pen);
                let null_br = SelectObject(dc, GetStockObject(NULL_BRUSH));
                // Use rectangle drawing via LineTo
                MoveToEx(dc, px1, py1, std::ptr::null_mut());
                LineTo(dc, px2, py1);
                LineTo(dc, px2, py2);
                LineTo(dc, px1, py2);
                LineTo(dc, px1, py1);
                SelectObject(dc, old_pen); DeleteObject(pen);
                SelectObject(dc, null_br);
            }
        }
        // Draw drag preview
        if let Some((x1, y1, x2, y2)) = st.mosaic_drag_preview {
            let px1 = (x1 * sw as f32) as i32; let py1 = (y1 * sh as f32) as i32;
            let px2 = (x2 * sw as f32) as i32; let py2 = (y2 * sh as f32) as i32;
            unsafe {
                for yy in py1..py2 {
                    if yy < 0 || yy >= dh { continue; }
                    let row = bits.add((yy * dw * 4) as usize);
                    for xx in px1..px2 {
                        if xx < 0 || xx >= dw { continue; }
                        let o = (xx * 4) as usize;
                        *row.add(o) = 40; *row.add(o+1) = 40; *row.add(o+2) = 220; *row.add(o+3) = 80;
                    }
                }
                let pen = CreatePen(0, 2, make_cr(255, 100, 100));
                let old_pen = SelectObject(dc, pen);
                MoveToEx(dc, px1, py1, std::ptr::null_mut());
                LineTo(dc, px2, py1);
                LineTo(dc, px2, py2);
                LineTo(dc, px1, py2);
                LineTo(dc, px1, py1);
                SelectObject(dc, old_pen); DeleteObject(pen);
            }
        }


        // --- Webcam overlay (picture-in-picture) ---
        // Read latest webcam frame from shared source
        if let Some(ref src) = wc_src {
            if let Ok(lf) = src.lock() {
                if let Some((ref wc_data, wc_raw_w, wc_raw_h)) = *lf {
                    if st.webcam_enabled && wc_raw_w > 0 && wc_raw_h > 0 {
                        let wc_w = (sw as f32 * st.webcam_size_ratio) as i32;
                        let wc_h = (wc_w as f32 * wc_raw_h as f32 / wc_raw_w as f32) as i32;
                        let margin = 20i32;
                        let (wc_x, wc_y) = match st.webcam_position.as_str() {
                            "bottom_right" => (sw - wc_w - margin, sh - wc_h - margin),
                            "bottom_left" => (margin, sh - wc_h - margin),
                            "top_right" => (sw - wc_w - margin, margin),
                            "top_left" => (margin, margin),
                            _ => ((st.webcam_custom_x * sw as f32) as i32, (st.webcam_custom_y * sh as f32) as i32),
                        };
                        // Simple nearest-neighbor scale from raw webcam to target rect
                        unsafe {
                            for py in 0..wc_h {
                                let sy = (py as f32 * wc_raw_h as f32 / wc_h as f32) as u32;
                                let src_row = wc_data.as_ptr().add((sy * wc_raw_w * 4) as usize);
                                let dy = wc_y + py;
                                if dy < 0 || dy >= sh { continue; }
                                let dst_row = bits.add((dy * sw * 4) as usize);
                                for px in 0..wc_w {
                                    let sx = (px as f32 * wc_raw_w as f32 / wc_w as f32) as u32;
                                    let dx = wc_x + px;
                                    if dx < 0 || dx >= sw { continue; }
                                    let src_o = (sx * 4) as usize;
                                    let dst_o = (dx * 4) as usize;
                                    *dst_row.add(dst_o) = *src_row.add(src_o);
                                    *dst_row.add(dst_o + 1) = *src_row.add(src_o + 1);
                                    *dst_row.add(dst_o + 2) = *src_row.add(src_o + 2);
                                    *dst_row.add(dst_o + 3) = 255;
                                }
                            }
                            // Draw border
                            let (br, bg, bb, ba) = st.webcam_border_color;
                            let pen = CreatePen(0, st.webcam_border_width as i32, make_cr((br*255.0) as u8, (bg*255.0) as u8, (bb*255.0) as u8));
                            let old = SelectObject(dc, pen);
                            let null_br = SelectObject(dc, GetStockObject(NULL_BRUSH));
                            Rectangle(dc, wc_x, wc_y, wc_x + wc_w, wc_y + wc_h);
                            SelectObject(dc, old); DeleteObject(pen);
                            SelectObject(dc, null_br);
                            // Fix alpha for border pixels
                            for py in (wc_y-4).max(0)..(wc_y+wc_h+4).min(sh) {
                                let row = bits.add((py * sw * 4) as usize);
                                for px in (wc_x-4).max(0)..(wc_x+wc_w+4).min(sw) {
                                    let o = (px * 4) as usize;
                                    if *row.add(o) != 0 || *row.add(o+1) != 0 || *row.add(o+2) != 0 {
                                        *row.add(o+3) = 255;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // --- Present via UpdateLayeredWindow (per-pixel alpha, SIZE matches DIB) ---
        let bf = BLENDFUNCTION { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: 1 };
        unsafe {
            if frame_count == 0 { log::info!("[OVL] UpdateLayeredWindow called (first frame)"); }
            let _ = UpdateLayeredWindow(hwnd, None, None,
                Some(&SIZE { cx: sw, cy: sh }),
                Some(windows::Win32::Graphics::Gdi::HDC(dc)),
                Some(&POINT { x: 0, y: 0 }),
                COLORREF::default(), Some(&bf), ULW_ALPHA);
            // Ensure window is visible (no-op if already shown)
            let _ = ShowWindow(hwnd, SW_SHOW);
        }

        frame_count += 1;
        std::thread::sleep(std::time::Duration::from_millis(8));
    }

    unsafe {
        if let Some(sdc) = src_dc { DeleteDC(sdc as _); }
        if let Some(sdi) = src_dib { DeleteObject(sdi as _); }
        DeleteObject(_dib); DeleteDC(dc);
    }
    log::info!("[OVL] exit");
}