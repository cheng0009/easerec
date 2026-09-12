//! Encode stage: receives composited frames + audio, writes segmented MP4.
//! Supports: rewind (drop segments), privacy pause, multi-backend encoding.

use std::sync::Arc;
use crossbeam::channel::{Sender, Receiver, TryRecvError};
use crate::encoder::VideoEncoder;
use parking_lot::Mutex as PlMutex;
use crate::encoder::types::{EncodeConfig, Codec, QualityPreset};
use crate::recorder::ring_buffer::RingBuffer;
use super::*;

/// A recording segment: one independently-playable MP4 file.
struct Segment {
    /// Path to the MP4 file
    path: String,
    /// First frame timestamp in this segment
    start_time: f64,
    /// Number of frames written
    frame_count: u64,
    /// Encoder for this segment
    encoder: Option<Box<dyn VideoEncoder>>,
    /// Width / height for this segment
    width: u32,
    height: u32,
    /// Whether this segment has been finalized
    finalized: bool,
}

/// Crash-recovery manifest (JSON)
#[derive(serde::Serialize, serde::Deserialize)]
struct SegmentManifest {
    segments: Vec<String>,
    total_frames: u64,
    start_time: f64,
}

pub struct EncodeStage {
    comp_rx: Receiver<PipelineFrame>,
    audio_rx: Receiver<AudioChunk>,
    cmd_rx: Receiver<StageCommand>,
    #[allow(dead_code)]
    metrics_tx: Sender<PipelineMetrics>,

    // Segment management
    segments: Vec<Segment>,
    active_segment: Option<Segment>,
    segment_dir: String,
    manifest_path: String,
    /// Duration per segment in seconds
    segment_duration_s: f64,

    // Audio buffer
    audio_buffer: Vec<AudioChunk>,

    // State
    paused: bool,
    total_frames: u64,
    start_time: Option<f64>,
    config: EncodeConfig,
    /// Ring buffer for rewind: stores recent frames to re-encode on rewind
    frame_ring: RingBuffer<PipelineFrame>,
    #[allow(dead_code)]
    ring_capacity: usize,
    d3d11_device: Arc<parking_lot::Mutex<Option<usize>>>,
}

impl EncodeStage {
    pub fn new(
        comp_rx: Receiver<PipelineFrame>,
        audio_rx: Receiver<AudioChunk>,
        cmd_rx: Receiver<StageCommand>,
        fps: u32,
        ring_duration_s: f64,
        segment_duration_s: f64,
        d3d11_device: Arc<PlMutex<Option<usize>>>,
    ) -> Self {
        let pid = std::process::id();
        let temp_dir = std::env::temp_dir().join("DirectorCam").join(format!("session_{}", pid));
        let _ = std::fs::create_dir_all(&temp_dir);

        let ring_capacity = (fps as f64 * ring_duration_s) as usize;

        Self {
            comp_rx,
            audio_rx,
            cmd_rx,
            metrics_tx: crossbeam::channel::bounded(16).0,
            segments: Vec::new(),
            active_segment: None,
            segment_dir: temp_dir.to_string_lossy().to_string(),
            manifest_path: temp_dir.join("manifest.json").to_string_lossy().to_string(),
            segment_duration_s,
            audio_buffer: Vec::new(),
            paused: false,
            total_frames: 0,
            start_time: None,
            config: EncodeConfig {
                codec: Codec::H264,
                width: 1920,
                height: 1080,
                fps,
                bitrate: 50_000_000,
                preset: QualityPreset::Balanced,
            },
            frame_ring: RingBuffer::new(ring_capacity),
            ring_capacity,
            d3d11_device,
        }
    }



    /// Open a new segment encoder
    fn open_segment(&mut self, width: u32, height: u32) -> Result<(), String> {
        log::info!("[encode] open_segment: {}x{} (segment #{})", width, height, self.segments.len());
        // Finalize previous segment if any
        let mut active = self.active_segment.take();
        if let Some(ref mut seg) = active {
            if !seg.finalized {
                if let Some(ref mut enc) = seg.encoder {
                    let _ = enc.flush();
                }
                seg.encoder = None;
                seg.finalized = true;
                self.segments.push(Segment {
                    path: seg.path.clone(),
                    start_time: seg.start_time,
                    frame_count: seg.frame_count,
                    encoder: None,
                    width: seg.width,
                    height: seg.height,
                    finalized: true,
                });
            }
        }

        let seg_idx = self.segments.len();
        let path = format!("{}/seg_{:04}.mp4", self.segment_dir, seg_idx);

        self.config.width = width;
        self.config.height = height;

        let mut encoder = crate::encoder::mf::MfEncoder::new_with_path(
            std::path::Path::new(&path)
        ).map_err(|e| format!("Encoder: {}", e))?;
        log::info!("[encode] MfEncoder created for segment #{}", seg_idx);

        // Share D3D11 device with encoder for GPU zero-copy path
        if let Some(device_ptr) = *self.d3d11_device.lock() {
            if device_ptr != 0 {
                let device = unsafe {
                    &*(device_ptr as *const windows::Win32::Graphics::Direct3D11::ID3D11Device)
                };
                if let Err(e) = encoder.set_d3d11_device(device) {
                    log::warn!("[encode] Failed to share D3D11 device with encoder: {}", e);
                }
            }
        }

        encoder.configure(&self.config)
            .map_err(|e| format!("Config: {}", e))?;

        let start_time = self.start_time.unwrap_or(0.0);

        let seg = Segment {
            path: path.clone(),
            start_time,
            frame_count: 0,
            encoder: Some(Box::new(encoder)),
            width,
            height,
            finalized: false,
        };

        log::info!("[encode] Segment {} opened: {}x{} @ {}fps → {}",
            seg_idx, width, height, self.config.fps, path);

        self.active_segment = Some(seg);
        self.write_manifest();
        Ok(())
    }

    #[allow(dead_code)]
    fn finalize_segment(&mut self, seg: &mut Segment) {
        if let Some(ref mut enc) = seg.encoder {
            let _ = enc.flush();
        }
        seg.encoder = None;
        seg.finalized = true;
        self.segments.push(Segment {
            path: seg.path.clone(),
            start_time: seg.start_time,
            frame_count: seg.frame_count,
            encoder: None,
            width: seg.width,
            height: seg.height,
            finalized: true,
        });
        log::info!("[encode] Segment finalized: {} ({} frames)", seg.path, seg.frame_count);
    }

    fn write_manifest(&self) {
        let manifest = SegmentManifest {
            segments: self.segments.iter().map(|s| s.path.clone()).collect(),
            total_frames: self.total_frames,
            start_time: self.start_time.unwrap_or(0.0),
        };
        if let Ok(json) = serde_json::to_string_pretty(&manifest) {
            let _ = std::fs::write(&self.manifest_path, json);
        }
    }

    /// Rewind: drop last N seconds worth of recording
    fn rewind(&mut self, seconds: f64) {
        let frames_to_drop = (self.config.fps as f64 * seconds) as usize;

        // 1. Finalize and remove active segment
        if let Some(ref mut seg) = self.active_segment.take() {
            if !seg.finalized {
                if let Some(ref mut enc) = seg.encoder {
                    let _ = enc.flush();
                }
                seg.encoder = None;
                // Delete the segment file since we''re rewinding past it
                let _ = std::fs::remove_file(&seg.path);
            }
        }

        // 2. Remove recent segments that are within the rewind window
        // Keep only segments before the rewind point
        let mut new_total_frames = self.total_frames.saturating_sub(frames_to_drop as u64);
        let mut kept_segments = Vec::new();

        for seg in self.segments.drain(..) {
            if new_total_frames >= seg.frame_count {
                new_total_frames -= seg.frame_count;
                kept_segments.push(seg);
            } else {
                // This segment is partially in the rewind window — remove it
                let _ = std::fs::remove_file(&seg.path);
            }
        }
        self.segments = kept_segments;
        self.total_frames = new_total_frames;

        // 3. Trim ring buffer
        self.frame_ring.rewind(frames_to_drop);

        // 4. Rewind audio
        let audio_samples_to_drop = (44100.0 * seconds) as usize;
        let mut remaining = audio_samples_to_drop;
        while remaining > 0 && !self.audio_buffer.is_empty() {
            let last = self.audio_buffer.last_mut().unwrap();
            let chunk_len = last.samples.len();
            if chunk_len <= remaining {
                remaining -= chunk_len;
                self.audio_buffer.pop();
            } else {
                // Partial trim (would need Arc::make_mut)
                remaining = 0;
            }
        }

        // 5. Open new segment
        let w = self.config.width;
        let h = self.config.height;
        self.start_time = self.start_time.map(|t| (t - seconds).max(0.0));
        let _ = self.open_segment(w, h);

        // 6. Re-encode ring buffer frames into new segment
        let ring_frames: Vec<PipelineFrame> = self.frame_ring.drain_all().collect();
        for pf in &ring_frames {
            self.encode_frame(pf);
        }
        // Re-populate ring buffer
        for pf in ring_frames {
            self.frame_ring.push(pf);
        }

        log::info!("[encode] Rewound {}s ({} frames). {} segments remain.",
            seconds, frames_to_drop, self.segments.len());
    }

    /// Encode a single frame into the active segment.
    /// GPU frames pass directly to the encoder via encode_from_surface (zero-copy).
    /// CPU frames are flipped and sent via the standard encode path.
    fn encode_frame(&mut self, frame: &PipelineFrame) {
        let seg = match &mut self.active_segment {
            Some(s) => s,
            None => return,
        };

        // ?? Try GPU path first ??
        if let FrameData::Gpu { texture_ptr, width: _, height: _ } = &frame.data {
            if *texture_ptr != 0 {
                // Pass raw texture pointer directly to encoder trait method
                if let Some(ref mut enc) = seg.encoder {
                    match enc.encode_from_surface(*texture_ptr, frame.timestamp_secs) {
                        Ok(_) => {
                            seg.frame_count += 1;
                            return;
                        }
                        Err(e) => {
                            log::warn!("[encode] GPU encode failed: {}, skipping frame", e);
                            return;
                        }
                    }
                }
                // GPU path not available ? skip frame
                return;
            }
        }

        // ?? CPU fallback ??
        if let Some(ref mut enc) = seg.encoder {
            let data = match &frame.data {
                FrameData::Cpu { data, .. } => {
                    // Flip BGRA vertically for encoder
                    let row = (seg.width * 4) as usize;
                    let total = row * seg.height as usize;
                    let mut flipped = vec![0u8; total];
                    for y in 0..seg.height as usize {
                        let src = y * row;
                        let dst = (seg.height as usize - 1 - y) * row;
                        if src + row <= data.len() && dst + row <= total {
                            flipped[dst..dst + row].copy_from_slice(&data[src..src + row]);
                        }
                    }
                    flipped
                }
                FrameData::Gpu { .. } => {
                    // GPU readback not implemented; skip
                    return;
                }
            };
            let _ = enc.encode(&data, frame.timestamp_secs);
        }
        seg.frame_count += 1;
    }
}

impl Stage for EncodeStage {
    fn name(&self) -> &'static str { "encode" }

    fn on_start(&mut self) -> Result<(), String> {
        // Load crash recovery manifest if exists
        if std::path::Path::new(&self.manifest_path).exists() {
            if let Ok(json) = std::fs::read_to_string(&self.manifest_path) {
                if let Ok(_manifest) = serde_json::from_str::<SegmentManifest>(&json) {
                    log::info!("[encode] Found crash recovery manifest with {} segments",
                        _manifest.segments.len());
                    self.total_frames = _manifest.total_frames;
                    self.start_time = Some(_manifest.start_time);
                    // Restore segment list
                    for path in &_manifest.segments {
                        self.segments.push(Segment {
                            path: path.clone(),
                            start_time: 0.0,
                            frame_count: 0,
                            encoder: None,
                            width: 0,
                            height: 0,
                            finalized: true,
                        });
                    }
                }
            }
        }
        log::info!("[encode] Started (segment dir: {})", self.segment_dir);
        Ok(())
    }

    fn tick(&mut self) -> Result<bool, String> {
        // Process commands
        loop {
            match self.cmd_rx.try_recv() {
                Ok(StageCommand::Stop) => return Ok(false),
                Ok(StageCommand::Pause) => { self.paused = true; }
                Ok(StageCommand::Resume) => { self.paused = false; }
                Ok(StageCommand::Rewind(secs)) => {
                    self.rewind(secs);
                }
                Ok(StageCommand::UpdateConfig(uc)) => match uc {
                    StageConfigUpdate::Bitrate(b) => { self.config.bitrate = b; }
                    _ => {}
                },
                Ok(_) => {}
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Ok(false),
            }
        }

        let mut did_work = false;

        // Drain audio
        loop {
            match self.audio_rx.try_recv() {
                Ok(chunk) => {
                    // Cap audio buffer size
                    let total: usize = self.audio_buffer.iter().map(|c| c.samples.len()).sum();
                    if total < MAX_AUDIO_BUFFER_SAMPLES {
                        self.audio_buffer.push(chunk);
                    }
                    did_work = true;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }

        if self.paused {
            return Ok(did_work);
        }

        // Process one video frame
        match self.comp_rx.try_recv() {
            Ok(frame) => {
                let w = frame.data.width();
                let h = frame.data.height();
                
                if self.total_frames == 0 {
                    log::info!("[encode] Processing first frame ({}x{}), opening segment...", w, h);
                }

                // Initialize first segment or rotate segments
                if self.active_segment.is_none() {
                    self.start_time = Some(frame.timestamp_secs);
                    self.open_segment(w, h)?;
                    log::info!("[encode] First segment opened: {}x{}", w, h);
                }

                // Check if we need to rotate to a new segment
                let rotate = if let Some(ref seg) = self.active_segment {
                    let elapsed = frame.timestamp_secs - seg.start_time;
                    elapsed >= self.segment_duration_s
                } else {
                    false
                };

                if rotate {
                    let _ = self.open_segment(w, h);
                }

                // Ensure dimensions match
                if let Some(ref seg) = self.active_segment {
                    if seg.width != w || seg.height != h {
                        let _ = self.open_segment(w, h);
                    }
                }

                // Encode
                self.encode_frame(&frame);
                self.total_frames += 1;
                if self.total_frames <= 3 || self.total_frames % 60 == 0 {
                    log::info!("[encode] Encoded frame #{}", self.total_frames);
                }

                // Store in ring buffer (for rewind)
                self.frame_ring.push(frame);

                did_work = true;
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return Ok(false),
        }

        Ok(did_work)
    }

    fn on_stop(&mut self) {
        // Finalize active segment
        let mut active = self.active_segment.take();
        if let Some(ref mut seg) = active {
            if !seg.finalized {
                if let Some(ref mut enc) = seg.encoder {
                    let _ = enc.flush();
                }
                seg.encoder = None;
                seg.finalized = true;
                self.segments.push(Segment {
                    path: seg.path.clone(),
                    start_time: seg.start_time,
                    frame_count: seg.frame_count,
                    encoder: None,
                    width: seg.width,
                    height: seg.height,
                    finalized: true,
                });
            }
        }
        self.active_segment = None;
        self.write_manifest();
        log::info!("[encode] Stopped. Total: {} frames, {} segments",
            self.total_frames, self.segments.len());
    }

    fn should_stop(&self) -> bool { false }
}

/// Public API for post-recording operations
impl EncodeStage {
    /// Get list of all segment file paths
    pub fn segment_paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self.segments.iter()
            .map(|s| s.path.clone())
            .collect();
        if let Some(ref seg) = self.active_segment {
            paths.push(seg.path.clone());
        }
        paths
    }

    /// Get the directory where segments are stored
    pub fn segment_directory(&self) -> &str {
        &self.segment_dir
    }

    /// Get the crash-recovery manifest path
    pub fn manifest_path(&self) -> &str {
        &self.manifest_path
    }
}













