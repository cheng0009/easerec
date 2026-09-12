pub mod ring_buffer;
pub mod session;

use crate::config::RecordingConfig;
use crate::error::AppResult;
use crate::audio::crossfade;
use crate::encoder::VideoEncoder;
use crate::audio::AudioCapture;
use ring_buffer::RingBuffer;


#[derive(Debug, Clone)]
pub struct SplicePoint {
    pub pts: f64,
    pub needs_crossfade: bool,
}

pub struct Recorder {
    pub config: RecordingConfig,
    pub is_recording: bool,

    // Direct MP4 encoder (active during recording, writes to temp file)
    encoder: Option<Box<dyn crate::encoder::VideoEncoder>>,
    pub final_output_path: Option<String>,

    // Ring buffer for rewind: holds last N seconds of frames at recording resolution
    pub video_ring: RingBuffer<(f64, Vec<u8>)>,

    // Audio
    pub audio_chunks: Vec<(Vec<f32>, bool)>,
    pub splice_points: Vec<SplicePoint>,
    audio_capture: Option<AudioCapture>,

    // State
    pub current_time: f64,
    start_time: std::time::Instant,
    pub frames_written: u64,
    pub frame_count: u64,
    pub privacy_paused: bool,
    pub next_chunk_is_splice: bool,

    // Dimensions (set by first frame)
    pub capture_width: u32,
    pub capture_height: u32,
    stored_width: u32,
    stored_height: u32,
}

impl Recorder {
    pub fn new(config: RecordingConfig) -> Self {
        let video_capacity = (config.fps as f64 * config.ring_buffer_duration_s) as usize;
        Self {
            config,
            is_recording: false,
            encoder: None,
            final_output_path: None,
            video_ring: RingBuffer::new(video_capacity),
            audio_chunks: Vec::new(),
            splice_points: Vec::new(),
            audio_capture: None,
            current_time: 0.0,
            start_time: std::time::Instant::now(),
            frames_written: 0,
            frame_count: 0,
            privacy_paused: false,
            next_chunk_is_splice: false,
            capture_width: 0,
            capture_height: 0,
            stored_width: 0,
            stored_height: 0,
        }
    }

    pub fn start(&mut self) -> AppResult<()> {
        log::info!("Recorder starting (direct MP4, {}fps)...", self.config.fps);
        self.is_recording = true;
        self.current_time = 0.0;
        self.frames_written = 0;
        self.frame_count = 0;
        self.privacy_paused = false;
        self.start_time = std::time::Instant::now();
        self.video_ring = RingBuffer::new(
            (self.config.fps as f64 * self.config.ring_buffer_duration_s) as usize,
        );
        self.audio_chunks.clear();
        self.splice_points.clear();
        self.next_chunk_is_splice = false;

        // MP4 encoder will be configured on first frame (we need dimensions)
        self.encoder = None;
        self.final_output_path = None;
        self.stored_width = 0;
        self.stored_height = 0;

        // Start WASAPI audio capture
        let mut audio = AudioCapture::new(self.config.audio_source);
        audio.start().map_err(|e| {
            crate::error::AppError::Audio(format!("Audio capture failed: {}", e))
        })?;
        self.audio_capture = Some(audio);

        Ok(())
    }

    /// Ensure encoder is initialized (called on first frame when dimensions are known)
    fn ensure_encoder(&mut self, width: u32, height: u32) -> AppResult<()> {
        if self.encoder.is_some() && self.stored_width == width && self.stored_height == height {
            return Ok(());
        }
        // Close old encoder if any
        if let Some(ref mut enc) = self.encoder {
            let _ = enc.flush();
        }
        self.encoder = None;

        use crate::encoder::types::{EncodeConfig, Codec, QualityPreset};

        let temp_dir = std::env::temp_dir().join("DirectorCam");
        let _ = std::fs::create_dir_all(&temp_dir);
        let path = temp_dir.join(format!("recording_{}.mp4", std::process::id()));

        let mut encoder = crate::encoder::mf::MfEncoder::new_with_path(&path)
            .map_err(|e| crate::error::AppError::Recorder(format!("MF encoder: {}", e)))?;
        let config = EncodeConfig {
            codec: Codec::H264,
            width,
            height,
            fps: 30,
            bitrate: 50_000_000, // 50 Mbps for 4K
            preset: QualityPreset::Balanced,
        };
        encoder.configure(&config)
            .map_err(|e| crate::error::AppError::Recorder(format!("Encoder config: {}", e)))?;

        self.stored_width = width;
        self.stored_height = height;
        self.final_output_path = Some(path.to_string_lossy().to_string());
        self.encoder = Some(Box::new(encoder));
        log::info!("MP4 encoder ready: {}x{} @ 30fps, output: {}",
            width, height, self.final_output_path.as_deref().unwrap_or("?"));
        Ok(())
    }

    pub fn stop(&mut self) -> AppResult<()> {
        log::info!("Recorder stopping... total frames: {}", self.frames_written);
        self.is_recording = false;

        // Flush and finalize encoder
        if let Some(ref mut enc) = self.encoder.take() {
            let _ = enc.flush();
        }

        if let Some(ref mut audio) = self.audio_capture {
            audio.stop();
        }
        self.audio_capture = None;
        Ok(())
    }

    /// Rewind N seconds: close encoder, trim ring buffer, re-encode ring buffer to new file
    pub fn rewind(&mut self, seconds: f64) -> AppResult<()> {
        let fps = self.config.fps as f64;
        let frames_to_drop = (fps * seconds) as usize;

        // Close current encoder
        if let Some(ref mut enc) = self.encoder.take() {
            let _ = enc.flush();
        }

        // Trim ring buffer
        self.video_ring.rewind(frames_to_drop);
        self.frame_count = self.frame_count.saturating_sub(frames_to_drop as u64);
        self.frames_written = self.frame_count;

        // Trim audio
        let audio_samples = (44100.0 * seconds) as usize;
        let mut remaining = audio_samples;
        while remaining > 0 && !self.audio_chunks.is_empty() {
            let last_idx = self.audio_chunks.len() - 1;
            let (ref mut last_data, _) = self.audio_chunks[last_idx];
            if last_data.len() <= remaining {
                remaining -= last_data.len();
                self.audio_chunks.pop();
            } else {
                let new_len = last_data.len() - remaining;
                last_data.truncate(new_len);
                remaining = 0;
            }
        }

        self.current_time = (self.current_time - seconds).max(0.0);
        self.splice_points.push(SplicePoint { pts: self.current_time, needs_crossfade: true });
        self.next_chunk_is_splice = true;

        // Re-create encoder and re-encode ring buffer frames
        if self.stored_width > 0 {
            self.ensure_encoder(self.stored_width, self.stored_height)?;
            if let Some(ref mut enc) = self.encoder {
                let ring_frames: Vec<Vec<u8>> = self.video_ring
                    .drain_all().map(|(_, d)| d).collect();
                for (i, data) in ring_frames.iter().enumerate() {
                    let flipped = flip_bgra_frame(data, self.stored_width, self.stored_height);
                    let t = self.current_time - (ring_frames.len() - i) as f64 / fps + (i as f64 / fps);
                    let _ = enc.encode(&flipped, t);
                    self.video_ring.push((t, data.clone()));
                }
            }
        }

        log::info!("Rewound {}s ({} frames). Remaining: {}", seconds, frames_to_drop, self.frame_count);
        Ok(())
    }

    /// Push a video frame: ring buffer + direct MP4 encode
    pub fn push_video_frame(&mut self, data: Vec<u8>) {
        // Lazy-init encoder with frame dimensions
        if self.stored_width == 0 {
            // Dimensions come from capture pipeline
            let _ = self.ensure_encoder(self.capture_width.max(1), self.capture_height.max(1));
        }

        // Ring buffer
        self.video_ring.push((self.current_time, data.clone()));

        // Direct MP4 encode
        if let Some(ref mut enc) = self.encoder {
            let flipped = flip_bgra_frame(&data, self.stored_width, self.stored_height);
            let _ = enc.encode(&flipped, self.current_time);
        }

        self.frame_count += 1;
        // Use real elapsed time since recording start, not frame-count estimate
        self.current_time = self.start_time.elapsed().as_secs_f64();
        self.frames_written += 1;
    }

    pub fn poll_audio(&mut self) {
        if let Some(ref mut audio) = self.audio_capture {
            if let Ok(samples) = audio.read_samples() {
                if !samples.is_empty() {
                    let is_splice = self.next_chunk_is_splice;
                    self.next_chunk_is_splice = false;
                    self.audio_chunks.push((samples, is_splice));
                }
            }
        }
    }

    pub fn drain_video_frames(&mut self) -> Vec<(f64, Vec<u8>)> {
        self.video_ring.drain_all().collect()
    }

    pub fn get_merged_audio(&self) -> Vec<f32> {
        if self.audio_chunks.is_empty() { return vec![]; }
        let mut result = Vec::new();
        let fade_samples = 441;
        for (i, (chunk, is_splice_start)) in self.audio_chunks.iter().enumerate() {
            if i == 0 || !is_splice_start {
                result.extend_from_slice(chunk);
            } else {
                let before = std::mem::take(&mut result);
                result = crossfade::crossfade(&before, chunk, fade_samples);
            }
        }
        result
    }

    pub fn get_splice_points(&self) -> &[SplicePoint] { &self.splice_points }
}

/// Flip BGRA vertically (top-down to bottom-up for MF RGB32)
fn flip_bgra_frame(data: &[u8], width: u32, height: u32) -> Vec<u8> {
    let row = (width * 4) as usize;
    let total = row * height as usize;
    if data.len() < total { return data.to_vec(); }
    let mut out = vec![0u8; total];
    for y in 0..height as usize {
        let src = y * row;
        let dst = (height as usize - 1 - y) * row;
        out[dst..dst + row].copy_from_slice(&data[src..src + row]);
    }
    out
}

