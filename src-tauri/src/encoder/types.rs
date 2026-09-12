//! Video encoder types and multi-backend configuration.

use serde::{Deserialize, Serialize};

/// Available codec options
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    H264,
    H265,
    AV1,
}

/// Quality / speed tradeoff
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QualityPreset {
    /// Fastest encode, higher bitrate for same quality
    Speed,
    /// Balanced speed/quality
    Balanced,
    /// Best compression efficiency
    Quality,
}

/// Rate control mode
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RateControl {
    /// Constant bitrate
    CBR,
    /// Variable bitrate (target + peak)
    VBR,
    /// Constant quality (CRF/CQP)
    CQP { qp: u32 },
}

/// Available hardware encoder backends
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncoderBackend {
    /// Windows Media Foundation (always available on Windows)
    MediaFoundation,
    /// NVIDIA NVENC (requires NVIDIA GPU)
    Nvenc,
    /// AMD AMF (requires AMD GPU)
    Amf,
    /// Intel QuickSync (requires Intel GPU)
    QuickSync,
    /// Software x264/x265 (slow, but universal)
    Software,
    /// Auto-detect best available
    Auto,
}

/// Full encoder configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodeConfig {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub preset: QualityPreset,
}

impl Default for EncodeConfig {
    fn default() -> Self {
        Self {
            codec: Codec::H264,
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate: 20_000_000,
            preset: QualityPreset::Balanced,
        }
    }
}

/// Information about an available encoder backend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderInfo {
    pub backend: String,
    pub name: String,
    pub vendor: String,
    pub supports_4k: bool,
    pub supports_h265: bool,
    pub supports_av1: bool,
    pub is_available: bool,
    pub max_resolution: (u32, u32),
}

/// Encoded output packet (not used by MF SinkWriter which writes directly to file,
/// but used by backends that produce output buffers)
#[derive(Debug, Clone)]
pub struct EncodedPacket {
    pub data: Vec<u8>,
    pub timestamp: f64,
    pub duration: f64,
    pub is_keyframe: bool,
}

/// Detects available encoder backends on the current system
pub fn detect_encoders() -> Vec<EncoderInfo> {
    let mut encoders = Vec::new();

    // Media Foundation: always available on Windows
    encoders.push(EncoderInfo {
        backend: "mediafoundation".into(),
        name: "Media Foundation".into(),
        vendor: "Microsoft".into(),
        supports_4k: true,
        supports_h265: cfg!(target_os = "windows"),
        supports_av1: false,
        is_available: cfg!(target_os = "windows"),
        max_resolution: (7680, 4320),
    });

    // QuickSync: Intel GPU
    #[cfg(target_os = "windows")]
    {
        // Simple check: try to create a D3D11 device on Intel adapter
        use windows::Win32::Graphics::Dxgi::CreateDXGIFactory1;
        let has_intel = unsafe {
            if let Ok(factory) = CreateDXGIFactory1::<windows::Win32::Graphics::Dxgi::IDXGIFactory1>() {
                let mut idx = 0u32;
                loop {
                    match factory.EnumAdapters1(idx) {
                        Ok(adapter) => {
                            if let Ok(desc) = unsafe { adapter.GetDesc1() } {
                                let vendor_id = desc.VendorId;
                                if vendor_id == 0x8086 {
                                    break true;
                                }
                            }
                            idx += 1;
                        }
                        Err(_) => break false,
                    }
                }
            } else { false }
        };
        encoders.push(EncoderInfo {
            backend: "quicksync".into(),
            name: "Intel QuickSync".into(),
            vendor: "Intel".into(),
            supports_4k: true,
            supports_h265: true,
            supports_av1: false,
            is_available: has_intel,
            max_resolution: (8192, 8192),
        });
    }

    // NVENC: NVIDIA GPU
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dxgi::CreateDXGIFactory1;
        let has_nvidia = unsafe {
            if let Ok(factory) = CreateDXGIFactory1::<windows::Win32::Graphics::Dxgi::IDXGIFactory1>() {
                let mut idx = 0u32;
                loop {
                    match factory.EnumAdapters1(idx) {
                        Ok(adapter) => {
                            if let Ok(desc) = unsafe { adapter.GetDesc1() } {
                                if desc.VendorId == 0x10DE {
                                    break true;
                                }
                            }
                            idx += 1;
                        }
                        Err(_) => break false,
                    }
                }
            } else { false }
        };
        encoders.push(EncoderInfo {
            backend: "nvenc".into(),
            name: "NVIDIA NVENC".into(),
            vendor: "NVIDIA".into(),
            supports_4k: true,
            supports_h265: true,
            supports_av1: true,
            is_available: has_nvidia,
            max_resolution: (8192, 8192),
        });
    }

    // AMF: AMD GPU
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dxgi::CreateDXGIFactory1;
        let has_amd = unsafe {
            if let Ok(factory) = CreateDXGIFactory1::<windows::Win32::Graphics::Dxgi::IDXGIFactory1>() {
                let mut idx = 0u32;
                loop {
                    match factory.EnumAdapters1(idx) {
                        Ok(adapter) => {
                            if let Ok(desc) = unsafe { adapter.GetDesc1() } {
                                let vid = desc.VendorId;
                                if vid == 0x1002 || vid == 0x1022 {
                                    break true;
                                }
                            }
                            idx += 1;
                        }
                        Err(_) => break false,
                    }
                }
            } else { false }
        };
        encoders.push(EncoderInfo {
            backend: "amf".into(),
            name: "AMD AMF".into(),
            vendor: "AMD".into(),
            supports_4k: true,
            supports_h265: true,
            supports_av1: false,
            is_available: has_amd,
            max_resolution: (8192, 8192),
        });
    }

    // Software: always available as fallback
    encoders.push(EncoderInfo {
        backend: "software".into(),
        name: "Software (CPU)".into(),
        vendor: "x264/x265".into(),
        supports_4k: true,
        supports_h265: true,
        supports_av1: false,
        is_available: true,
        max_resolution: (16384, 16384),
    });

    encoders
}

/// Select the best available encoder backend
pub fn best_backend() -> EncoderBackend {
    let encoders = detect_encoders();
    // Prefer NVENC > AMF > QuickSync > MF > Software
    for e in &encoders {
        if e.is_available && e.backend == "nvenc" { return EncoderBackend::Nvenc; }
    }
    for e in &encoders {
        if e.is_available && e.backend == "quicksync" { return EncoderBackend::QuickSync; }
    }
    for e in &encoders {
        if e.is_available && e.backend == "amf" { return EncoderBackend::Amf; }
    }
    for e in &encoders {
        if e.is_available && e.backend == "mediafoundation" { return EncoderBackend::MediaFoundation; }
    }
    EncoderBackend::Software
}

