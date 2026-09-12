use serde::{Deserialize, Serialize};

/// Configuration for screen capture
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureConfig {
    pub target_fps: u32,
    pub capture_cursor: bool,
    pub output_monitor: usize,
    pub crop_rect: Option<CropRect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CropRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A captured screen frame
#[derive(Debug, Clone)]
pub struct CapturedFrame {
    /// RGBA pixel data
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    /// Relative timestamp from recording start (seconds)
    pub timestamp: f64,
    /// Cursor position in screen coordinates
    pub cursor_pos: Option<(i32, i32)>,
}
