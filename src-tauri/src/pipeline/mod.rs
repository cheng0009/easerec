pub mod types;
pub mod capture_stage;
pub mod composite_stage;
pub mod encode_stage;

pub use types::*;
pub use capture_stage::CaptureStage;
pub use composite_stage::CompositeStage;
pub use encode_stage::EncodeStage;

// Re-export the main Pipeline struct
mod pipeline_impl;
pub use pipeline_impl::Pipeline;
