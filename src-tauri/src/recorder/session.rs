//! Recording session management

use crate::config::RecordingConfig;

pub struct RecordingSession {
    start_time: std::time::Instant,
    total_frames: u64,
}

impl RecordingSession {
    pub fn new(_config: &RecordingConfig) -> Self {
        log::info!("New session created");
        Self {
            start_time: std::time::Instant::now(),
            total_frames: 0,
        }
    }

    #[allow(dead_code)]
    pub fn elapsed_secs(&self) -> f64 {
        self.start_time.elapsed().as_secs_f64()
    }

    #[allow(dead_code)]
    pub fn increment_frames(&mut self, count: u64) {
        self.total_frames += count;
    }

    #[allow(dead_code)]
    pub fn fps(&self) -> f64 {
        let elapsed = self.elapsed_secs();
        if elapsed > 0.0 {
            self.total_frames as f64 / elapsed
        } else {
            0.0
        }
    }
}
