//! Stub encoder: no-op encoder for systems without hardware encoding support.
//! Simply counts frames and discards data. Useful for testing the pipeline.

use crate::error::AppResult;
use super::types::{EncodeConfig, EncodedPacket, EncoderInfo};
use super::VideoEncoder;

pub struct StubEncoder {
    frame_count: u64,
}

impl StubEncoder {
    pub fn new() -> Self {
        Self { frame_count: 0 }
    }
}

impl VideoEncoder for StubEncoder {
    fn configure(&mut self, _config: &EncodeConfig) -> AppResult<()> {
        log::info!("Stub encoder configured");
        Ok(())
    }

    fn encode(&mut self, _frame: &[u8], _timestamp: f64) -> AppResult<Vec<EncodedPacket>> {
        self.frame_count += 1;
        Ok(vec![])
    }

    fn flush(&mut self) -> AppResult<Vec<EncodedPacket>> {
        log::info!("Stub encoder flushed: {} frames", self.frame_count);
        Ok(vec![])
    }

    fn info(&self) -> EncoderInfo {
        EncoderInfo {
            backend: "stub".into(),
            name: "Stub (no-op)".into(),
            vendor: "DirectorCam".into(),
            supports_4k: false,
            supports_h265: false,
            supports_av1: false,
            is_available: true,
            max_resolution: (0, 0),
        }
    }
}
