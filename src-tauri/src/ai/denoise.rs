// AI Noise reduction module
// Provides framework for RNNoise-style neural noise suppression.
// The actual model inference runs via ONNX Runtime or a custom Rust implementation.


/// Configuration for the noise reduction model
pub struct DenoiseConfig {
    /// Sample rate (Hz)
    pub sample_rate: u32,
    /// Frame size for processing (samples)
    pub frame_size: usize,
    /// Whether denoising is enabled
    pub enabled: bool,
    /// Target noise profile (mechanical keyboard, fan, etc.)
    pub noise_profile: NoiseProfile,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NoiseProfile {
    /// Mechanical keyboard clicks
    MechanicalKeyboard,
    /// Background fan/ambient noise
    BackgroundHum,
    /// General noise reduction
    General,
}

impl Default for DenoiseConfig {
    fn default() -> Self {
        Self {
            sample_rate: 44100,
            frame_size: 480, // 10ms @ 48kHz
            enabled: false,
            noise_profile: NoiseProfile::General,
        }
    }
}

/// Noise reduction engine
pub struct DenoiseEngine {
    config: DenoiseConfig,
}

impl DenoiseEngine {
    pub fn new(config: DenoiseConfig) -> Self {
        Self { config }
    }

    pub fn is_enabled(&self) -> bool {
        self.config.enabled
    }

    /// Process audio frame through noise reduction
    /// Returns denoised samples of the same length
    pub fn process_frame(&self, samples: &[f32]) -> Vec<f32> {
        if !self.config.enabled || samples.is_empty() {
            return samples.to_vec();
        }

        // TODO: Integrate RNNoise or custom ONNX model
        // For now, apply a simple low-pass filter as placeholder
        // that attenuates high-frequency keyboard clicks

        if self.config.noise_profile == NoiseProfile::MechanicalKeyboard {
            simple_lowpass(samples, 0.3)
        } else {
            samples.to_vec()
        }
    }
}

/// Simple one-pole low-pass filter for high-frequency noise
fn simple_lowpass(samples: &[f32], smoothing: f32) -> Vec<f32> {
    let mut result = Vec::with_capacity(samples.len());
    let mut prev = samples.first().copied().unwrap_or(0.0);
    let a = smoothing.clamp(0.0, 1.0);

    for &s in samples {
        prev = a * prev + (1.0 - a) * s;
        result.push(prev);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_denoise_disabled_passthrough() {
        let config = DenoiseConfig { enabled: false, ..Default::default() };
        let engine = DenoiseEngine::new(config);
        let input = vec![1.0, -0.5, 0.3];
        let output = engine.process_frame(&input);
        assert_eq!(input, output);
    }

    #[test]
    fn test_lowpass_attenuates_high_freq() {
        // A spike should be smoothed
        let input: Vec<f32> = (0..100).map(|i| if i == 50 { 1.0 } else { 0.0 }).collect();
        let output = simple_lowpass(&input, 0.3);
        // The spike should be reduced
        assert!(output[50] < 0.8, "Spike should be attenuated, got {}", output[50]);
    }
}

