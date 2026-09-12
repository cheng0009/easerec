#[cfg(test)]
mod integration_tests {
    #[test]
    fn test_shortcut_config_roundtrip() {
        let cfg = app_lib::config::ShortcutConfig::default();
        let json = serde_json::to_string(&cfg).expect("serialize");
        let parsed: app_lib::config::ShortcutConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(cfg.toggle_recording.key, parsed.toggle_recording.key);
        assert_eq!(cfg.toggle_magnifier.key, parsed.toggle_magnifier.key);
        assert_eq!(cfg.toggle_recording.modifiers, parsed.toggle_recording.modifiers);
    }

    #[test]
    fn test_audio_source_serialization() {
        use app_lib::config::AudioSource;
        let src = AudioSource::Both;
        let json = serde_json::to_string(&src).expect("serialize");
        assert!(json.contains("both"));
        let parsed: AudioSource = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, AudioSource::Both);
    }

    #[test]
    fn test_recording_config_defaults() {
        let config = app_lib::config::RecordingConfig::default();
        assert_eq!(config.fps, 60);
        assert_eq!(config.width, 3840);
        assert_eq!(config.height, 2160);
        assert!(config.bitrate_mbps > 0);
    }

    #[test]
    fn test_webcam_config_defaults() {
        let config = app_lib::config::WebcamConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.position, "bottom_right");
        assert!(config.size_ratio > 0.0 && config.size_ratio < 1.0);
    }

    #[test]
    fn test_overlay_manager_lifecycle() {
        let mut mgr = app_lib::overlay::OverlayManager::new();
        assert!(!mgr.is_active());
        mgr.toggle_effect("magnifier", true);
        assert!(mgr.is_effect_active("magnifier"));
        mgr.toggle_effect("magnifier", false);
        assert!(!mgr.is_effect_active("magnifier"));
        mgr.toggle_effect("highlighter", true);
        mgr.toggle_effect("ripple", true);
        assert!(mgr.is_effect_active("highlighter"));
        assert!(mgr.is_effect_active("ripple"));
        mgr.toggle_effect("highlighter", false);
        assert!(!mgr.is_effect_active("highlighter"));
        assert!(mgr.is_effect_active("ripple"));
    }

    #[test]
    fn test_event_serialization() {
        let ev = app_lib::events::RecordingStateEvent { is_recording: true };
        let json = serde_json::to_string(&ev).expect("serialize");
        assert!(json.contains("true"));
        let ev2 = app_lib::events::AppNotification { level: "info".into(), message: "Test".into() };
        let json2 = serde_json::to_string(&ev2).expect("serialize");
        assert!(json2.contains("Test"));
    }
}