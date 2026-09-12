pub mod vad;
pub mod denoise;
pub mod privacy;

use crate::error::AppResult;

#[derive(Debug, Clone)]
pub struct Segment {
    pub text: String,
    pub start_time: f64,
    pub end_time: f64,
    pub confidence: f32,
}

pub struct AiPipeline {
    pub vad_config: vad::VadConfig,
    pub denoise_engine: denoise::DenoiseEngine,
    pub privacy_shield: privacy::PrivacyShield,
}

impl AiPipeline {
    pub fn new() -> Self {
        Self {
            vad_config: vad::VadConfig::default(),
            denoise_engine: denoise::DenoiseEngine::new(denoise::DenoiseConfig::default()),
            privacy_shield: privacy::PrivacyShield::new(privacy::PrivacyConfig::default()),
        }
    }

    pub fn detect_silence(&self, samples: &[f32]) -> vad::SilenceAnalysis {
        vad::analyze_silence(samples, &self.vad_config)
    }

    pub fn generate_clips(&self, analysis: &vad::SilenceAnalysis) -> Vec<(f64, f64)> {
        vad::generate_clip_decisions(analysis, self.vad_config.padding_secs)
    }

    pub fn denoise(&self, samples: &[f32]) -> Vec<f32> {
        self.denoise_engine.process_frame(samples)
    }

    pub fn scan_privacy(&self, text: &str) -> Vec<privacy::SensitiveRegion> {
        self.privacy_shield.scan_text(text)
    }

    pub fn transcribe(&self, _audio_samples: &[f32]) -> AppResult<Vec<Segment>> {
        // TODO: faster-whisper integration
        Ok(vec![])
    }
}
