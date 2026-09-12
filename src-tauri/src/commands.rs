use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Emitter;
use crate::config::AudioSource;
use crate::recorder::Recorder;
use crate::studio::StudioManager;
use crate::overlay::OverlayManager;
use crate::overlay::d2d_overlay::D2DOverlay;
use crate::overlay::rewind_notifier::RewindNotifier;
use crate::webcam::WebcamCapture;
use crate::config::WebcamConfig;
use crate::license::LicenseManager;
use crate::pipeline::{
    Pipeline, AudioChunk, StageCommand, StageConfigUpdate,
    CaptureStage, CompositeStage,
};

pub struct AppState {
    pub shortcut_config: Mutex<crate::config::ShortcutConfig>,
    pub recorder: Mutex<Option<Recorder>>,
    pub is_recording: AtomicBool,
    pub studio: Mutex<StudioManager>,
    pub overlay: Arc<Mutex<OverlayManager>>,
    pub overlay_window: Mutex<D2DOverlay>,
    pub rewind_notifier: Mutex<Option<RewindNotifier>>,
    pub last_saved_path: Mutex<Option<String>>,
    pub audio_source: Mutex<AudioSource>,
    pub webcam: Mutex<WebcamCapture>,
    pub webcam_config: Mutex<WebcamConfig>,
    pub license: Mutex<LicenseManager>,
    pub shared_frame: Arc<Mutex<Option<(Vec<u8>, u32, u32)>>>,
    /// New pipeline-based recording (replaces spawn_recording_pipeline)
    pub pipeline: Mutex<Option<Pipeline>>,
}

impl AppState {
    pub fn new() -> Self {
        let sf: Arc<Mutex<Option<(Vec<u8>, u32, u32)>>> = Arc::new(Mutex::new(None));
        let overlay = Arc::new(Mutex::new(OverlayManager::new()));
        if let Ok(mut ov) = overlay.lock() { ov.set_shared_frame(sf.clone()); }
        // Wire the overlay renderer back into the effect manager so strokes drawn
        // on the live overlay also reach the recorded-video compositor, and the
        // recorded magnifier can follow the cursor.
        let mut ow = D2DOverlay::new();
        ow.set_overlay_sink(overlay.clone());
        Self {
            recorder: Mutex::new(None),
            is_recording: AtomicBool::new(false),
            studio: Mutex::new(StudioManager::new()),
            overlay,
            overlay_window: Mutex::new(ow),
            rewind_notifier: Mutex::new(None),
            shortcut_config: Mutex::new(crate::config::load_shortcut_config()),
            last_saved_path: Mutex::new(None),
            audio_source: Mutex::new(AudioSource::Both),
            webcam: Mutex::new(WebcamCapture::new()),
            webcam_config: Mutex::new(WebcamConfig::default()),
            license: Mutex::new(LicenseManager::new()),
            shared_frame: sf,
            pipeline: Mutex::new(None),
        }
    }
}

// ── Recording Commands (Pipeline-based) ──

#[tauri::command]
pub async fn start_recording(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if state.is_recording.load(Ordering::SeqCst) {
        return Err("Already recording".into());
    }

    log::info!("=== Starting recording pipeline ===");
    state.is_recording.store(true, Ordering::SeqCst);

    // Build pipeline
    let mut pipeline = Pipeline::new();

    let fps = 30u32;
    let ring_duration = 10.0;
    let segment_duration = 30.0; // 30-second segments

    // Take ownership of channels
    let frame_rx = pipeline.frame_rx.take().unwrap();
    let comp_rx = pipeline.comp_rx.take().unwrap();
    let audio_rx = pipeline.audio_rx.take().unwrap();
    let cmd_rx = pipeline.cmd_rx.take().unwrap();

    // Clone senders for stages
    let frame_tx = pipeline.frame_tx.clone();
    let comp_tx = pipeline.comp_tx.clone();
    let audio_tx = pipeline.audio_tx.clone();
    let _cmd_tx = pipeline.cmd_tx.clone();

    // Create stages
    let capture_config = crate::capture::types::CaptureConfig {
        target_fps: fps,
        capture_cursor: true,
        output_monitor: 0,
        crop_rect: None,
    };

    let capture_stage = CaptureStage::new(capture_config, frame_tx, cmd_rx.clone(), Some(app.clone()), pipeline.fps_counter.clone(), pipeline.d3d11_device.clone(), state.shared_frame.clone());
    let webcam_src = state.webcam.lock().map(|w| w.frame_source()).ok();
    let webcam_src = state.webcam.lock().map(|w| w.frame_source()).ok();
    let webcam_cfg = state.webcam_config.lock().map(|c| c.clone()).unwrap_or_default();
    let composite_stage = CompositeStage::new(frame_rx, comp_tx, cmd_rx.clone(), webcam_src, webcam_cfg);
    let encode_stage = crate::pipeline::EncodeStage::new(
        comp_rx, audio_rx, cmd_rx.clone(),
        fps, ring_duration, segment_duration,
        pipeline.d3d11_device.clone(),
    );

    log::info!("[start_recording] Spawning capture stage...");
    pipeline.spawn_stage(capture_stage, Some("cap"));
    log::info!("[start_recording] Spawning composite stage...");
    pipeline.spawn_stage(composite_stage, Some("comp"));
    log::info!("[start_recording] Spawning encode stage...");
    pipeline.spawn_stage(encode_stage, Some("enc"));
    log::info!("[start_recording] All 3 stages spawned");

    // Start audio capture
    {
        let audio_src = *state.audio_source.lock().map_err(|e| format!("audio lock: {}", e))?;
        let mut audio = crate::audio::AudioCapture::new(audio_src);
        audio.start().map_err(|e| format!("Audio start: {}", e))?;

        // Spawn audio bridge: AudioCapture → pipeline audio_tx
        let audio_tx_bridge = audio_tx;
        let audio_stop = pipeline.stop_flag.clone();
        let clock_start = pipeline.clock.as_ref().clone();
        std::thread::spawn(move || {
            // Wait a bit for audio to initialize
            std::thread::sleep(std::time::Duration::from_millis(500));
            loop {
                if audio_stop.load(Ordering::Relaxed) { break; }
                if let Ok(samples) = audio.read_samples() {
                    if !samples.is_empty() {
                        let chunk = AudioChunk {
                            samples: Arc::new(samples),
                            sample_rate: 44100,
                            channels: 1,
                            timestamp_secs: clock_start.elapsed().as_secs_f64(),
                        };
                        let _ = audio_tx_bridge.send(chunk);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            log::info!("[audio-bridge] Stopped");
        });
    }

    // Show overlay if effects active
    {
        let ov = state.overlay.lock().map_err(|e| format!("overlay lock: {}", e))?;
        if ov.needs_overlay() {
            if let Ok(mut ow) = state.overlay_window.lock() { ow.show(); }
        }
    }

    *state.pipeline.lock().map_err(|e| format!("pipeline lock: {}", e))? = Some(pipeline);

    // Emit state
    app.emit("recording-state", crate::events::RecordingStateEvent { is_recording: true })
        .map_err(|e| e.to_string())?;

    // Spawn metrics reporter
    let app_handle = app.clone();
    let metrics = {
        let pl = state.pipeline.lock().map_err(|e| format!("pipeline lock: {}", e))?;
        pl.as_ref().map(|p| p.metrics.clone())
    };
    if let Some(m) = metrics {
        let stop_flag = {
            let pl = state.pipeline.lock().map_err(|e| format!("pipeline lock: {}", e))?;
            pl.as_ref().map(|p| p.stop_flag.clone())
        };
        if let Some(stop) = stop_flag {
            std::thread::spawn(move || {
                loop {
                    if stop.load(Ordering::Relaxed) { break; }
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let metrics = m.lock();
                    let _ = app_handle.emit("perf-update", serde_json::json!({
                        "fps": metrics.capture_fps,
                        "cpu_percent": metrics.cpu_percent,
                        "dropped_frames": metrics.dropped_frames,
                        "encoding_latency_ms": metrics.encode_latency_us as f64 / 1000.0,
                    }));
                }
            });
        }
    }

    log::info!("=== Recording pipeline running ===");
    Ok(())
}

#[tauri::command]
pub async fn stop_recording(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("Not recording".into());
    }

    log::info!("=== Stopping recording pipeline ===");
    state.is_recording.store(false, Ordering::SeqCst);

    // Hide overlay
    if let Ok(mut ow) = state.overlay_window.lock() { ow.hide(); }

    // Deactivate effects
    if let Ok(ov) = state.overlay.lock() {
        ov.toggle_effect("magnifier", false);
        ov.toggle_effect("step_marker", false);
        ov.toggle_effect("highlighter", false);
        ov.toggle_effect("ripple", false);
    }
    // Stop swallowing mouse clicks once recording/effects are cleared.
    crate::overlay::mouse_hook::update(false);

    // Shutdown pipeline
    let saved_path = {
        let mut pl = state.pipeline.lock().map_err(|e| format!("pipeline lock: {}", e))?;
        if let Some(ref mut pipeline) = *pl {
            // Collect segment info before shutdown
            // (the EncodeStage is being shut down; we read segments from disk after)
            let segment_dir = std::env::temp_dir()
                .join("DirectorCam")
                .join(format!("session_{}", std::process::id()));
            pipeline.shutdown();

            // Merge segments into final MP4
            let out_dir = dirs_next::video_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("DirectorCam");
            let _ = std::fs::create_dir_all(&out_dir);
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_else(|_| "0".to_string());
            let final_path = out_dir.join(format!("DirectorCam_{}.mp4", ts));
            let final_str = final_path.to_string_lossy().to_string();

            // Collect segment files
            if segment_dir.exists() {
                let mut segments: Vec<std::path::PathBuf> = Vec::new();
                if let Ok(entries) = std::fs::read_dir(&segment_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().map(|e| e == "mp4").unwrap_or(false) {
                            segments.push(path);
                        }
                    }
                }
                segments.sort();

                if segments.is_empty() {
                    log::warn!("No recording segments found in {}", segment_dir.display());
                    let _ = std::fs::remove_dir_all(&segment_dir);
                    return Err("No recording data found".into());
                }

                if segments.len() == 1 {
                    // Single segment: just move it
                    let _ = std::fs::rename(&segments[0], &final_path);
                } else if segments.len() > 1 {
                    // Multiple segments: concat with ffmpeg if available, else just copy first
                    if let Some(ffmpeg) = crate::commands::find_ffmpeg() {
                        // Write concat file
                        let concat_path = segment_dir.join("concat.txt");
                        let mut concat = String::new();
                        for s in &segments {
                            concat.push_str(&format!("file ''{}''
", s.to_string_lossy().replace("'", "''\''")));
                        }
                        let _ = std::fs::write(&concat_path, concat);
                        let status = std::process::Command::new(&ffmpeg)
                            .args(&["-y", "-f", "concat", "-safe", "0", "-i"])
                            .arg(&concat_path)
                            .args(&["-c", "copy"])
                            .arg(&final_path)
                            .status();
                        if status.map(|s| s.success()).unwrap_or(false) {
                            log::info!("Segments merged with ffmpeg: {}", final_str);
                        } else {
                            // Fallback: just use first segment
                            let _ = std::fs::rename(&segments[0], &final_path);
                        }
                    } else {
                        // No ffmpeg: use first segment
                        let _ = std::fs::rename(&segments[0], &final_path);
                    }
                }

                // Clean up temp dir
                let _ = std::fs::remove_dir_all(&segment_dir);
            } else {
                // No segments created (maybe very short recording)
                log::warn!("No recording segments found");
                return Err("No recording data found".into());
            }

            *state.last_saved_path.lock().map_err(|e| format!("lock: {}", e))? = Some(final_str.clone());
            final_str
        } else {
            return Err("No active pipeline".into());
        }
    };

    *state.pipeline.lock().map_err(|e| format!("pipeline lock: {}", e))? = None;

    app.emit("recording-state", crate::events::RecordingStateEvent { is_recording: false })
        .map_err(|e| e.to_string())?;

    log::info!("=== Recording stopped, saved to: {} ===", saved_path);
    Ok(saved_path)
}

// ── Pipeline control commands ──

#[tauri::command]
pub async fn rewind_recording(
    state: tauri::State<'_, AppState>,
    seconds: f64,
) -> Result<(), String> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("Not recording".into());
    }
    let pl = state.pipeline.lock().map_err(|e| format!("lock: {}", e))?;
    if let Some(ref pipeline) = *pl {
        pipeline.send_command(StageCommand::Rewind(seconds));
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_studio_mode(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let mut studio = state.studio.lock().map_err(|e| format!("lock: {}", e))?;
    if studio.is_active() {
        studio.disable().map_err(|e| format!("{}", e))?;
        Ok(false)
    } else {
        studio.enable().map_err(|e| format!("{}", e))?;
        Ok(true)
    }
}

#[tauri::command]
pub async fn trigger_effect(
    state: tauri::State<'_, AppState>,
    effect: String,
    active: bool,
) -> Result<(), String> {
    if let Ok(ov) = state.overlay.lock() {
        ov.toggle_effect(&effect, active);
    }
    // If recording, update pipeline composite stage
    if state.is_recording.load(Ordering::SeqCst) {
        if let Ok(ov) = state.overlay.lock() {
            let cmds = ov.get_commands_for_compositor();
            if let Ok(pl) = state.pipeline.lock() {
                if let Some(ref pipeline) = *pl {
                    pipeline.send_command(StageCommand::UpdateConfig(
                        StageConfigUpdate::OverlayCommands(cmds)
                    ));
                }
            }
        }
    }
    // Sync overlay window
    crate::sync_overlay_window(&state);
    // Reflect effect state in the global mouse hook (shield the desktop beneath).
    let mut swallow = false;
    if let Ok(ov) = state.overlay.lock() {
        swallow = ov.is_effect_active("highlighter") || ov.is_effect_active("magnifier");
    }
    crate::overlay::mouse_hook::update(swallow);
    Ok(())
}

// ── Export (unchanged, uses legacy post-processor) ──

#[tauri::command]
pub async fn export_video(
    _state: tauri::State<'_, AppState>,
    input_path: String,
    output_path: String,
    config_json: String,
) -> Result<String, String> {
    let config: crate::post::PostConfig = serde_json::from_str(&config_json)
        .map_err(|e| format!("Invalid config: {}", e))?;
    let processor = crate::post::PostProcessor::new(config);
    let result = processor.process(&input_path, &output_path)
        .map_err(|e| format!("Export failed: {}", e))?;
    Ok(result.output_path)
}

#[tauri::command]
pub async fn save_recording(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    save_recording_inner(&state)
}

pub fn save_recording_inner(state: &tauri::State<'_, AppState>) -> Result<String, String> {
    // First: check if stop_recording already saved a file
    if let Ok(last) = state.last_saved_path.lock() {
        if let Some(ref path) = *last {
            if std::path::Path::new(path).exists() {
                log::info!("save_recording: reusing saved path: {}", path);
                return Ok(path.clone());
            } else {
                log::warn!("save_recording: saved path not found on disk: {}", path);
            }
        }
    }

    // Try pipeline-based path first
    if let Ok(pl) = state.pipeline.lock() {
        if let Some(ref _pipeline) = *pl {
            // Pipeline is still running - should have been stopped first
            log::warn!("save_recording called while pipeline active");
        }
    }

    // Fall back to legacy Recorder path
    let mut rec_guard = state.recorder.lock().map_err(|e| format!("lock: {}", e))?;
    if let Some(ref mut rec) = *rec_guard {
        if !rec.is_recording {
            let path_opt = rec.final_output_path.clone();
            *rec_guard = None;
            if let Some(path) = path_opt {
                // Move from temp to output dir
                let out_dir = dirs_next::video_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join("DirectorCam");
                let _ = std::fs::create_dir_all(&out_dir);
                
let ts = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "unknown".to_string());

                let dest = out_dir.join(format!("DirectorCam_{}.mp4", ts));
                if std::fs::rename(&path, &dest).is_ok() {
                    let dest_str = dest.to_string_lossy().to_string();
                    *state.last_saved_path.lock().map_err(|e| format!("lock: {}", e))? = Some(dest_str.clone());
                    return Ok(dest_str);
                }
                return Ok(path);
            }
        }
    }
    Err("No recording to save".into())
}

#[tauri::command]
pub fn get_encoder_info() -> Result<Vec<crate::config::EncoderInfo>, String> {
    let encoders = crate::encoder::types::detect_encoders();
    Ok(encoders.into_iter().map(|e| crate::config::EncoderInfo {
        name: e.name,
        vendor: e.vendor,
        supports_4k: e.supports_4k,
        supports_h265: e.supports_h265,
        is_available: e.is_available,
    }).collect())
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    std::process::Command::new("explorer").arg(&path).spawn().map(|_| ()).map_err(|e| format!("Failed to open: {}", e))
}

// ── Shortcut / Config / Webcam / License commands (unchanged) ──

#[tauri::command]
pub fn get_shortcut_config(state: tauri::State<'_, AppState>) -> Result<crate::config::ShortcutConfig, String> {
    Ok(state.shortcut_config.lock().map_err(|e| format!("lock: {}", e))?.clone())
}

#[tauri::command]
pub fn update_shortcut_config(app: tauri::AppHandle, state: tauri::State<'_, AppState>, cfg: crate::config::ShortcutConfig) -> Result<(), String> {
    crate::config::save_shortcut_config(&cfg).map_err(|e| e.to_string())?;
    *state.shortcut_config.lock().map_err(|e| format!("lock: {}", e))? = cfg;
    crate::reapply_shortcuts(&app)?;
    Ok(())
}

#[tauri::command]
pub async fn set_audio_source(state: tauri::State<'_, AppState>, source: String) -> Result<(), String> {
    let src = match source.as_str() {
        "system" => AudioSource::System,
        "mic" => AudioSource::Mic,
        "both" => AudioSource::Both,
        _ => return Err("Invalid source".into()),
    };
    *state.audio_source.lock().map_err(|e| format!("lock: {}", e))? = src;
    Ok(())
}

#[tauri::command]
pub async fn list_cameras() -> Result<Vec<(usize, String)>, String> {
    Ok(WebcamCapture::list_cameras().into_iter().map(|(i, s)| (i, s)).collect())
}

#[tauri::command]
pub async fn check_ffmpeg() -> Result<bool, String> {
    Ok(find_ffmpeg().is_some())
}

#[tauri::command]
pub async fn set_webcam_config(state: tauri::State<'_, AppState>, config: WebcamConfig) -> Result<(), String> {
    *state.webcam_config.lock().map_err(|e| format!("wc lock: {}", e))? = config;
    Ok(())
}

#[tauri::command]
pub async fn start_webcam(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let config = state.webcam_config.lock().map_err(|e| format!("wc lock: {}", e))?.clone();
    let mut wc = state.webcam.lock().map_err(|e| format!("wc lock: {}", e))?;
    wc.start(config.camera_index, 640, 480).map_err(|e| format!("Webcam: {}", e))
}

#[tauri::command]
pub async fn stop_webcam(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.webcam.lock().map_err(|e| format!("wc lock: {}", e))?.stop();
    Ok(())
}

#[tauri::command]
pub fn check_license(state: tauri::State<'_, AppState>) -> Result<crate::license::LicenseData, String> {
    Ok(state.license.lock().map_err(|e| e.to_string())?.data().clone())
}

#[tauri::command]
pub fn activate_license(state: tauri::State<'_, AppState>, key: String) -> Result<bool, String> {
    state.license.lock().map_err(|e| e.to_string())?.activate_key(&key)
}

#[tauri::command]
pub async fn activate_store_license(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    if crate::store_license::is_store_app() {
        state.license.lock().map_err(|e| e.to_string())?.activate_store()?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn is_store_app() -> bool { crate::store_license::is_store_app() }

#[tauri::command]
pub fn generate_pro_key() -> Result<String, String> {
    Ok(crate::license::LicenseManager::generate_pro_key())
}

#[tauri::command]
pub async fn toggle_privacy_pause(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let paused = {
        let ov = state.overlay.lock().map_err(|e| format!("overlay lock: {}", e))?;
        let currently = ov.is_privacy_paused();
        ov.set_privacy_paused(!currently);
        !currently
    };

    if let Ok(pl) = state.pipeline.lock() {
        if let Some(ref pipeline) = *pl {
            if paused {
                pipeline.send_command(StageCommand::Pause);
            } else {
                pipeline.send_command(StageCommand::Resume);
            }
        }
    }

    Ok(paused)
}

// ── Utility functions ──

/// Apply mosaic pixelation to frame regions
pub fn apply_mosaic(frame: &mut [u8], width: u32, height: u32, regions: &[(f32, f32, f32, f32)], block_size: u32) {
    if regions.is_empty() { return; }
    let bs = block_size.max(4);
    for &(x1, y1, x2, y2) in regions {
        let px1 = (x1 * width as f32).max(0.0) as u32;
        let py1 = (y1 * height as f32).max(0.0) as u32;
        let px2 = (x2 * width as f32).min(width as f32) as u32;
        let py2 = (y2 * height as f32).min(height as f32) as u32;
        if px2 <= px1 || py2 <= py1 { continue; }

        let mut by = py1;
        while by < py2 {
            let bh = bs.min(py2 - by);
            let mut bx = px1;
            while bx < px2 {
                let bw = bs.min(px2 - bx);
                let mut sr: u64 = 0; let mut sg: u64 = 0; let mut sb: u64 = 0;
                let mut count: u64 = 0;
                for y in by..by+bh {
                    let row_off = (y * width * 4) as usize;
                    for x in bx..bx+bw {
                        let off = row_off + (x * 4) as usize;
                        sb += frame[off] as u64;
                        sg += frame[off+1] as u64;
                        sr += frame[off+2] as u64;
                        count += 1;
                    }
                }
                if count == 0 { bx += bw; continue; }
                let (ar, ag, ab) = ((sr/count) as u8, (sg/count) as u8, (sb/count) as u8);
                for y in by..by+bh {
                    let row_off = (y * width * 4) as usize;
                    for x in bx..bx+bw {
                        let off = row_off + (x * 4) as usize;
                        frame[off] = ab;
                        frame[off+1] = ag;
                        frame[off+2] = ar;
                    }
                }
                bx += bw;
            }
            by += bh;
        }
    }
}

pub fn find_ffmpeg() -> Option<String> {
    use std::process::Command;
    if let Ok(output) = Command::new("where").arg("ffmpeg").output() {
        if output.status.success() {
            return String::from_utf8(output.stdout).ok().map(|s| s.trim().to_string());
        }
    }
    let exe_dir = std::env::current_exe().ok()?;
    let bundled = exe_dir.parent()?.join("ffmpeg.exe");
    if bundled.exists() { return Some(bundled.to_string_lossy().to_string()); }
    None
}




