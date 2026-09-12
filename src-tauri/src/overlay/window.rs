//! DirectorCam overlay — uses Tauri window HWND + GDI UpdateLayeredWindow.
//! HWND created on main thread, rendering loop in spawned thread.

use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};

use windows::Win32::UI::WindowsAndMessaging::{
    ShowWindow, GetCursorPos,
    SW_SHOW, SW_HIDE,
    SM_CXSCREEN, SM_CYSCREEN, GetSystemMetrics,
    MSG, PeekMessageW, DispatchMessageW, TranslateMessage, PM_REMOVE,
    UpdateLayeredWindow, ULW_ALPHA, SetWindowLongPtrW, GWL_EXSTYLE,
    WS_EX_LAYERED, WS_EX_TRANSPARENT, WS_EX_TOPMOST, WS_EX_NOACTIVATE,
};
use windows::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BLENDFUNCTION};
use windows::Win32::Foundation::{HWND, POINT, SIZE, COLORREF};

type HGDIOBJ = *mut std::ffi::c_void;
type BOOL = i32;
const DIB_RGB_COLORS: u32 = 0;
const SRCCOPY: u32 = 0x00CC0020;

extern "system" {
    fn CreateCompatibleDC(hdc: HGDIOBJ) -> HGDIOBJ;
    fn DeleteDC(hdc: HGDIOBJ) -> BOOL;
    fn CreateDIBSection(hdc: HGDIOBJ, pbmi: *const BITMAPINFOHEADER, usage: u32, ppvBits: *mut *mut u8, hSection: HGDIOBJ, offset: u32) -> HGDIOBJ;
    fn SelectObject(hdc: HGDIOBJ, h: HGDIOBJ) -> HGDIOBJ;
    fn DeleteObject(h: HGDIOBJ) -> BOOL;
    fn StretchBlt(hdcDst: HGDIOBJ, xDst: i32, yDst: i32, wDst: i32, hDst: i32, hdcSrc: HGDIOBJ, xSrc: i32, ySrc: i32, wSrc: i32, hSrc: i32, rop: u32) -> BOOL;
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
}

fn make_cr(r: u8, g: u8, b: u8) -> COLORREF { COLORREF((r as u32) << 16 | (g as u32) << 8 | b as u32) }

#[derive(Clone, Default)]
pub struct OverlayState {
    pub active: bool,
    pub magnifier_enabled: bool,
    pub step_marker_active: bool,
    pub highlighter_active: bool,
    pub magnifier_cx: f32, pub magnifier_cy: f32, pub magnifier_zoom: u32,
    pub step_markers: Vec<(u32, f32, f32)>,
    pub highlighter_strokes: Vec<Vec<(f32, f32)>>,
    pub ripples: Vec<(f32, f32, f32, f32)>,
    pub frame_data: Vec<u8>, pub frame_w: u32, pub frame_h: u32,
    // Frozen clean frame captured by overlay for compositor use (avoids ghosting)
    pub magnifier_source: Vec<u8>,
    pub magnifier_source_w: u32,
    pub magnifier_source_h: u32,
    // Mosaic privacy regions (normalized coords) and current drag preview
    pub mosaic_regions: Vec<(f32, f32, f32, f32)>,
    pub mosaic_drag_preview: Option<(f32, f32, f32, f32)>,
    pub privacy_paused: bool,
    pub privacy_rewind_offset: f64,
    // Webcam overlay: latest frame + config for on-screen preview
    pub webcam_frame: Vec<u8>,
    pub webcam_frame_w: u32,
    pub webcam_frame_h: u32,
    pub webcam_enabled: bool,
    pub webcam_position: String,
    pub webcam_custom_x: f32,
    pub webcam_custom_y: f32,
    pub webcam_size_ratio: f32,
    pub webcam_shape: String,
    pub webcam_border_color: (f32, f32, f32, f32),
    pub webcam_border_width: f32,
    pub webcam_corner_radius: f32,
}

pub struct OverlayWindow {
    sw: i32, sh: i32,
    running: Arc<AtomicBool>,
    state: Arc<Mutex<OverlayState>>,
    thread: Option<std::thread::JoinHandle<()>>,
    hwnd_raw: Arc<Mutex<Option<isize>>>,
}

unsafe impl Send for OverlayWindow {}
unsafe impl Sync for OverlayWindow {}

impl OverlayWindow {
    pub fn new() -> Self {
        Self {
            sw: unsafe { GetSystemMetrics(SM_CXSCREEN) },
            sh: unsafe { GetSystemMetrics(SM_CYSCREEN) },
            running: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(OverlayState::default())),
            thread: None,
            hwnd_raw: Arc::new(Mutex::new(None)),
        }
    }

    pub fn state_ref(&self) -> Arc<Mutex<OverlayState>> { self.state.clone() }
    pub fn update_dimensions(&mut self, w: i32, h: i32) { self.sw = w; self.sh = h; }

    /// Store HWND (called from main thread)
    pub fn set_hwnd(&self, h: HWND) {
        if let Ok(mut g) = self.hwnd_raw.lock() { *g = Some(h.0 as isize); }
    }

    pub fn show(&mut self) {
        if self.running.load(Ordering::SeqCst) { return; }
        self.running.store(true, Ordering::SeqCst);
        let sref = self.state.clone();
        let run = self.running.clone();
        let hwnd_arc = self.hwnd_raw.clone();
        let sw = self.sw; let sh = self.sh;
        self.thread = Some(std::thread::spawn(move || {
            render_loop(&sref, &run, &hwnd_arc, sw, sh);
        }));
    }

    /// Create a raw layered Win32 window — must be called from main thread
    fn create_raw_window(sw: i32, sh: i32) -> Option<isize> {
        use windows::Win32::UI::WindowsAndMessaging::*;
        use windows::Win32::Foundation::*;
        use std::mem;

        let class_name = windows::core::w!("DC_OVERLAY");
        unsafe {
            let wc = WNDCLASSEXW {
                cbSize: mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: None,
                hInstance: HINSTANCE::default(),
                lpszClassName: class_name,
                ..Default::default()
            };
            RegisterClassExW(&wc);
        }

        match unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
                class_name, windows::core::w!(""),
                WS_POPUP, 0, 0, sw, sh,
                None, None, Some(HINSTANCE::default()), None,
            )
        } {
            Ok(h) => {
                log::info!("[OVERLAY] Raw window created: {:?}", h);
                Some(h.0 as isize)
            }
            Err(e) => {
                log::error!("[OVERLAY] CreateWindowExW failed: {:?}", e);
                None
            }
        }
    }

    pub fn hide(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(t) = self.thread.take() { let _ = t.join(); }
    }
}

impl Drop for OverlayWindow {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(t) = self.thread.take() { let _ = t.join(); }
    }
}

fn render_loop(
    state: &Arc<Mutex<OverlayState>>,
    running: &Arc<AtomicBool>,
    hwnd_arc: &Arc<Mutex<Option<isize>>>,
    sw: i32, sh: i32,
) {
    log::info!("[OVERLAY] render_loop: {}x{}", sw, sh);

    // Get or create HWND (with COM init on this thread if needed)
    let hwnd_raw: isize = {
        if let Ok(g) = hwnd_arc.lock() {
            if let Some(r) = *g { r }
            else {
                drop(g);
                // Try creating window from this thread
                unsafe {
                    let _ = windows::Win32::System::Com::CoInitializeEx(
                        None,
                        windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
                    );
                }
                let maybe_hwnd = OverlayWindow::create_raw_window(sw, sh);
                if let Some(h) = maybe_hwnd {
                    if let Ok(mut g) = hwnd_arc.lock() { *g = Some(h); }
                    h
                } else {
                    log::error!("[OVERLAY] Cannot create window, exiting render loop");
                    return;
                }
            }
        } else {
            return;
        }
    };
    let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
    log::info!("[OVERLAY] HWND: {:?}", hwnd);

    // Apply layered styles
    unsafe {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE,
            (WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE).0 as isize);
    }

    let dw = sw / 2; let dh = sh / 2;
    let sx = sw as f32 / dw as f32;
    let sy = sh as f32 / dh as f32;

    let (dc, dib, bits, buf) = unsafe {
        let sc = GetDC(std::ptr::null_mut());
        let dc = CreateCompatibleDC(sc);
        ReleaseDC(std::ptr::null_mut(), sc);
        let bi = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: dw, biHeight: -dh, biPlanes: 1, biBitCount: 32,
            biCompression: 0, biSizeImage: (dw*dh*4) as u32,
            biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
        };
        let mut b: *mut u8 = std::ptr::null_mut();
        let d = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &mut b, std::ptr::null_mut(), 0);
        SelectObject(dc, d);
        (dc, d, b, (dw*dh*4) as usize)
    };

    let mut src_dc: HGDIOBJ = std::ptr::null_mut();
    let mut src_dib: HGDIOBJ = std::ptr::null_mut();
    let mut src_bits: *mut u8 = std::ptr::null_mut();
    let mut lfw: i32 = 0; let mut lfh: i32 = 0;

    let bf = BLENDFUNCTION { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: 1 };
    log::info!("[OVERLAY] Loop started");

    loop {
        if !running.load(Ordering::SeqCst) { break; }

        // Pump messages
        let mut msg = MSG::default();
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            unsafe { let _ = TranslateMessage(&msg); let _ = DispatchMessageW(&msg); }
        }

        let st = match state.lock() { Ok(s) => s.clone(), Err(_) => break };
        let has_fx = st.magnifier_enabled || !st.step_markers.is_empty()
            || !st.highlighter_strokes.is_empty() || !st.ripples.is_empty();

        if !has_fx {
            unsafe {
                std::ptr::write_bytes(bits, 0, buf);
                let _ = UpdateLayeredWindow(hwnd, None, None,
                    Some(&SIZE { cx: sw, cy: sh }),
                    Some(windows::Win32::Graphics::Gdi::HDC(dc)),
                    Some(&POINT { x: 0, y: 0 }),
                    COLORREF::default(), Some(&bf), ULW_ALPHA);
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            std::thread::sleep(std::time::Duration::from_millis(33));
            continue;
        }

        unsafe { std::ptr::write_bytes(bits, 0, buf); }

        // Magnifier
        if st.magnifier_enabled && !st.frame_data.is_empty() && st.frame_w > 0 {
            let fw = st.frame_w as i32; let fh = st.frame_h as i32;
            let zoom = match st.magnifier_zoom { 1=>1.5, 2=>2.5, 3=>4.0, _=>1.5 };
            let mut pt = POINT { x:0, y:0 };
            unsafe { let _ = GetCursorPos(&mut pt); }
            let cx = pt.x; let cy = pt.y;
            let mr = ((sw.min(sh)) as f32 * 0.12 / sx) as i32;
            let ms = (mr as f32 * sx) as i32;
            let sr = (ms as f32 / zoom) as i32;

            unsafe {
                if fw != lfw || fh != lfh {
                    if !src_dib.is_null() { DeleteObject(src_dib); }
                    if !src_dc.is_null() { DeleteDC(src_dc); }
                    let sc = GetDC(std::ptr::null_mut());
                    src_dc = CreateCompatibleDC(sc);
                    ReleaseDC(std::ptr::null_mut(), sc);
                    let bi = BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: fw, biHeight: -fh, biPlanes:1, biBitCount:32,
                        biCompression:0, biSizeImage:0,
                        biXPelsPerMeter:0, biYPelsPerMeter:0, biClrUsed:0, biClrImportant:0,
                    };
                    let mut bp: *mut u8 = std::ptr::null_mut();
                    src_dib = CreateDIBSection(src_dc, &bi, DIB_RGB_COLORS, &mut bp, std::ptr::null_mut(), 0);
                    SelectObject(src_dc, src_dib); src_bits = bp; lfw = fw; lfh = fh;
                }
                if !src_bits.is_null() {
                    let n = (fw*fh*4) as usize;
                    std::ptr::copy_nonoverlapping(st.frame_data.as_ptr(), src_bits, n.min(st.frame_data.len()));
                }
            }

            if !src_dc.is_null() && !src_dib.is_null() {
                let dx = (cx as f32/sx) as i32 - mr; let dy = (cy as f32/sy) as i32 - mr;
                let ds = mr*2; let sx0 = (cx-sr).max(0); let sy0 = (cy-sr).max(0);
                let ss = (sr*2).min(fw-sx0).min(fh-sy0);
                unsafe { StretchBlt(dc, dx.max(0), dy.max(0), ds, ds, src_dc, sx0, sy0, ss, ss, SRCCOPY); }
            }

            let da: u8 = 180; let ocx = (cx as f32/sx) as i32; let ocy = (cy as f32/sy) as i32;
            let r2 = mr*mr;
            unsafe {
                for py in 0..dh {
                    let dy = py - ocy; let row = bits.add((py*dw*4) as usize);
                    for px in 0..dw {
                        let dx = px - ocx; let o = (px*4) as usize;
                        if dx*dx + dy*dy <= r2 { *row.add(o+3) = 255; }
                        else { *row.add(o)=0; *row.add(o+1)=0; *row.add(o+2)=0; *row.add(o+3)=da; }
                    }
                }
                let pen = CreatePen(0, 4, make_cr(255,255,255));
                let old = SelectObject(dc, pen);
                Ellipse(dc, ocx-mr, ocy-mr, ocx+mr, ocy+mr);
                SelectObject(dc, old); DeleteObject(pen);
            }
        }

        // Step markers
        for (n, mx, my) in &st.step_markers {
            let px = (*mx*sw as f32/sx) as i32; let py = (*my*sh as f32/sy) as i32;
            unsafe {
                let br = CreateSolidBrush(make_cr(64,128,255)); let old = SelectObject(dc, br);
                Ellipse(dc, px-14, py-14, px+14, py+14); SelectObject(dc, old); DeleteObject(br);
                SetBkMode(dc,1); SetTextColor(dc, make_cr(255,255,255));
                let s: Vec<u16> = format!("{}",n).encode_utf16().collect();
                TextOutW(dc, px-4, py-7, s.as_ptr(), s.len() as i32);
            }
        }

        // Highlighter
        for stroke in &st.highlighter_strokes {
            if stroke.len()<2 { continue; }
            unsafe {
                let pen = CreatePen(0,4,make_cr(255,255,0)); let old = SelectObject(dc, pen);
                MoveToEx(dc, (stroke[0].0*sw as f32/sx) as i32, (stroke[0].1*sh as f32/sy) as i32, std::ptr::null_mut());
                for pt in &stroke[1..] { LineTo(dc, (pt.0*sw as f32/sx) as i32, (pt.1*sh as f32/sy) as i32); }
                SelectObject(dc, old); DeleteObject(pen);
            }
        }

        // Ripples
        for (rx,ry,rr,ra) in &st.ripples {
            if *ra<=0.01 { continue; }
            let a = (*ra*255.0) as u8;
            unsafe {
                let br = CreateSolidBrush(make_cr(a,a,a)); let old = SelectObject(dc, br);
                let rpx = (*rr*sw.min(sh) as f32/sx) as i32; let rpy = (*rr*sw.min(sh) as f32/sy) as i32;
                Ellipse(dc, (*rx*sw as f32/sx) as i32-rpx, (*ry*sh as f32/sy) as i32-rpy,
                    (*rx*sw as f32/sx) as i32+rpx, (*ry*sh as f32/sy) as i32+rpy);
                SelectObject(dc, old); DeleteObject(br);
            }
        }

        unsafe {
            let _ = UpdateLayeredWindow(hwnd, None, None,
                Some(&SIZE { cx: sw, cy: sh }),
                Some(windows::Win32::Graphics::Gdi::HDC(dc)),
                Some(&POINT { x:0, y:0 }), COLORREF::default(), Some(&bf), ULW_ALPHA);
            let _ = ShowWindow(hwnd, SW_SHOW);
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    }

    unsafe {
        if !src_dib.is_null() { DeleteObject(src_dib); }
        if !src_dc.is_null() { DeleteDC(src_dc); }
        DeleteObject(dib); DeleteDC(dc);
    }
    log::info!("[OVERLAY] exit");
}