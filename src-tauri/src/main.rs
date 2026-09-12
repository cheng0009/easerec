//! Main entry point for the Tauri application
//! Prevents additional console window on Windows

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Declare DPI awareness so GetSystemMetrics returns real pixel values
    // (not DPI-virtualized 1920x1080 on 4K displays)
    #[cfg(target_os = "windows")]
    unsafe {
        extern "system" { fn SetProcessDPIAware() -> i32; }
        SetProcessDPIAware();
    }
    app_lib::run();
}
