use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PerformanceMetrics {
    pub fps: f64,
    pub cpu_percent: f64,
    pub dropped_frames: u64,
    pub encoding_latency_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimeUpdate {
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingStateEvent {
    pub is_recording: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StudioModeEvent {
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppNotification {
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioStateEvent {
    pub source: String,
    pub loopback_active: bool,
    pub mic_active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewFrameEvent {
    pub data: String,  // base64-encoded RGB
    pub width: u32,
    pub height: u32,
}
