pub mod types;
pub mod stub;

#[cfg(target_os = "windows")]
pub mod mf;

use crate::error::AppResult;
use types::{EncodeConfig, EncodedPacket, EncoderBackend, EncoderInfo, best_backend};

/// Hardware video encoder abstraction.
/// Implementations should prefer GPU-accelerated paths where available.
pub trait VideoEncoder: Send {
    /// Configure the encoder for a specific format.
    /// Must be called before `encode()`.
    fn configure(&mut self, config: &EncodeConfig) -> AppResult<()>;

    /// Encode a single frame.
    /// `frame` must be in the format matching the encoder's input (typically BGRA or NV12).
    /// `timestamp` is in seconds from pipeline start.
    fn encode(&mut self, frame: &[u8], timestamp: f64) -> AppResult<Vec<EncodedPacket>>;

    /// Encode directly from a D3D11 texture (GPU zero-copy).
    /// `texture_ptr` is a raw pointer to ID3D11Texture2D, or 0 if unavailable.
    fn encode_from_surface(
        &mut self,
        _texture_ptr: usize,
        _timestamp: f64,
    ) -> AppResult<Vec<EncodedPacket>> {
        Err(crate::error::AppError::Encode(
            "encode_from_surface not supported".into()
        ))
    }

    /// Flush remaining frames and finalize the output.
    fn flush(&mut self) -> AppResult<Vec<EncodedPacket>>;

    /// Get information about this encoder instance.
    fn info(&self) -> EncoderInfo;
}

/// Create an encoder with a specific backend.
pub fn create_encoder_with_backend(backend: EncoderBackend) -> AppResult<Box<dyn VideoEncoder>> {
    #[cfg(target_os = "windows")]
    {
        match backend {
            EncoderBackend::MediaFoundation | EncoderBackend::Auto => {
                log::info!("Creating MediaFoundation encoder");
                match crate::encoder::mf::MfEncoder::new() {
                    Ok(enc) => return Ok(Box::new(enc)),
                    Err(e) => log::warn!("MF encoder unavailable: {}", e),
                }
            }
            EncoderBackend::Nvenc => {
                log::info!("NVENC: routing through MediaFoundation on NVIDIA GPU (0x10DE)");
                // Vendor ID 0x10DE = NVIDIA
                let output_path = std::env::temp_dir()
                    .join(format!("directorcam_nvenc_{}.mp4", std::process::id()));
                match crate::encoder::mf::MfEncoder::new_with_gpu_preference(&output_path, 0x10DE) {
                    Ok(enc) => return Ok(Box::new(enc)),
                    Err(e) => log::warn!("NVENC via MF unavailable: {}, falling back", e),
                }
                // Fallback to default MF
                match crate::encoder::mf::MfEncoder::new() {
                    Ok(enc) => return Ok(Box::new(enc)),
                    Err(e) => log::warn!("MF fallback unavailable: {}", e),
                }
            }
            EncoderBackend::Amf => {
                log::info!("AMF: routing through MediaFoundation on AMD GPU (0x1002)");
                let output_path = std::env::temp_dir()
                    .join(format!("directorcam_amf_{}.mp4", std::process::id()));
                match crate::encoder::mf::MfEncoder::new_with_gpu_preference(&output_path, 0x1002) {
                    Ok(enc) => return Ok(Box::new(enc)),
                    Err(e) => log::warn!("AMF via MF unavailable: {}, falling back", e),
                }
                match crate::encoder::mf::MfEncoder::new() {
                    Ok(enc) => return Ok(Box::new(enc)),
                    Err(e) => log::warn!("MF fallback unavailable: {}", e),
                }
            }
            EncoderBackend::QuickSync => {
                log::info!("QuickSync: routing through MediaFoundation on Intel GPU (0x8086)");
                let output_path = std::env::temp_dir()
                    .join(format!("directorcam_qsv_{}.mp4", std::process::id()));
                match crate::encoder::mf::MfEncoder::new_with_gpu_preference(&output_path, 0x8086) {
                    Ok(enc) => return Ok(Box::new(enc)),
                    Err(e) => log::warn!("QSV via MF unavailable: {}, falling back", e),
                }
                match crate::encoder::mf::MfEncoder::new() {
                    Ok(enc) => return Ok(Box::new(enc)),
                    Err(e) => log::warn!("MF fallback unavailable: {}", e),
                }
            }
            EncoderBackend::Software => {
                log::warn!("Software encoder: not yet implemented, falling back to stub");
            }
        }
    }

    log::info!("Creating stub encoder (no hardware encoder available)");
    Ok(Box::new(stub::StubEncoder::new()))
}

/// Factory: auto-detect best available encoder.
pub fn create_encoder() -> AppResult<Box<dyn VideoEncoder>> {
    let backend = best_backend();
    log::info!("Auto-detected best encoder backend: {:?}", backend);
    create_encoder_with_backend(backend)
}


