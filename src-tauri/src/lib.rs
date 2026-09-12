pub mod error;
pub mod config;
pub mod commands;
pub mod events;

pub mod capture;
pub mod encoder;
pub mod compositor;
pub mod overlay;
pub mod audio;
pub mod recorder;
pub mod studio;
pub mod ai;
pub mod post;
pub mod webcam;
pub mod pipeline;
pub mod license;
pub mod store_license;
pub mod utils;

use tauri::{Manager, Emitter};
use config::ShortcutEntry;

macro_rules! slock {
    ($mutex:expr) => {
        match $mutex.lock() {
            Ok(g) => g,
            Err(e) => {
                log::error!("Mutex poisoned: {}", e);
                panic!("Critical mutex failure");
            }
        }
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() { s.to_string() }
        else if let Some(s) = info.payload().downcast_ref::<String>() { s.clone() }
        else { "Unknown panic".to_string() };
        let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        log::error!("PANIC at {}: {}", loc, msg);
        default_hook(info);
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::new())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Low-level mouse hook: swallows clicks while the highlighter is
            // drawing during a recording (so the presenter can annotate without
            // operating the windows underneath).
            crate::overlay::mouse_hook::install();
            log::info!("[build] DirectorCam {} overlay-build-v2 (mouse_hook + WDA lens)", env!("CARGO_PKG_VERSION"));

            // Create overlay window on main thread (raw Win32, no WebView)
            // overlay window created lazily on first show()
            // Wire webcam frame source to overlay for on-screen preview
            {
                let handle = app.handle().clone();
                let src = handle.state::<commands::AppState>().webcam.lock().ok().map(|w| w.frame_source());
                if let Some(wc_src) = src {
                    if let Ok(mut ow) = handle.state::<commands::AppState>().overlay_window.lock() {
                        ow.set_webcam_source(wc_src);
                    }
                }
            }

            // Spawn periodic UI emitter thread (preview frames + timer + perf + overlay sync)
            {
                let handle = app.handle().clone();
                let shared_frame = handle.state::<commands::AppState>().shared_frame.clone();
                std::thread::spawn(move || {
                    let mut rec_start: Option<std::time::Instant> = None;
                    let mut was_recording = false;
                    let mut tick: u64 = 0;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        tick += 1;
                        let s = handle.state::<commands::AppState>();
                        let is_rec = s.is_recording.load(std::sync::atomic::Ordering::SeqCst);

                        // Detect recording state transition
                        if is_rec && !was_recording {
                            rec_start = Some(std::time::Instant::now());
                        }
                        was_recording = is_rec;

                        if !is_rec {
                            continue;
                        }

                        // Emit elapsed time
                        let elapsed_ms = rec_start.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
                        let _ = handle.emit("time-update", crate::events::TimeUpdate { elapsed_ms });

                        // Emit preview frame
                        if let Ok(sf) = shared_frame.lock() {
                            if let Some((ref data, w, h)) = *sf {
                                use base64::Engine;
                                let b64 = base64::engine::general_purpose::STANDARD.encode(data);
                                let _ = handle.emit("preview-frame", crate::events::PreviewFrameEvent {
                                    data: b64,
                                    width: w,
                                    height: h,
                                });
                            }
                        }

                        // Sync overlay window periodically (every ~500ms) for webcam display
                        if tick % 5 == 0 {
                            sync_overlay_window(&s);
                        }
                    }
                });
            }
            use tauri_plugin_global_shortcut::{ShortcutState, Code};
            use std::sync::atomic::Ordering;

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app_handle, shortcut, event| {
                        if event.state != ShortcutState::Pressed { return; }

                        use std::sync::Mutex;
                        static LAST_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);
                        {
                            let mut last = LAST_TIME.lock().unwrap();
                            let now = std::time::Instant::now();
                            if let Some(t) = *last {
                                if now.duration_since(t).as_millis() < 300 { return; }
                            }
                            *last = Some(now);
                        }
                        let s = app_handle.state::<commands::AppState>();
                        let cfg = slock!(s.shortcut_config).clone();

                        if shortcut.key == Code::Escape && shortcut.mods.is_empty() {
                            if let Ok(ov) = s.overlay.lock() {
                                ov.toggle_effect("magnifier", false);
                                ov.toggle_effect("step_marker", false);
                                ov.toggle_effect("highlighter", false);
                                ov.toggle_effect("ripple", false);
                            }
                            crate::overlay::mouse_hook::update(false);
                            if let Ok(mut ow) = s.overlay_window.lock() { ow.hide(); }
                            log::info!("Esc: all effects deactivated");
                            return;
                        }

                        let matches = |entry: &ShortcutEntry| -> bool {
                            shortcut.key == parse_code(&entry.key)
                                && shortcut.mods == parse_mods(&entry.modifiers)
                        };

                        if matches(&cfg.toggle_recording) {
                            let is_rec = s.is_recording.load(Ordering::SeqCst);
                            if is_rec {
                                // Stop recording - delegate to frontend which calls stop_recording command
                                // (stop_recording handles pipeline shutdown, effect cleanup, segment merge, and file save)
                                let _ = app_handle.emit("recording-state", crate::events::RecordingStateEvent { is_recording: false });
                                log::info!("Recording stop triggered via shortcut");
                            } else {
                                // Start: emit event; frontend calls start_recording command
                                let _ = app_handle.emit("recording-state", crate::events::RecordingStateEvent { is_recording: true });
                                log::info!("Recording start triggered via shortcut");
                            }
                        }
                        else if matches(&cfg.rewind_3s) {
                            if let Ok(mut rec) = s.recorder.lock() {
                                if let Some(ref mut r) = *rec { let _ = r.rewind(3.0); }
                            }
                            // Show notification via standalone window (never captured in video)
                            if let Ok(mut nf) = s.rewind_notifier.lock() {
                                if nf.is_none() {
                                    *nf = crate::overlay::rewind_notifier::RewindNotifier::new();
                                }
                                if let Some(ref nf) = *nf {
                                    nf.show("\u{23EA} \u{540E}\u{9000} 3 \u{79D2}");
                                }
                            }
                        }
                        else if matches(&cfg.rewind_5s) {
                            if let Ok(mut rec) = s.recorder.lock() {
                                if let Some(ref mut r) = *rec { let _ = r.rewind(5.0); }
                            }
                            // Show notification via standalone window (never captured in video)
                            if let Ok(mut nf) = s.rewind_notifier.lock() {
                                if nf.is_none() {
                                    *nf = crate::overlay::rewind_notifier::RewindNotifier::new();
                                }
                                if let Some(ref nf) = *nf {
                                    nf.show("\u{23EA} \u{540E}\u{9000} 5 \u{79D2}");
                                }
                            }
                        }
                        else if matches(&cfg.toggle_studio) {
                            if let Ok(mut studio) = s.studio.lock() {
                                if studio.is_active() { let _ = studio.disable(); }
                                else { let _ = studio.enable(); }
                            }
                        }
                        else if matches(&cfg.toggle_magnifier) {
                            let active = !s.overlay.lock().map(|ov| ov.is_effect_active("magnifier")).unwrap_or(false);
                            if let Ok(ov) = s.overlay.lock() { ov.toggle_effect("magnifier", active); }
                            sync_overlay_window(&s);
                            log::info!("Effect magnifier toggled via shortcut to {}", active);
                        }
                        else if matches(&cfg.toggle_step_marker) {
                            let active = !s.overlay.lock().map(|ov| ov.is_effect_active("step_marker")).unwrap_or(false);
                            if let Ok(ov) = s.overlay.lock() { ov.toggle_effect("step_marker", active); }
                            // When enabling step_marker, drop first marker at current cursor position
                            if active {
                                let mut pt = windows::Win32::Foundation::POINT { x: 0, y: 0 };
                                unsafe { let _ = windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut pt); }
                                let screen_w = unsafe { windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(windows::Win32::UI::WindowsAndMessaging::SM_CXSCREEN) };
                                let screen_h = unsafe { windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(windows::Win32::UI::WindowsAndMessaging::SM_CYSCREEN) };
                                if let Ok(ov) = s.overlay.lock() {
                                    ov.add_step_marker(pt.x as f32 / screen_w as f32, pt.y as f32 / screen_h as f32);
                                }
                            }
                            sync_overlay_window(&s);
                            log::info!("Effect step_marker toggled via shortcut to {}", active);
                        }
                        else if matches(&cfg.toggle_highlighter) {
                            let active = !s.overlay.lock().map(|ov| ov.is_effect_active("highlighter")).unwrap_or(false);
                            if let Ok(ov) = s.overlay.lock() { ov.toggle_effect("highlighter", active); }
                            crate::overlay::mouse_hook::update(active);
                            sync_overlay_window(&s);
                            log::info!("Effect highlighter toggled via shortcut to {}", active);
                        }
                        else if matches(&cfg.toggle_ripple) {
                            let active = !s.overlay.lock().map(|ov| ov.is_effect_active("ripple")).unwrap_or(false);
                            if let Ok(ov) = s.overlay.lock() { ov.toggle_effect("ripple", active); }
                            sync_overlay_window(&s);
                            log::info!("Effect ripple toggled via shortcut to {}", active);
                        }
                        else if matches(&cfg.zoom_cycle) {
                            if let Ok(ov) = s.overlay.lock() {
                                if ov.is_effect_active("magnifier") { ov.cycle_zoom(); }
                            }
                        }
                        else if matches(&cfg.zoom_level_1) {
                            if let Ok(ov) = s.overlay.lock() {
                                if ov.is_effect_active("magnifier") { ov.set_zoom(1); }
                            }
                        }
                        else if matches(&cfg.zoom_level_2) {
                            if let Ok(ov) = s.overlay.lock() {
                                if ov.is_effect_active("magnifier") { ov.set_zoom(2); }
                            }
                        }
                        else if matches(&cfg.zoom_level_3) {
                            if let Ok(ov) = s.overlay.lock() {
                                if ov.is_effect_active("magnifier") { ov.set_zoom(3); }
                            }
                        }
                        else if matches(&cfg.toggle_privacy) {
                            use crate::overlay::PrivacyPhase;
                            if let Ok(ov) = s.overlay.lock() {
                                let phase = ov.get_privacy_phase();
                                match phase {
                                    PrivacyPhase::Inactive => {
                                        ov.set_privacy_paused(true);
                                        ov.set_privacy_phase(PrivacyPhase::Adjust);
                                        ov.clear_mosaic_regions();
                                        if let Ok(mut rec) = s.recorder.lock() {
                                            if let Some(ref mut r) = *rec {
                                                r.privacy_paused = true;
                                            }
                                        }
                                        log::info!("Privacy: Adjust phase");
                                    }
                                    PrivacyPhase::Adjust => {
                                        let offset = ov.get_privacy_rewind_offset();
                                        if let Ok(mut rec) = s.recorder.lock() {
                                            if let Some(ref mut r) = *rec {
                                                let _ = r.rewind(offset);
                                            }
                                        }
                                        ov.set_privacy_phase(PrivacyPhase::Mosaic);
                                        log::info!("Privacy: Mosaic phase (rewound {}s)", offset);
                                    }
                                    PrivacyPhase::Mosaic => {
                                        ov.set_privacy_paused(false);
                                        ov.set_privacy_phase(PrivacyPhase::Inactive);
                                        if let Ok(mut rec) = s.recorder.lock() {
                                            if let Some(ref mut r) = *rec {
                                                r.privacy_paused = false;
                                            }
                                        }
                                        log::info!("Privacy: Recording resumed");
                                    }
                                }
                            }
                        }
                    })
                    .build(),
            )?;

            crate::reapply_shortcuts(app.handle())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    create_overlay_window(&app);
            log::info!("DirectorCam ready. Alt+Q/W/E/R=Effects Esc=Exit Tab/1-3=Zoom");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_recording, commands::stop_recording, commands::toggle_studio_mode,
            commands::rewind_recording, commands::trigger_effect, commands::export_video,
            commands::save_recording, commands::get_encoder_info, commands::open_folder,
            commands::get_shortcut_config, commands::update_shortcut_config,
            commands::set_audio_source, commands::list_cameras, commands::check_ffmpeg,
            commands::set_webcam_config, commands::start_webcam, commands::stop_webcam,
            commands::check_license, commands::activate_license, commands::activate_store_license,
            commands::is_store_app, commands::toggle_privacy_pause, commands::generate_pro_key,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start Tauri application");
}

fn create_overlay_window(app: &tauri::App) {
    let handle = app.handle().clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let st = handle.state::<commands::AppState>();
        let mut ow = st.overlay_window.lock().unwrap();
        ow.init();
    }));
    if let Err(e) = result {
        let msg = if let Some(s) = e.downcast_ref::<&str>() { s.to_string() }
            else if let Some(s) = e.downcast_ref::<String>() { s.clone() }
            else { "unknown panic".to_string() };
        log::error!("[D2D] create_overlay_window panicked: {}", msg);
    }
}

fn parse_code(s: &str) -> tauri_plugin_global_shortcut::Code {
    use tauri_plugin_global_shortcut::Code;
    match s {
        "F1"=>Code::F1,"F2"=>Code::F2,"F3"=>Code::F3,"F4"=>Code::F4,"F5"=>Code::F5,"F6"=>Code::F6,
        "F7"=>Code::F7,"F8"=>Code::F8,"F9"=>Code::F9,"F10"=>Code::F10,"F11"=>Code::F11,"F12"=>Code::F12,
        "Tab"=>Code::Tab,"Escape"=>Code::Escape,
        "Digit1"=>Code::Digit1,"Digit2"=>Code::Digit2,"Digit3"=>Code::Digit3,"Digit4"=>Code::Digit4,
        "Digit5"=>Code::Digit5,"Digit6"=>Code::Digit6,"Digit7"=>Code::Digit7,"Digit8"=>Code::Digit8,
        "Digit9"=>Code::Digit9,"Digit0"=>Code::Digit0,
        "KeyA"=>Code::KeyA,"KeyB"=>Code::KeyB,"KeyC"=>Code::KeyC,"KeyD"=>Code::KeyD,"KeyE"=>Code::KeyE,
        "KeyF"=>Code::KeyF,"KeyG"=>Code::KeyG,"KeyH"=>Code::KeyH,"KeyI"=>Code::KeyI,"KeyJ"=>Code::KeyJ,
        "KeyK"=>Code::KeyK,"KeyL"=>Code::KeyL,"KeyM"=>Code::KeyM,"KeyN"=>Code::KeyN,"KeyO"=>Code::KeyO,
        "KeyP"=>Code::KeyP,"KeyQ"=>Code::KeyQ,"KeyR"=>Code::KeyR,"KeyS"=>Code::KeyS,"KeyT"=>Code::KeyT,
        "KeyU"=>Code::KeyU,"KeyV"=>Code::KeyV,"KeyW"=>Code::KeyW,"KeyX"=>Code::KeyX,"KeyY"=>Code::KeyY,
        "KeyZ"=>Code::KeyZ,
        _=>Code::F9,
    }
}

fn parse_mods(strings: &[String]) -> tauri_plugin_global_shortcut::Modifiers {
    use tauri_plugin_global_shortcut::Modifiers;
    let mut m = Modifiers::empty();
    for s in strings {
        match s.as_str() {
            "CONTROL"|"CTRL" => m |= Modifiers::CONTROL,
            "ALT" => m |= Modifiers::ALT,
            "SHIFT" => m |= Modifiers::SHIFT,
            "SUPER"|"META"|"WIN" => m |= Modifiers::SUPER,
            _ => {}
        }
    }
    m
}

fn entry_to_shortcut(entry: &ShortcutEntry) -> tauri_plugin_global_shortcut::Shortcut {
    use tauri_plugin_global_shortcut::Shortcut;
    let code = parse_code(&entry.key);
    let mods = parse_mods(&entry.modifiers);
    Shortcut::new(if mods.is_empty() { None } else { Some(mods) }, code)
}

/// (Re)register every configurable shortcut plus the global Escape hook.
/// Used both at startup and after the user saves a new shortcut config so the
/// changes take effect immediately without an app restart.
pub(crate) fn reapply_shortcuts(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, Code};
    let sc = app.global_shortcut();
    sc.unregister_all().map_err(|e| e.to_string())?;
    let state = app.state::<commands::AppState>();
    let cfg = slock!(state.shortcut_config).clone();
    let entries: [(&ShortcutEntry, &str); 13] = [
        (&cfg.toggle_recording, "Record"), (&cfg.rewind_3s, "Rewind3s"), (&cfg.rewind_5s, "Rewind5s"),
        (&cfg.toggle_studio, "Studio"),
        (&cfg.toggle_magnifier, "Magnifier"), (&cfg.toggle_step_marker, "StepMarker"),
        (&cfg.toggle_highlighter, "Highlighter"), (&cfg.toggle_ripple, "Ripple"),
        (&cfg.zoom_cycle, "ZoomCycle"), (&cfg.zoom_level_1, "Zoom1"),
        (&cfg.zoom_level_2, "Zoom2"), (&cfg.zoom_level_3, "Zoom3"),
        (&cfg.toggle_privacy, "Privacy"),
    ];
    for (entry, label) in &entries {
        match sc.register(entry_to_shortcut(entry)) {
            Ok(_) => log::info!("(Re)registered shortcut: {}", label),
            Err(e) => log::error!("FAILED to register {}: {}", label, e),
        }
    }
    match sc.register(Shortcut::new(None, Code::Escape)) {
        Ok(_) => log::info!("(Re)registered shortcut: Esc"),
        Err(e) => log::warn!("Esc registration failed: {}", e),
    }
    Ok(())
}

fn sync_overlay_window(s: &tauri::State<commands::AppState>) {
    let is_recording = s.is_recording.load(std::sync::atomic::Ordering::SeqCst);
    // Sync effect state and frame dimensions from OverlayManager into D2DOverlay
    let snapshot = s.overlay.lock().map(|ov| ov.snapshot()).ok();
    let has_mosaic = s.overlay.lock().map(|ov| {
        ov.has_mosaic_regions() || ov.is_privacy_paused()
    }).unwrap_or(false);
    let mut has_fx = false;
    let mut has_webcam = false;
    if let Ok(mut ow) = s.overlay_window.lock() {
        if let Ok(mut ost) = ow.state_ref().lock() {
            // Sync frame dimensions AND data from capture pipeline (needed for magnifier source)
            if let Ok(sf) = s.shared_frame.lock() {
                if let Some((ref data, fw, fh)) = *sf {
                    if fw > 0 { 
                        ost.frame_w = fw; 
                        ost.frame_h = fh; 
                        ost.frame_data = data.clone();
                    }
                }
            }
            // Fallback: if shared_frame is empty (e.g. right after recording starts),
            // use screen dimensions so magnifier can still position itself
            if ost.frame_w == 0 {
                use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
                unsafe {
                    ost.frame_w = GetSystemMetrics(SM_CXSCREEN) as u32;
                    ost.frame_h = GetSystemMetrics(SM_CYSCREEN) as u32;
                }
                log::info!("[OVL] sync: frame dims fallback to screen {}x{}", ost.frame_w, ost.frame_h);
            }
            if let Some(ref snap) = snapshot {
                ost.magnifier_enabled = snap.magnifier_active;
                ost.step_marker_active = snap.step_marker_active;
                ost.highlighter_active = snap.highlighter_active;
                ost.magnifier_cx = snap.magnifier_cx;
                ost.magnifier_cy = snap.magnifier_cy;
                ost.magnifier_zoom = snap.magnifier_zoom;
                ost.step_markers = snap.step_markers.clone();
                ost.highlighter_strokes = snap.highlighter_strokes.clone();
                ost.ripples = snap.ripples.clone();
            }
            if has_mosaic {
                if let Ok(ov) = s.overlay.lock() {
                    ost.mosaic_regions = ov.get_mosaic_regions();
                    ost.mosaic_drag_preview = ov.get_mosaic_drag_preview();
                    ost.privacy_paused = ov.is_privacy_paused();
                    ost.privacy_rewind_offset = ov.get_privacy_rewind_offset();
                }
            }
            // Sync webcam config for on-screen overlay
            if let Ok(wc_cfg) = s.webcam_config.lock() {
                ost.webcam_enabled = wc_cfg.enabled;
                ost.webcam_position = wc_cfg.position.clone();
                ost.webcam_custom_x = wc_cfg.custom_x;
                ost.webcam_custom_y = wc_cfg.custom_y;
                ost.webcam_size_ratio = wc_cfg.size_ratio;
                ost.webcam_shape = wc_cfg.shape.clone();
                ost.webcam_border_width = wc_cfg.border_width as f32;
                ost.webcam_corner_radius = wc_cfg.corner_radius;
                ost.webcam_border_color = parse_hex_color_f32(&wc_cfg.border_color);
            }
            // Sync latest webcam frame
            if let Ok(wc) = s.webcam.lock() {
                if let Some((ref data, w, h)) = wc.latest_frame() {
                    ost.webcam_frame = data.clone();
                    ost.webcam_frame_w = w;
                    ost.webcam_frame_h = h;
                }
            }
            log::info!("[OVL] sync: magnifier_enabled={} frame_w={} frame_h={} frame_data_len={}",
                ost.magnifier_enabled, ost.frame_w, ost.frame_h, ost.frame_data.len());
            has_webcam = ost.webcam_enabled && !ost.webcam_frame.is_empty();
            has_fx = snapshot.as_ref()
                .map(|s| s.magnifier_active || s.step_marker_active
                    || s.highlighter_active
                    || !s.step_markers.is_empty()
                    || !s.highlighter_strokes.is_empty())
                .unwrap_or(false) || has_mosaic || has_webcam;
        }
        if is_recording && has_fx { ow.show(); }
        else if has_webcam { ow.show(); }
        else { ow.hide(); }
        // Steady-state guard for the mouse hook (covers all toggle paths).
        crate::overlay::mouse_hook::update(
            snapshot.as_ref()
                .map(|s| s.highlighter_active || s.magnifier_active)
                .unwrap_or(false),
        );
        // Sync overlay commands to video compositing pipeline
        // (so effects triggered via shortcuts appear in the recorded video)
        if is_recording && has_fx {
            if let Ok(ov) = s.overlay.lock() {
                let cmds = ov.get_commands_for_compositor();
                if let Ok(pl) = s.pipeline.lock() {
                    if let Some(ref pipeline) = *pl {
                        pipeline.send_command(crate::pipeline::StageCommand::UpdateConfig(
                            crate::pipeline::StageConfigUpdate::OverlayCommands(cmds)
                        ));
                    }
                }
            }
        }
    }
}

fn parse_hex_color_f32(hex: &str) -> (f32, f32, f32, f32) {
    let hex = hex.trim_start_matches('#');
    if hex.len() < 6 { return (1.0, 1.0, 1.0, 1.0); }
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255) as f32 / 255.0;
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(255) as f32 / 255.0;
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(255) as f32 / 255.0;
    let a = if hex.len() >= 8 { u8::from_str_radix(&hex[6..8], 16).unwrap_or(255) as f32 / 255.0 } else { 1.0 };
    (r, g, b, a)
}