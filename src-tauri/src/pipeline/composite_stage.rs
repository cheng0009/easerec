//! Composite stage: receives frames, applies overlay effects, forwards to encoder.
//! GPU-first: uses D2D compositor when available, falls back to CPU rayon path.
use std::sync::{Arc, Mutex};
use crossbeam::channel::{Sender, Receiver, TryRecvError};
use crate::compositor::Compositor;
use crate::overlay::RenderCommand;
use super::*;
pub struct CompositeStage {
    frame_rx: Receiver<PipelineFrame>,
    comp_tx: Sender<PipelineFrame>,
    cmd_rx: Receiver<StageCommand>,
    compositor: Compositor,
    /// Current overlay commands (updated via StageCommand)
    overlay_commands: Vec<RenderCommand>,
    /// Magnifier source frame (stored for magnifier rendering)
    magnifier_source: Option<(Vec<u8>, u32, u32)>,
    /// Mosaic regions in normalized coords
    mosaic_regions: Vec<(f32, f32, f32, f32)>,
    /// Webcam overlay: latest BGRA snapshot
    /// Shared webcam frame source (read each tick for live preview in video)
    webcam_frame_src: Option<Arc<Mutex<Option<(Vec<u8>, u32, u32)>>>>,
    /// Webcam overlay configuration
        webcam_config: crate::config::WebcamConfig,
    webcam_frame: Option<(Vec<u8>, u32, u32)>,
    frame_count: u64,
}
impl CompositeStage {
    pub fn new(
        frame_rx: Receiver<PipelineFrame>,
        comp_tx: Sender<PipelineFrame>,
        cmd_rx: Receiver<StageCommand>,
        webcam_frame_src: Option<Arc<Mutex<Option<(Vec<u8>, u32, u32)>>>>,
        webcam_config: crate::config::WebcamConfig,
    ) -> Self {
        Self {
            frame_rx,
            comp_tx,
            cmd_rx,
            compositor: Compositor::new(),
            overlay_commands: Vec::new(),
            magnifier_source: None,
            mosaic_regions: Vec::new(),
            webcam_frame: None,
            webcam_frame_src,
            webcam_config,
            frame_count: 0,
        }
    }
    /// Update the webcam overlay frame from external source
    pub fn set_webcam_frame(&mut self, data: Vec<u8>, w: u32, h: u32) {
        self.webcam_frame = Some((data, w, h));
    }
}
impl Stage for CompositeStage {
    fn name(&self) -> &'static str { "composite" }
    fn on_start(&mut self) -> Result<(), String> {
        log::info!("[composite] Started");
        Ok(())
    }
    fn tick(&mut self) -> Result<bool, String> {
        // Process commands
        loop {
            match self.cmd_rx.try_recv() {
                Ok(StageCommand::Stop) => return Ok(false),
                Ok(StageCommand::UpdateConfig(uc)) => match uc {
                    StageConfigUpdate::OverlayCommands(cmds) => {
                        self.overlay_commands = cmds;
                    }
                    StageConfigUpdate::MosaicRegions(regions) => {
                        self.mosaic_regions = regions;
                    }
                    _ => {}
                },
                Ok(_) => {}
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Ok(false),
            }
        }
        // Receive frame from capture
        let frame = match self.frame_rx.try_recv() {
            Ok(f) => f,
            Err(TryRecvError::Empty) => return Ok(false),
            Err(TryRecvError::Disconnected) => {
                log::info!("[composite] frame_rx disconnected");
                return Ok(false);
            }
        };
        self.frame_count += 1;
        if self.frame_count <= 3 || self.frame_count % 60 == 0 {
            log::info!("[composite] tick: frame #{} ({}x{})", self.frame_count, frame.data.width(), frame.data.height());
        }
        // GPU fast path: if no effects, forward directly (zero-copy pass-through)
        let has_effects = !self.overlay_commands.is_empty();
        let has_mosaic = !self.mosaic_regions.is_empty();
        // Read latest webcam frame from shared source
        if let Some(ref src) = self.webcam_frame_src {
            if let Ok(lf) = src.lock() {
                if let Some((ref data, w, h)) = *lf {
                    self.webcam_frame = Some((data.clone(), w, h));
                }
            }
        }
        let has_webcam = self.webcam_frame.is_some();
        if !has_effects && !has_mosaic && !has_webcam {
            // Fast path: forward unchanged
            if self.frame_count <= 2 {
                log::info!("[composite] Fast-forwarding frame #{} to encode", self.frame_count);
            }
            if self.comp_tx.send(frame).is_err() {
                log::info!("[composite] comp_tx send failed at frame #{}", self.frame_count);
                return Ok(false);
            }
            return Ok(true);
        }
        // Slow path: apply composition
        let (width, height) = (frame.data.width(), frame.data.height());
        // Extract frame data for CPU compositing
        let screen_data = match &frame.data {
            FrameData::Cpu { data, .. } => data.as_ref().clone(),
            FrameData::Gpu { .. } => {
                // GPU path: would read back from texture (TODO: keep on GPU)
                // For now, fall back — the capture stage always produces CPU frames
                log::warn!("[composite] GPU frame with effects: forwarding raw (GPU compositing not yet implemented)");
                if self.comp_tx.send(frame).is_err() {
                    return Ok(false);
                }
                return Ok(true);
            }
        };
        // Store magnifier source
        self.magnifier_source = Some((screen_data.clone(), width, height));
        self.compositor.set_magnifier_source(screen_data.clone(), width, height);
        // Build composite commands: overlay effects + webcam + mosaic passthrough
        let mut all_cmds = self.overlay_commands.clone();
        // Add webcam overlay as BlitImage commands
        if let Some((ref wc_data, wc_w, wc_h)) = self.webcam_frame {
            if wc_w == 0 || wc_h == 0 { /* skip invalid webcam frame */ }
            else {
            let cfg = &self.webcam_config;
            let wc_dst_w = width as f32 * cfg.size_ratio;
            let wc_dst_h = if wc_w > 0 { wc_dst_w * (wc_h as f32 / wc_w as f32) } else { wc_dst_w };
            let margin = 20.0;
            let (dst_x, dst_y) = match cfg.position.as_str() {
                "bottom_right" => (width as f32 - wc_dst_w - margin, height as f32 - wc_dst_h - margin),
                "bottom_left" => (margin, height as f32 - wc_dst_h - margin),
                "top_right" => (width as f32 - wc_dst_w - margin, margin),
                "top_left" => (margin, margin),
                _ => (cfg.custom_x * width as f32, cfg.custom_y * height as f32),
            };
            all_cmds.push(RenderCommand::BlitImage {
                data: wc_data.clone(),
                src_w: wc_w,
                src_h: wc_h,
                dst_x,
                dst_y,
                dst_w: wc_dst_w,
                dst_h: wc_dst_h,
                shape: cfg.shape.clone(),
                corner_radius: cfg.corner_radius,
                border_color: parse_hex_color(&cfg.border_color),
                border_width: cfg.border_width as f32,
            });
            }
        }
        // Composite
        let composited = self.compositor.composite(
            &screen_data,
            width,
            height,
            &all_cmds,
        ).map_err(|e| format!("Composite failed: {}", e))?;
        // Apply mosaic on top
        let mut final_data = composited;
        if has_mosaic {
            crate::commands::apply_mosaic(&mut final_data, width, height, &self.mosaic_regions, 16);
        }
        let out_frame = PipelineFrame {
            data: FrameData::Cpu {
                data: std::sync::Arc::new(final_data),
                width,
                height,
            },
            ..frame
        };
        if self.comp_tx.send(out_frame).is_err() {
            return Ok(false);
        }
        Ok(true)
    }
    fn on_stop(&mut self) {
        log::info!("[composite] Stopped after {} frames", self.frame_count);
    }
    fn should_stop(&self) -> bool { false }
}
/// Parse hex color string (#RRGGBB or #RRGGBBAA) to RGBA tuple
fn parse_hex_color(hex: &str) -> (f32, f32, f32, f32) {
    let hex = hex.trim_start_matches('#');
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255) as f32 / 255.0;
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(255) as f32 / 255.0;
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(255) as f32 / 255.0;
    let a = if hex.len() >= 8 { u8::from_str_radix(&hex[6..8], 16).unwrap_or(255) as f32 / 255.0 } else { 1.0 };
    (r, g, b, a)
}