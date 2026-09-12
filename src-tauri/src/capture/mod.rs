pub mod types;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

use crate::error::AppResult;
use types::{CapturedFrame, CaptureConfig};

/// Screen capture abstraction
pub trait ScreenCapture: Send {
    fn start(&mut self, config: CaptureConfig) -> AppResult<()>;
    fn stop(&mut self) -> AppResult<()>;
    fn next_frame(&mut self) -> AppResult<Option<CapturedFrame>>;
}