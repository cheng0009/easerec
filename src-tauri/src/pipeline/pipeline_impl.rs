//! Pipeline orchestrator: manages the graph of stages with lifecycle and backpressure.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use crossbeam::channel::{self, Sender, Receiver};
use parking_lot::Mutex;
use super::types::*;

/// Orchestrates a graph of stages connected by bounded channels.
pub struct Pipeline {
    /// FPS counter incremented by capture stage
    pub fps_counter: Arc<std::sync::atomic::AtomicU64>,
    /// Shared D3D11 device pointer (set by CaptureStage, used by EncodeStage)
    pub d3d11_device: Arc<parking_lot::Mutex<Option<usize>>>,
    /// Shared clock: set when recording starts, used for A/V PTS sync
    pub clock: Arc<std::time::Instant>,
    pub stop_flag: Arc<AtomicBool>,
    pub frame_tx: Sender<PipelineFrame>,
    pub frame_rx: Option<Receiver<PipelineFrame>>,
    pub comp_tx: Sender<PipelineFrame>,
    pub comp_rx: Option<Receiver<PipelineFrame>>,
    pub audio_tx: Sender<AudioChunk>,
    pub audio_rx: Option<Receiver<AudioChunk>>,
    pub cmd_tx: Sender<StageCommand>,
    pub cmd_rx: Option<Receiver<StageCommand>>,
    pub metrics: Arc<Mutex<PipelineMetrics>>,
    handles: Vec<std::thread::JoinHandle<()>>,
}

impl Pipeline {
    pub fn new() -> Self {
        let (frame_tx, frame_rx) = channel::bounded(MAX_FRAMES_IN_FLIGHT);
        let (comp_tx, comp_rx) = channel::bounded(MAX_FRAMES_IN_FLIGHT);
        let (audio_tx, audio_rx) = channel::bounded(64);
        let (cmd_tx, cmd_rx) = channel::bounded(16);

        Self {
            clock: Arc::new(std::time::Instant::now()),
            fps_counter: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            d3d11_device: Arc::new(parking_lot::Mutex::new(None)),
            stop_flag: Arc::new(AtomicBool::new(false)),
            frame_tx, frame_rx: Some(frame_rx),
            comp_tx, comp_rx: Some(comp_rx),
            audio_tx, audio_rx: Some(audio_rx),
            cmd_tx, cmd_rx: Some(cmd_rx),
            metrics: Arc::new(Mutex::new(PipelineMetrics::default())),
            handles: Vec::new(),
        }
    }

    pub fn spawn_stage<S: Stage + 'static>(&mut self, mut stage: S, name_override: Option<&str>) {
        let name = name_override.map(|s| s.to_string()).unwrap_or_else(|| stage.name().to_string());
        let name_clone = name.clone();
        let name_clone2 = name.clone();
        let stop = self.stop_flag.clone();

        log::info!("[pipeline] Spawning stage: {}", name);

        let handle = std::thread::Builder::new()
            .name(name.clone())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    log::info!("[{}] Thread started", name_clone);
                    if let Err(e) = stage.on_start() {
                        log::error!("[{}] on_start failed: {}", name_clone, e);
                        return;
                    }
                    log::info!("[{}] Entering tick loop", name_clone);
                    loop {
                        if stop.load(Ordering::Relaxed) || stage.should_stop() { break; }
                        match stage.tick() {
                            Ok(true) => {}
                            Ok(false) => { std::thread::sleep(std::time::Duration::from_millis(1)); }
                            Err(e) => {
                                log::error!("[{}] tick error: {}", name_clone, e);
                                stop.store(true, Ordering::Relaxed);
                                break;
                            }
                        }
                    }
                    log::info!("[{}] Stopping", name_clone);
                    stage.on_stop();
                    log::info!("[{}] Stopped", name_clone);
                }));
                if let Err(panic_err) = result {
                    let msg = if let Some(s) = panic_err.downcast_ref::<&str>() {
                        s.to_string()
                    } else if let Some(s) = panic_err.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "Unknown panic".to_string()
                    };
                    log::error!("[{}] PANICKED: {}", name_clone2, msg);
                }
            });

        match handle {
            Ok(h) => {
                log::info!("[pipeline] Stage '{}' spawned successfully", name);
                self.handles.push(h);
            }
            Err(e) => log::error!("[pipeline] Failed to spawn stage '{}': {}", name, e),
        }
    }

    pub fn send_command(&self, cmd: StageCommand) {
        let _ = self.cmd_tx.send(cmd);
    }

    pub fn shutdown(&mut self) {
        log::info!("Pipeline: shutdown signal");
        self.stop_flag.store(true, Ordering::Relaxed);
        let _ = self.cmd_tx.send(StageCommand::Stop);
        let handles = std::mem::take(&mut self.handles);
        for h in handles {
            let _ = h.join();
        }
        log::info!("Pipeline: all stages joined");
    }

    pub fn is_stopping(&self) -> bool {
        self.stop_flag.load(Ordering::Relaxed)
    }
}



