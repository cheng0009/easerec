//! Global low-level mouse hook (WH_MOUSE_LL).
//!
//! While a screen effect (highlighter or magnifier) is active the overlay is
//! meant to shield the desktop underneath: left-button mouse events are
//! swallowed so the presenter can draw/point without operating the windows
//! below (no stray clicks, no desktop drag-rect). When no effect is active all
//! mouse events pass through untouched.

use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, HHOOK, MSG, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL,
};

const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_LBUTTONDBLCLK: u32 = 0x0203;

static SWALLOW_LEFT_BUTTON: AtomicBool = AtomicBool::new(false);

/// Enable/disable click swallowing. Should mirror "is an effect active".
pub fn update(swallow_clicks: bool) {
    SWALLOW_LEFT_BUTTON.store(swallow_clicks, Ordering::SeqCst);
}

fn should_swallow(msg: u32) -> bool {
    if !SWALLOW_LEFT_BUTTON.load(Ordering::SeqCst) {
        return false;
    }
    matches!(msg, WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK)
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && should_swallow(wparam.0 as u32) {
        return LRESULT(1);
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Install the hook on a dedicated thread that pumps messages. The thread runs
/// for the lifetime of the process.
pub fn install() {
    std::thread::spawn(move || {
        let hook = unsafe {
            SetWindowsHookExW(
                WH_MOUSE_LL,
                Some(hook_proc),
                None,
                0,
            )
        };
        match hook {
            Ok(h) => {
                log::info!("[mouse-hook] WH_MOUSE_LL installed");
                let mut msg = MSG::default();
                loop {
                    let r = unsafe { GetMessageW(&mut msg, None, 0, 0) };
                    if !r.as_bool() {
                        break;
                    }
                    unsafe {
                        let _ = TranslateMessage(&msg);
                        let _ = DispatchMessageW(&msg);
                    }
                }
                let _ = unsafe { UnhookWindowsHookEx(h) };
            }
            Err(e) => log::error!("[mouse-hook] install failed: {:?}", e),
        }
    });
}