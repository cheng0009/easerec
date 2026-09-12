//! Standalone rewind notification window ? always excluded from DXGI capture.
//! Uses SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) to never appear in video.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use windows::Win32::UI::WindowsAndMessaging::{
    ShowWindow, SW_SHOW, SW_HIDE, SM_CXSCREEN, SM_CYSCREEN, GetSystemMetrics,
    WS_EX_LAYERED, WS_EX_TOPMOST, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    CreateWindowExW, WS_POPUP,
    UpdateLayeredWindow, ULW_ALPHA, RegisterClassExW, WNDCLASSEXW, DefWindowProcW,
};
use windows::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BLENDFUNCTION, HBRUSH};
use windows::Win32::Foundation::{HWND, POINT, SIZE, COLORREF, GetLastError, ERROR_CLASS_ALREADY_EXISTS, WPARAM, LPARAM, LRESULT, HINSTANCE};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::core::w;

type HGDIOBJ = *mut std::ffi::c_void;
type BOOL = i32;

const DIB_RGB_COLORS: u32 = 0;
const WDA_EXCLUDEFROMCAPTURE: u32 = 17;

fn make_cr(r: u8, g: u8, b: u8) -> COLORREF { COLORREF(r as u32 | (g as u32) << 8 | (b as u32) << 16) }

extern "system" {
    fn CreateCompatibleDC(hdc: HGDIOBJ) -> HGDIOBJ;
    fn DeleteDC(hdc: HGDIOBJ) -> BOOL;
    fn CreateDIBSection(hdc: HGDIOBJ, pbmi: *const BITMAPINFOHEADER, usage: u32,
        ppvBits: *mut *mut u8, hSection: HGDIOBJ, offset: u32) -> HGDIOBJ;
    fn SelectObject(hdc: HGDIOBJ, h: HGDIOBJ) -> HGDIOBJ;
    fn DeleteObject(h: HGDIOBJ) -> BOOL;
    fn CreateFontW(h: i32, w: i32, escapement: i32, orientation: i32, weight: i32,
        italic: u32, underline: u32, strikeout: u32, charset: u32,
        outputprecision: u32, clipprecision: u32, quality: u32,
        pitchandfamily: u32, facename: *const u16) -> HGDIOBJ;
    fn SetBkMode(hdc: HGDIOBJ, mode: i32) -> i32;
    fn SetTextColor(hdc: HGDIOBJ, color: COLORREF) -> COLORREF;
    fn TextOutW(hdc: HGDIOBJ, x: i32, y: i32, text: *const u16, len: i32) -> BOOL;
    fn SetWindowDisplayAffinity(hwnd: HGDIOBJ, affinity: u32) -> BOOL;
}

unsafe extern "system" fn nf_wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wp, lp)
}

pub struct RewindNotifier {
    hwnd: HWND,
    text: Mutex<Option<String>>,
    running: AtomicBool,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl RewindNotifier {
    pub fn new() -> Option<Self> {
        let sw = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let sh = unsafe { GetSystemMetrics(SM_CYSCREEN) };
        let (pw, ph): (i32, i32) = (700, 140);
        let (px, py) = ((sw - pw) / 2, (sh - ph) / 2);

        let class_name = w!("DC_REWIND_NTF");
        let hinst = match unsafe { GetModuleHandleW(None) } {
            Ok(h) => HINSTANCE(h.0), Err(_) => return None,
        };

        unsafe {
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: windows::Win32::UI::WindowsAndMessaging::WNDCLASS_STYLES(0),
                lpfnWndProc: Some(nf_wndproc),
                hInstance: hinst,
                hbrBackground: HBRUSH::default(),
                lpszClassName: class_name,
                ..Default::default()
            };
            let atom = RegisterClassExW(&wc);
            if atom == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
                return None;
            }
        }

        let hwnd = match unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                class_name, w!(""), WS_POPUP,
                px, py, pw, ph, None, None, Some(hinst), None,
            )
        } {
            Ok(h) => h,
            Err(_) => return None,
        };

        // Exclude from screen capture immediately
        unsafe { let _ = SetWindowDisplayAffinity(hwnd.0 as _, WDA_EXCLUDEFROMCAPTURE); }

        Some(Self {
            hwnd,
            text: Mutex::new(None),
            running: AtomicBool::new(false),
            thread: Mutex::new(None),
        })
    }

    pub fn show(&self, text: &str) {
        if let Ok(mut t) = self.text.lock() {
            *t = Some(text.to_string());
        }
        if self.running.load(Ordering::SeqCst) {
            return; // already showing
        }
        self.running.store(true, Ordering::SeqCst);
        let hwnd_raw = self.hwnd.0 as isize;
        let text_ref = self.text.lock().ok().map(|t| t.clone()).flatten();
        let run_flag = std::sync::Arc::new(AtomicBool::new(true));
        let run_clone = run_flag.clone();

        // Kill old thread if any
        if let Ok(mut th) = self.thread.lock() {
            if let Some(jh) = th.take() {
                run_flag.store(false, Ordering::SeqCst);
                let _ = jh.join();
            }
        }

        let mut thread_handle = self.thread.lock().unwrap();
        let start = Instant::now();
        let duration_ms = 1500u64;
        let (pw, ph): (i32, i32) = (700, 140);

        *thread_handle = Some(std::thread::spawn(move || {
            let hwnd = HWND(hwnd_raw as *mut _);
            let (dc, _dib, bits) = unsafe {
                let dc = CreateCompatibleDC(std::ptr::null_mut());
                let bi = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: pw, biHeight: -ph, biPlanes: 1, biBitCount: 32,
                    biCompression: 0, biSizeImage: 0,
                    biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
                };
                let mut b: *mut u8 = std::ptr::null_mut();
                let dib = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &mut b, std::ptr::null_mut(), 0);
                SelectObject(dc, dib);
                (dc, dib, b)
            };

            let txt: Vec<u16> = text_ref.unwrap_or_default().encode_utf16().collect();

            loop {
                if start.elapsed().as_millis() >= duration_ms as u128 {
                    break;
                }
                if !run_clone.load(Ordering::SeqCst) {
                    break;
                }

                // Clear with alpha=0 (fully transparent)
                unsafe {
                    std::ptr::write_bytes(bits, 0, (pw * ph * 4) as usize);
                }

                // Dark pill background
                let margin = 20;
                unsafe {
                    for py in margin..ph-margin {
                        let row = bits.add((py * pw * 4) as usize);
                        for px in margin..pw-margin {
                            let o = (px * 4) as usize;
                            *row.add(o) = 40; *row.add(o+1) = 40; *row.add(o+2) = 40;
                            *row.add(o+3) = 200;
                        }
                    }
                }

                // White text
                unsafe {
                    let font_name: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
                    let font = CreateFontW(64, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 4, 0, font_name.as_ptr());
                    let old_font = SelectObject(dc, font);
                    SetBkMode(dc, 1);
                    SetTextColor(dc, make_cr(255, 255, 255));
                    // Center text roughly
                    let tx = (pw - txt.len() as i32 * 40) / 2;
                    TextOutW(dc, tx.max(30), 30, txt.as_ptr(), txt.len() as i32);
                    SelectObject(dc, old_font);
                    DeleteObject(font);

                    // Fix alpha
                    for py in 0..ph {
                        let row = bits.add((py * pw * 4) as usize);
                        for px in 0..pw {
                            let o = (px * 4) as usize;
                            if *row.add(o) != 0 || *row.add(o+1) != 0 || *row.add(o+2) != 0 {
                                *row.add(o+3) = 255;
                            }
                        }
                    }
                }

                let bf = BLENDFUNCTION { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: 1 };
                unsafe {
                    let _ = UpdateLayeredWindow(hwnd, None, None,
                        Some(&SIZE { cx: pw, cy: ph }),
                        Some(windows::Win32::Graphics::Gdi::HDC(dc)),
                        Some(&POINT { x: 0, y: 0 }),
                        COLORREF::default(), Some(&bf), ULW_ALPHA);
                    let _ = ShowWindow(hwnd, SW_SHOW);
                }

                std::thread::sleep(std::time::Duration::from_millis(33)); // ~30fps
            }

            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
                DeleteObject(_dib);
                DeleteDC(dc);
            }
        }));

        // Spawn a cleanup thread to reset running flag
        let running = std::sync::Arc::new(AtomicBool::new(true));
        let _running_clone = running.clone();
        // We''ll handle reset in the shortcut handler instead
    }
}

unsafe impl Send for RewindNotifier {}
unsafe impl Sync for RewindNotifier {}
