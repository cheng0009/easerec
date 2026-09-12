//! Capture stage: DXGI Desktop Duplication → PipelineFrames.
//! Runs on its own thread, pushing frames into the pipeline channel.

use crossbeam::channel::{Sender, Receiver, TryRecvError};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use crate::capture::windows::DxgiCapture;
use crate::capture::ScreenCapture;
use crate::capture::types::CaptureConfig;
use std::sync::Arc;
use parking_lot::Mutex as PlMutex;

use super::*;

pub struct CaptureStage {
    capture: DxgiCapture,
    config: CaptureConfig,
    frame_tx: Sender<PipelineFrame>,
    cmd_rx: Receiver<StageCommand>,
    frame_count: u64,
    paused: bool,
    start_time: Option<std::time::Instant>,
    /// Shared GPU texture for pipeline zero-copy path
    shared_texture: Option<ID3D11Texture2D>,
    gpu_path_enabled: bool,
    d3d11_device: Arc<parking_lot::Mutex<Option<usize>>>,
    fps_counter: Arc<std::sync::atomic::AtomicU64>,
    app_handle: Option<tauri::AppHandle>,
    /// Shared frame buffer for UI preview (downscaled RGB)
    shared_frame: Arc<std::sync::Mutex<Option<(Vec<u8>, u32, u32)>>>,
}

impl CaptureStage {
    pub fn new(
        config: CaptureConfig,
        frame_tx: Sender<PipelineFrame>,
        cmd_rx: Receiver<StageCommand>,
        app_handle: Option<tauri::AppHandle>,
        fps_counter: Arc<std::sync::atomic::AtomicU64>,
        d3d11_device: Arc<PlMutex<Option<usize>>>,
        shared_frame: Arc<std::sync::Mutex<Option<(Vec<u8>, u32, u32)>>>,
    ) -> Self {
        Self {
            capture: DxgiCapture::new(),
            config,
            frame_tx,
            cmd_rx,
            frame_count: 0,
            paused: false,
            start_time: None,
            shared_texture: None,
            gpu_path_enabled: false,
            fps_counter,
            d3d11_device,
            app_handle,
            shared_frame,
        }
    }
}

impl Stage for CaptureStage {
    fn name(&self) -> &'static str { "capture" }

    fn on_start(&mut self) -> Result<(), String> {
        let mut init_attempts = 0;
        loop {
            init_attempts += 1;
            self.capture.start(self.config.clone())
                .map_err(|e| format!("DXGI start attempt {}: {}", init_attempts, e))?;

            std::thread::sleep(std::time::Duration::from_millis(300));

            match self.capture.validate_pipeline() {
                Ok(()) => {
                    log::info!("[capture] DXGI validated on attempt {}", init_attempts);
                    break;
                }
                Err(e) => {
                    log::warn!("[capture] Validation failed: {}", e);
                    let _ = self.capture.stop();
                    self.capture = DxgiCapture::new();
                }
            }
        }

        // Create shared GPU texture for zero-copy pipeline
        let w = self.capture.capture_width();
        let h = self.capture.capture_height();
        if w > 0 && h > 0 {
            match self.capture.create_shared_texture(w, h) {
                Ok(tex) => {
                    self.shared_texture = Some(tex);
                    log::info!("[capture] GPU shared texture created: {}x{}", w, h);
                }
                Err(e) => {
                    log::warn!("[capture] GPU texture creation failed (falling back to CPU): {}", e);
                    self.gpu_path_enabled = false;
                }
            }
        } else {
            self.gpu_path_enabled = false;
        }

        // Share D3D11 device with pipeline
        if let Some(device) = self.capture.get_device() {
            let ptr = device as *const _ as usize;
            *self.d3d11_device.lock() = Some(ptr);
            log::info!("[capture] D3D11 device shared: 0x{:x}", ptr);
        }

        self.start_time = Some(std::time::Instant::now());
        self.frame_count = 0;
        log::info!("[capture] Started: {}x{} (gpu={})", w, h, self.gpu_path_enabled);
        Ok(())
    }

    fn tick(&mut self) -> Result<bool, String> {
        // Process commands
        loop {
            match self.cmd_rx.try_recv() {
                Ok(StageCommand::Stop) => return Ok(false),
                Ok(StageCommand::Pause) => { self.paused = true; }
                Ok(StageCommand::Resume) => { self.paused = false; }
                Ok(_) => { /* forwarded to next stage(s) */ }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Ok(false),
            }
        }

        if self.paused {
            std::thread::sleep(std::time::Duration::from_millis(5));
            return Ok(false);
        }

        let ts = self.start_time
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);

        // ?? GPU path: acquire texture, copy to shared, pass handle downstream ??
        if self.gpu_path_enabled {
            match self.capture.next_frame_texture() {
                Ok(Some((desktop_tex, cursor_pos))) => {
                    self.frame_count += 1;
        self.fps_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let w = self.capture.capture_width();
                    let h = self.capture.capture_height();

                    // Copy desktop texture to shared texture (GPU?GPU, fast)
                    if let (Some(ref shared), Some(ctx)) = (&self.shared_texture, self.capture.get_context()) {
                        unsafe {
                            // Use CopySubresourceRegion or CopyResource
                            // Both textures are on the same device, so CopyResource works
                            ctx.CopyResource(shared, &desktop_tex);
                        }
                    }

                    // desktop_tex is released when it goes out of scope (DXGI frame released by FrameGuard)

                    // Build GPU frame referencing the shared texture
                    let pf = PipelineFrame {
                        data: FrameData::Gpu {
                            texture_ptr: self.shared_texture.as_ref()
                                .map(|t| t as *const _ as usize)
                                .unwrap_or(0),
                            width: w,
                            height: h,
                        },
                        timestamp_secs: ts,
                        frame_number: self.frame_count,
                        cursor_pos,
                    };

                    match self.frame_tx.try_send(pf) { Ok(()) => {} Err(crossbeam::channel::TrySendError::Full(_)) => { /* drop frame, downstream can't keep up */ } Err(crossbeam::channel::TrySendError::Disconnected(_)) => { log::info!("[capture] Downstream closed, stopping"); return Err("Downstream closed".into()); } }
                    return Ok(true);
                }
                Ok(None) => return Ok(false),
                Err(e) => {
                    log::warn!("[capture] GPU path error: {}, falling back to CPU", e);
                    self.gpu_path_enabled = false;
                    // Fall through to CPU path below
                }
            }
        }

        // ?? CPU fallback: map texture to system memory ??
        match self.capture.next_frame() {
            Ok(Some(frame)) => {
                self.frame_count += 1;
        self.fps_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

                // Write downscaled frame to shared preview buffer (every 3rd frame for perf)
                // Note: frame.data is BGRA (4 bytes/pixel, DXGI format B8G8R8A8_UNORM)
                if self.frame_count % 3 == 0 {
                    let preview_w = 640u32;
                    let preview_h = (preview_w as u64 * frame.height as u64 / frame.width as u64) as u32;
                    let preview_h = if preview_h < 1 { 1 } else { preview_h };
                    let mut preview_data = vec![0u8; (preview_w * preview_h * 3) as usize];
                    let x_ratio = frame.width as f64 / preview_w as f64;
                    let y_ratio = frame.height as f64 / preview_h as f64;
                    let src_stride = frame.width as usize * 4;
                    for py in 0..preview_h {
                        for px in 0..preview_w {
                            let sx = (px as f64 * x_ratio) as usize;
                            let sy = (py as f64 * y_ratio) as usize;
                            let src_idx = sy * src_stride + sx * 4;
                            if src_idx + 3 < frame.data.len() {
                                let dst_idx = ((py * preview_w + px) * 3) as usize;
                                // BGRA ? RGB: B=src[0], G=src[1], R=src[2]
                                preview_data[dst_idx] = frame.data[src_idx + 2];     // R
                                preview_data[dst_idx + 1] = frame.data[src_idx + 1]; // G
                                preview_data[dst_idx + 2] = frame.data[src_idx];     // B
                            }
                        }
                    }
                    if let Ok(mut sf) = self.shared_frame.lock() {
                        *sf = Some((preview_data, preview_w, preview_h));
                    }
                }

                let pf = PipelineFrame {
                    data: FrameData::Cpu {
                        data: std::sync::Arc::new(frame.data),
                        width: frame.width,
                        height: frame.height,
                    },
                    timestamp_secs: ts,
                    frame_number: self.frame_count,
                    cursor_pos: frame.cursor_pos,
                };

                match self.frame_tx.try_send(pf) { Ok(()) => {} Err(crossbeam::channel::TrySendError::Full(_)) => { /* drop frame, downstream can't keep up */ } Err(crossbeam::channel::TrySendError::Disconnected(_)) => { log::info!("[capture] Downstream closed, stopping"); return Err("Downstream closed".into()); } }
                Ok(true)
            }
            Ok(None) => Ok(false),
            Err(e) => {
                log::warn!("[capture] DXGI error: {}, attempting reconnect", e);
                let _ = self.capture.stop();
                self.capture = DxgiCapture::new();
                if let Err(e2) = self.capture.start(self.config.clone()) {
                    return Err(format!("DXGI reconnect failed: {}", e2));
                }
                Ok(false)
            }
        }
    }

    fn on_stop(&mut self) {
        let _ = self.capture.stop();
        log::info!("[capture] Stopped after {} frames", self.frame_count);
    }

    fn should_stop(&self) -> bool { false }
}


