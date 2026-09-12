//! macOS ScreenCaptureKit stub
//! Full implementation will use Apple's ScreenCaptureKit framework.
//! This stub allows compilation on macOS for UI development.

use super::types::{CapturedFrame, CaptureConfig};
use super::ScreenCapture;
use crate::error::AppResult;

pub struct SckCapture {
    config: Option<CaptureConfig>,
}

impl SckCapture {
    pub fn new() -> Self {
        Self { config: None }
    }
}

impl ScreenCapture for SckCapture {
    fn start(&mut self, config: CaptureConfig) -> AppResult<()> {
        log::info!("ScreenCaptureKit stub: start ({} fps)", config.target_fps);
        self.config = Some(config);
        Ok(())
    }

    fn stop(&mut self) -> AppResult<()> {
        log::info!("ScreenCaptureKit stub: stop");
        self.config = None;
        Ok(())
    }

    fn next_frame(&mut self) -> AppResult<Option<CapturedFrame>> {
        // Stub: returns no frames
        // Full implementation will use SCStream to capture frames
        Ok(None)
    }
}