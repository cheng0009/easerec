//! Voice Activity Detection (VAD) - silence detection for export trimming
//! Uses energy-based threshold analysis on audio samples.


/// Result of silence analysis on an audio track
#[derive(Debug, Clone)]
pub struct SilenceAnalysis {
    /// Detected silent regions: (start_sec, end_sec)
    pub silent_regions: Vec<(f64, f64)>,
    /// Detected speech regions: (start_sec, end_sec)
    pub speech_regions: Vec<(f64, f64)>,
    /// Total duration of audio in seconds
    pub duration_secs: f64,
}

/// Configuration for silence detection
pub struct VadConfig {
    /// Sample rate in Hz
    pub sample_rate: u32,
    /// Energy threshold below which audio is considered silent (0.0 - 1.0)
    pub energy_threshold: f32,
    /// Minimum silence duration to trigger a cut (seconds)
    pub min_silence_duration: f64,
    /// Frame size for energy calculation (samples)
    pub frame_size: usize,
    /// Padding to keep around speech segments (seconds) to avoid cutting too tight
    pub padding_secs: f64,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            sample_rate: 44100,
            energy_threshold: 0.005,
            min_silence_duration: 1.5,
            frame_size: 1024,
            padding_secs: 0.3,
        }
    }
}

/// Analyze audio samples for silence regions
pub fn analyze_silence(samples: &[f32], config: &VadConfig) -> SilenceAnalysis {
    if samples.is_empty() {
        return SilenceAnalysis {
            silent_regions: vec![],
            speech_regions: vec![],
            duration_secs: 0.0,
        };
    }

    let duration = samples.len() as f64 / config.sample_rate as f64;

    // Calculate energy per frame
    let mut frame_energies: Vec<(f64, f32)> = Vec::new(); // (time_sec, energy)

    for chunk_start in (0..samples.len()).step_by(config.frame_size) {
        let end = (chunk_start + config.frame_size).min(samples.len());
        let frame = &samples[chunk_start..end];

        let energy: f32 = frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32;
        let time = chunk_start as f64 / config.sample_rate as f64;

        frame_energies.push((time, energy));
    }

    // Classify frames as silent or speech
    let mut is_silent: Vec<bool> = frame_energies
        .iter()
        .map(|(_, e)| *e < config.energy_threshold)
        .collect();

    // Smooth: merge very short changes (< 100ms) to avoid flickering
    let smooth_frames = (0.1 * config.sample_rate as f64 / config.frame_size as f64).max(1.0) as usize;
    smooth_bool_array(&mut is_silent, smooth_frames);

    // Find silent regions
    let mut silent_regions: Vec<(f64, f64)> = Vec::new();
    let mut speech_regions: Vec<(f64, f64)> = Vec::new();
    let mut region_start: Option<usize> = None;
    let mut is_currently_silent = false;

    for (i, &silent) in is_silent.iter().enumerate() {
        if silent && !is_currently_silent {
            region_start = Some(i);
            is_currently_silent = true;
        } else if !silent && is_currently_silent {
            if let Some(start) = region_start {
                let start_time = frame_energies[start].0;
                let end_time = frame_energies[i - 1].0
                    + (config.frame_size as f64 / config.sample_rate as f64);
                let region_duration = end_time - start_time;

                if region_duration >= config.min_silence_duration {
                    silent_regions.push((start_time, end_time));
                }
            }
            region_start = None;
            is_currently_silent = false;
        }
    }

    // Handle trailing silence
    if is_currently_silent {
        if let Some(start) = region_start {
            let start_time = frame_energies[start].0;
            let end_time = duration;
            if end_time - start_time >= config.min_silence_duration {
                silent_regions.push((start_time, end_time));
            }
        }
    }

    // Calculate speech regions (inverse of silent regions)
    let mut last_end = 0.0;
    for &(start, end) in &silent_regions {
        if start > last_end + 0.01 {
            speech_regions.push((last_end, start));
        }
        last_end = end;
    }
    if last_end < duration - 0.01 {
        speech_regions.push((last_end, duration));
    }

    SilenceAnalysis {
        silent_regions,
        speech_regions,
        duration_secs: duration,
    }
}

/// Generate clip decisions: keep these time ranges, optionally with padding
pub fn generate_clip_decisions(
    analysis: &SilenceAnalysis,
    padding: f64,
) -> Vec<(f64, f64)> {
    // Keep speech regions with padding
    analysis.speech_regions
        .iter()
        .map(|&(start, end)| {
            let start_padded = (start - padding).max(0.0);
            let end_padded = (end + padding).min(analysis.duration_secs);
            (start_padded, end_padded)
        })
        .filter(|(s, e)| e - s > 0.1) // Filter too-short segments
        .collect()
}

/// Smooth a boolean array by merging short alternating segments
fn smooth_bool_array(arr: &mut [bool], window: usize) {
    if arr.len() < window * 2 {
        return;
    }

    let mut i = 0;
    while i < arr.len() {
        let val = arr[i];
        let mut run_end = i;
        while run_end < arr.len() && arr[run_end] == val {
            run_end += 1;
        }

        if run_end - i < window {
            // Flip short runs to match neighbors
            let fill_val = if i > 0 { arr[i - 1] } else { !val };
            for j in i..run_end.min(arr.len()) {
                arr[j] = fill_val;
            }
        }
        i = run_end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_audio() {
        let result = analyze_silence(&[], &VadConfig::default());
        assert!(result.silent_regions.is_empty());
        assert_eq!(result.duration_secs, 0.0);
    }

    #[test]
    fn test_all_silence() {
        // All zeros = all silent
        let samples = vec![0.0f32; 44100 * 3]; // 3 seconds
        let result = analyze_silence(&samples, &VadConfig::default());
        assert!(!result.silent_regions.is_empty());
        assert!(result.speech_regions.is_empty());
    }

    #[test]
    fn test_all_speech() {
        // Loud signal
        let samples: Vec<f32> = (0..44100 * 2).map(|i| (i as f32 * 0.01).sin()).collect();
        let result = analyze_silence(&samples, &VadConfig::default());
        assert!(result.silent_regions.is_empty());
        assert!(!result.speech_regions.is_empty());
    }

    #[test]
    fn test_speech_with_silence_gap() {
        let sr = 44100;
        // 0.5s speech, 2s silence, 0.5s speech
        let mut samples = Vec::new();
        // Speech segment
        for i in 0..(sr / 2) {
            samples.push((i as f32 * 0.01).sin());
        }
        // 2 seconds silence
        samples.extend(std::iter::repeat(0.0f32).take(sr * 2));
        // Speech segment
        for i in 0..(sr / 2) {
            samples.push((i as f32 * 0.01).sin());
        }

        let result = analyze_silence(&samples, &VadConfig::default());
        assert!(!result.silent_regions.is_empty(), "Should detect silence");
    }
}

