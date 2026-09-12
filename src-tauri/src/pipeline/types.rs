//! Pipeline types: frame data, stage handles, pipeline messages.
//! Zero-copy design: frames passed as GPU texture references when possible.

use std::sync::Arc;

// ── Stage trait ──

/// A pipeline stage runs a processing loop in its own thread.
pub trait Stage: Send + 'static {
    /// Return the stage name for logging.
    fn name(&self) -> &'static str;

    /// Called once before the processing loop starts.
    fn on_start(&mut self) -> Result<(), String>;

    /// Process one iteration. Return true if work was done, false if idle.
    fn tick(&mut self) -> Result<bool, String>;

    /// Called when the stage should stop. Clean up resources.
    fn on_stop(&mut self);

    /// Check whether the stage should exit its loop.
    fn should_stop(&self) -> bool;
}

// ── Frame types ──

/// Frame payload — either a GPU texture reference or CPU buffer (fallback)
#[derive(Clone)]
pub enum FrameData {
    /// GPU path: shared texture on the pipeline D3D11 device.
    /// The texture is BGRA8_UNORM format, readable as shader resource.
    Gpu {
        /// Opaque pointer to ID3D11Texture2D (we avoid windows-rs dependency here;
        /// the actual interop is handled inside stages that own the device).
        texture_ptr: usize,
        width: u32,
        height: u32,
    },
    /// CPU fallback: owned BGRA pixel buffer.
    Cpu {
        data: Arc<Vec<u8>>,
        width: u32,
        height: u32,
    },
}

impl FrameData {
    pub fn width(&self) -> u32 {
        match self { Self::Gpu { width, .. } => *width, Self::Cpu { width, .. } => *width }
    }
    pub fn height(&self) -> u32 {
        match self { Self::Gpu { height, .. } => *height, Self::Cpu { height, .. } => *height }
    }
    pub fn is_gpu(&self) -> bool { matches!(self, Self::Gpu { .. }) }
}

/// Annotated frame flowing through the pipeline
#[derive(Clone)]
pub struct PipelineFrame {
    pub data: FrameData,
    /// Timestamp in seconds since pipeline start
    pub timestamp_secs: f64,
    /// Monotonic frame sequence number
    pub frame_number: u64,
    /// Cursor position in screen coordinates (if cursor capture is enabled)
    pub cursor_pos: Option<(i32, i32)>,
}

/// Audio chunk flowing through the pipeline
#[derive(Clone)]
pub struct AudioChunk {
    /// Float samples, mono or stereo interleaved
    pub samples: Arc<Vec<f32>>,
    /// Sample rate (Hz)
    pub sample_rate: u32,
    /// Number of channels
    pub channels: u16,
    /// Timestamp of first sample in seconds
    pub timestamp_secs: f64,
}

// ── Control messages ──

/// Control messages sent to pipeline stages
#[derive(Debug, Clone)]
pub enum StageCommand {
    /// Start processing
    Start,
    /// Stop processing gracefully
    Stop,
    /// Pause (privacy mode)
    Pause,
    /// Resume after pause
    Resume,
    /// Rewind recording by N seconds
    Rewind(f64),
    /// Update configuration at runtime
    UpdateConfig(StageConfigUpdate),
}

/// Runtime configuration updates
#[derive(Debug, Clone)]
pub enum StageConfigUpdate {
    Magnifier { active: bool, x: f32, y: f32, zoom: u32 },
    OverlayCommands(Vec<crate::overlay::RenderCommand>),
    MosaicRegions(Vec<(f32, f32, f32, f32)>),
    Bitrate(u32),
}

/// Status reported by a stage
#[derive(Debug, Clone)]
pub enum StageStatus {
    Running,
    Paused,
    Stopped,
    Error(String),
}

/// Performance metrics from the pipeline
#[derive(Debug, Clone, Default)]
pub struct PipelineMetrics {
    pub capture_fps: f32,
    pub encode_fps: f32,
    pub composite_latency_us: u64,
    pub encode_latency_us: u64,
    pub dropped_frames: u64,
    pub gpu_memory_mb: f32,
    pub cpu_percent: f32,
}

// ── Backpressure tuning ──

/// Maximum frames in flight between capture and encode.
/// At 4K60 this is ~640 MB of GPU memory; keep it small for latency control.
pub const MAX_FRAMES_IN_FLIGHT: usize = 32;

/// Audio buffer soft cap in samples (10 seconds at 44.1 kHz mono)
pub const MAX_AUDIO_BUFFER_SAMPLES: usize = 441_000;
