//! Recording configuration management

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;

/// Audio capture source
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioSource {
    System,
    Mic,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingConfig {
    /// Target frames per second
    pub fps: u32,
    /// Output resolution (width, height)
    pub width: u32,
    pub height: u32,
    /// Bitrate in Mbps
    pub bitrate_mbps: u32,
    /// Codec: "h264" or "h265"
    pub codec: Codec,
    /// Ring buffer capacity in seconds
    pub ring_buffer_duration_s: f64,
    /// Default rewind duration in seconds
    pub rewind_duration_s: f64,
    pub audio_source: AudioSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    H264,
    H265,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            fps: 30,
            width: 3840,
            height: 2160,
            bitrate_mbps: 50,
            codec: Codec::H264,
            ring_buffer_duration_s: 10.0,
            rewind_duration_s: 5.0,
            audio_source: AudioSource::Both,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudioConfig {
    pub enabled: bool,
    pub blur_strength: f32,
    pub background_color: String,
    pub target_window_id: Option<u64>,
}

impl Default for StudioConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            blur_strength: 20.0,
            background_color: "#0a0a0f".to_string(),
            target_window_id: None,
        }
    }
}

/// Available hardware encoder info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderInfo {
    pub name: String,
    pub vendor: String,
    pub supports_4k: bool,
    pub supports_h265: bool,
    pub is_available: bool,
}

/// A single shortcut: modifier keys + key code (stored as strings for serde)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcutEntry {
    pub key: String,
    #[serde(default)]
    pub modifiers: Vec<String>,
}

/// All configurable hotkeys
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcutConfig {
    pub toggle_recording: ShortcutEntry,
    pub rewind_3s: ShortcutEntry,
    pub rewind_5s: ShortcutEntry,
    pub toggle_studio: ShortcutEntry,
    pub toggle_magnifier: ShortcutEntry,
    pub toggle_step_marker: ShortcutEntry,
    pub toggle_highlighter: ShortcutEntry,
    pub toggle_ripple: ShortcutEntry,
    pub zoom_cycle: ShortcutEntry,
    pub zoom_level_1: ShortcutEntry,
    pub zoom_level_2: ShortcutEntry,
    pub zoom_level_3: ShortcutEntry,
    pub toggle_privacy: ShortcutEntry,
}

impl Default for ShortcutConfig {
    fn default() -> Self {
        Self {
            toggle_recording:  ShortcutEntry { key: "F9".into(),           modifiers: vec![] },
            rewind_3s:         ShortcutEntry { key: "F2".into(),           modifiers: vec![] },
            rewind_5s:         ShortcutEntry { key: "F4".into(),           modifiers: vec![] },
            toggle_studio:     ShortcutEntry { key: "F8".into(),           modifiers: vec![] },
            toggle_magnifier:  ShortcutEntry { key: "KeyQ".into(),         modifiers: vec!["ALT".into()] },
            toggle_step_marker:ShortcutEntry { key: "KeyW".into(),         modifiers: vec!["ALT".into()] },
            toggle_highlighter:ShortcutEntry { key: "KeyE".into(),         modifiers: vec!["ALT".into()] },
            toggle_ripple:     ShortcutEntry { key: "KeyR".into(),         modifiers: vec!["ALT".into()] },
            zoom_cycle:        ShortcutEntry { key: "Tab".into(),          modifiers: vec![] },
            zoom_level_1:      ShortcutEntry { key: "Digit1".into(),       modifiers: vec![] },
            zoom_level_2:      ShortcutEntry { key: "Digit2".into(),       modifiers: vec![] },
            zoom_level_3:      ShortcutEntry { key: "Digit3".into(),       modifiers: vec![] },
            toggle_privacy:    ShortcutEntry { key: "KeyP".into(),         modifiers: vec!["ALT".into()] },
        }
    }
}

fn config_path() -> PathBuf {
    let mut path = dirs_next::config_dir()
        .unwrap_or_else(|| PathBuf::from("."));
    path.push("DirectorCam");
    fs::create_dir_all(&path).ok();
    path.push("shortcuts.json");
    path
}

pub fn load_shortcut_config() -> ShortcutConfig {
    let path = config_path();
    if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        let cfg = ShortcutConfig::default();
        if let Ok(s) = serde_json::to_string_pretty(&cfg) {
            fs::write(&path, s).ok();
        }
        cfg
    }
}


/// Webcam overlay configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebcamConfig {
    pub enabled: bool,
    pub camera_index: u32,
    /// Normalized position: "bottom_right", "bottom_left", "top_right", "top_left", "custom"
    pub position: String,
    /// Custom normalized x coordinate (0-1), used when position == "custom"
    pub custom_x: f32,
    /// Custom normalized y coordinate (0-1)
    pub custom_y: f32,
    /// Fraction of screen width (0.08 - 0.35)
    pub size_ratio: f32,
    /// Shape: "circle", "rounded_rect", "rect"
    pub shape: String,
    /// Border color (hex)
    pub border_color: String,
    /// Border width in pixels (0-8)
    pub border_width: u32,
    /// Corner radius for rounded_rect (fraction of webcam width)
    pub corner_radius: f32,
}

impl Default for WebcamConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            camera_index: 0,
            position: "bottom_right".into(),
            custom_x: 0.85,
            custom_y: 0.85,
            size_ratio: 0.20,
            shape: "rounded_rect".into(),
            border_color: "#ffffff".into(),
            border_width: 2,
            corner_radius: 0.15,
        }
    }
}

pub fn save_shortcut_config(cfg: &ShortcutConfig) -> std::io::Result<()> {
    let path = config_path();
    let s = serde_json::to_string_pretty(cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    fs::write(path, s)
}



