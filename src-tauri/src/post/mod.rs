//! Post-processing pipeline - export to publishable video
//! Handles silence trimming, subtitle burning, intro/outro concatenation.
//! Requires FFmpeg for advanced features; graceful fallback otherwise.

use crate::error::AppResult;

/// Full post-processing configuration
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PostConfig {
    // Silence trimming
    pub trim_silence: bool,
    pub silence_threshold_s: f64,

    // Subtitles
    pub burn_subtitles: bool,
    pub subtitle_font_size: f32,
    pub subtitle_font_family: String,
    pub subtitle_color: String,
    pub subtitle_border_color: String,
    pub subtitle_border_width: u32,
    pub subtitle_bg_color: String,
    pub subtitle_position: String, // "bottom", "top", "center"

    // Intro
    pub intro_enabled: bool,
    pub intro_path: String,
    pub intro_duration_s: f64,

    // Outro
    pub outro_enabled: bool,
    pub outro_path: String,
    pub outro_duration_s: f64,
}

impl Default for PostConfig {
    fn default() -> Self {
        Self {
            trim_silence: false,
            silence_threshold_s: 1.5,
            burn_subtitles: false,
            subtitle_font_size: 28.0,
            subtitle_font_family: "Arial".into(),
            subtitle_color: "#ffffff".into(),
            subtitle_border_color: "#000000".into(),
            subtitle_border_width: 2,
            subtitle_bg_color: "#00000000".into(),
            subtitle_position: "bottom".into(),
            intro_enabled: false,
            intro_path: String::new(),
            intro_duration_s: 3.0,
            outro_enabled: false,
            outro_path: String::new(),
            outro_duration_s: 3.0,
        }
    }
}

/// Result of post-processing
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PostResult {
    pub output_path: String,
    pub original_duration_s: f64,
    pub trimmed_duration_s: f64,
    pub silence_removed_s: f64,
}

pub struct PostProcessor {
    config: PostConfig,
}

impl PostProcessor {
    pub fn new(config: PostConfig) -> Self {
        Self { config }
    }

    /// Check if FFmpeg is available
    fn ffmpeg_cmd() -> Option<String> {
        crate::commands::find_ffmpeg()
    }

    /// Full export pipeline
    pub fn process(&self, video_path: &str, output_path: &str) -> AppResult<PostResult> {
        log::info!("Post-processing: {} -> {}", video_path, output_path);

        let ffmpeg = Self::ffmpeg_cmd();
        let has_ffmpeg = ffmpeg.is_some();

        if !has_ffmpeg {
            // Basic: just copy the file
            log::info!("No FFmpeg — basic copy export");
            if video_path != output_path {
                std::fs::copy(video_path, output_path)
                    .map_err(|e| crate::error::AppError::Other(format!("Copy failed: {e}")))?;
            }
            return Ok(PostResult {
                output_path: output_path.to_string(),
                original_duration_s: 0.0,
                trimmed_duration_s: 0.0,
                silence_removed_s: 0.0,
            });
        }

        let ffmpeg = ffmpeg.unwrap();
        let temp1 = format!("{}_tmp1.mp4", output_path.trim_end_matches(".mp4"));
        let temp2 = format!("{}_tmp2.mp4", output_path.trim_end_matches(".mp4"));

        // Step 1: Trim silence if enabled
        let mut current_input = video_path.to_string();
        if self.config.trim_silence {
            // Simple silence trim: detect and cut
            let trim_output = format!("{}_trimmed.mp4", output_path.trim_end_matches(".mp4"));
            let status = std::process::Command::new(&ffmpeg)
                .args(&["-y", "-i", video_path])
                .args(&["-af", &format!("silenceremove=stop_periods=-1:stop_duration={}:stop_threshold=-35dB",
                    self.config.silence_threshold_s)])
                .args(&["-c:v", "copy"])
                .args(&["-c:a", "aac", "-b:a", "192k"])
                .arg(&trim_output)
                .status();

            if status.map(|s| s.success()).unwrap_or(false) {
                current_input = trim_output;
                log::info!("Silence trimmed");
            }
        }

        // Step 2: Build concat inputs (intro + main + outro)
        let mut inputs: Vec<String> = vec![];
        let mut filters: Vec<String> = vec![];
        let mut input_idx = 0u32;

        // Intro
        if self.config.intro_enabled && !self.config.intro_path.is_empty()
            && std::path::Path::new(&self.config.intro_path).exists() {
            let intro_input = self.prepare_intro(&ffmpeg, &self.config.intro_path,
                self.config.intro_duration_s)?;
            inputs.push(intro_input);
            filters.push(format!("[{}:v][{}:a]", input_idx, input_idx));
            input_idx += 1;
        }

        // Main content
        inputs.push(current_input.clone());
        filters.push(format!("[{}:v][{}:a]", input_idx, input_idx));
        input_idx += 1;

        // Outro
        if self.config.outro_enabled && !self.config.outro_path.is_empty()
            && std::path::Path::new(&self.config.outro_path).exists() {
            let outro_input = self.prepare_intro(&ffmpeg, &self.config.outro_path,
                self.config.outro_duration_s)?;
            inputs.push(outro_input);
            filters.push(format!("[{}:v][{}:a]", input_idx, input_idx));
        }

        let concat_target = if inputs.len() > 1 {
            let concat_filter = format!("{}concat=n={}:v=1:a=1[vout][aout]",
                filters.join(""), inputs.len());

            let mut cmd = std::process::Command::new(&ffmpeg);
            cmd.arg("-y");
            for input in &inputs { cmd.arg("-i").arg(input); }
            cmd.args(&["-filter_complex", &concat_filter])
                .args(&["-map", "[vout]", "-map", "[aout]"])
                .args(&["-c:v", "libx264", "-crf", "18", "-preset", "fast"])
                .args(&["-c:a", "aac", "-b:a", "192k"])
                .arg(&temp1);

            let status = cmd.status();
            if status.map(|s| s.success()).unwrap_or(false) {
                temp1.clone()
            } else {
                log::warn!("Concat failed, using original");
                current_input.clone()
            }
        } else {
            current_input.clone()
        };

        // Step 3: Burn subtitles
        let final_target = if self.config.burn_subtitles {
            self.burn_subtitles(&ffmpeg, &concat_target, &temp2)
                .unwrap_or(concat_target.clone())
        } else {
            concat_target
        };

        // Move to final output
        if &final_target != output_path {
            let _ = std::fs::rename(&final_target, output_path);
        }

        // Cleanup temps
        let _ = std::fs::remove_file(&temp1);
        let _ = std::fs::remove_file(&temp2);

        log::info!("Export complete: {}", output_path);
        Ok(PostResult {
            output_path: output_path.to_string(),
            original_duration_s: 0.0,
            trimmed_duration_s: 0.0,
            silence_removed_s: 0.0,
        })
    }

    /// Convert an image to a video clip of the given duration
    fn prepare_intro(&self, ffmpeg: &str, path: &str, duration_s: f64) -> AppResult<String> {
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // If it's already a video, trim to duration
        if matches!(ext.as_str(), "mp4" | "mov" | "avi" | "webm" | "mkv") {
            let output = format!("{}_intro_{}.mp4",
                std::env::temp_dir().join("dc_intro").to_string_lossy(),
                std::process::id());
            let status = std::process::Command::new(ffmpeg)
                .args(&["-y", "-i", path])
                .args(&["-t", &duration_s.to_string()])
                .args(&["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18"])
                .args(&["-c:a", "aac", "-b:a", "192k"])
                .arg(&output)
                .status();
            if status.map(|s| s.success()).unwrap_or(false) {
                return Ok(output);
            }
        }

        // Image: convert to video with fade
        if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "bmp" | "webp") {
            let output = format!("{}_intro_{}.mp4",
                std::env::temp_dir().join("dc_intro").to_string_lossy(),
                std::process::id());
            let status = std::process::Command::new(ffmpeg)
                .args(&["-y", "-loop", "1", "-i", path])
                .args(&["-t", &duration_s.to_string()])
                .args(&["-vf", &format!(
                    "scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2,fade=in:0:30,fade=out:st={}:d=30",
                    (duration_s - 0.5).max(0.1)
                )])
                .args(&["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18"])
                .args(&["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"])
                .args(&["-c:a", "aac", "-b:a", "192k"])
                .args(&["-shortest"])
                .arg(&output)
                .status();
            if status.map(|s| s.success()).unwrap_or(false) {
                return Ok(output);
            }
        }

        // If conversion fails, return original
        Ok(path.to_string())
    }

    /// Burn subtitles with custom styling
    fn burn_subtitles(&self, ffmpeg: &str, input: &str, output: &str) -> AppResult<String> {
        let font_size = self.config.subtitle_font_size;
        let font = &self.config.subtitle_font_family;
        let color = &self.config.subtitle_color;
        let border = &self.config.subtitle_border_color;
        let border_w = self.config.subtitle_border_width;
        let bg = &self.config.subtitle_bg_color;
        let align = match self.config.subtitle_position.as_str() {
            "top" => "6", "center" => "5", _ => "2",
        };

        let force_style = format!(
            "FontSize={},FontName={},PrimaryColour=&H{},OutlineColour=&H{},BorderStyle=1,Outline={},BackColour=&H{},Alignment={},MarginV=40",
            font_size, font,
            Self::rgb_to_ass(color),
            Self::rgb_to_ass(border),
            border_w,
            Self::rgb_to_ass(bg),
            align
        );

        let status = std::process::Command::new(ffmpeg)
            .args(&["-y", "-i", input])
            .args(&["-vf", &format!("subtitles='{}':force_style='{}'", input.replace("\\", "/").replace(":", "\\:"), force_style)])
            .args(&["-c:v", "libx264", "-crf", "18", "-preset", "fast"])
            .args(&["-c:a", "copy"])
            .arg(output)
            .status();

        if status.map(|s| s.success()).unwrap_or(false) {
            log::info!("Subtitles burned with style: {}", force_style);
            Ok(output.to_string())
        } else {
            log::warn!("Subtitle burn failed");
            Err(crate::error::AppError::Other("Subtitle burn failed".into()))
        }
    }

    /// Convert RGB hex (#RRGGBB or #RRGGBBAA) to ASS &HAABBGGRR format
    fn rgb_to_ass(hex: &str) -> String {
        let h = hex.trim_start_matches('#');
        match h.len() {
            6 => {
                let r = &h[0..2]; let g = &h[2..4]; let b = &h[4..6];
                format!("00{}{}{}", b, g, r)
            }
            8 => {
                let a = &h[0..2]; let r = &h[2..4]; let g = &h[4..6]; let b = &h[6..8];
                format!("{}{}{}{}", a, b, g, r)
            }
            _ => "00FFFFFF".to_string(),
        }
    }
}