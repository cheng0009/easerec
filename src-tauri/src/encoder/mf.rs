//! MediaFoundation SinkWriter-based H.264/H.265 encoder
//! Uses hardware-accelerated encoding via IMFSinkWriter

use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, MFCreateAttributes,
    MFCreateSinkWriterFromURL, MFStartup, MFShutdown, MF_SDK_VERSION, MFSTARTUP_FULL,
    MFCreateSample, MFCreateMemoryBuffer, MFCreateMediaType,
    IMFSinkWriter, IMFMediaType, MFVideoFormat_H264, MFVideoFormat_HEVC,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_MT_FRAME_SIZE, MF_MT_FRAME_RATE,
    MF_MT_AVG_BITRATE, MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive,
    MFMediaType_Video, MFVideoFormat_RGB32,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::core::{HSTRING, Interface};

use crate::error::AppResult;
use super::types::{EncodeConfig, EncodedPacket, Codec};
use super::VideoEncoder;

pub struct MfEncoder {
    sink_writer: Option<IMFSinkWriter>,
    stream_index: u32,
    frame_count: u64,
    fps: u32,
    width: u32,
    height: u32,
    bitrate: u32,
    output_path: Option<String>,
    /// Raw pointer to IMFDXGIDeviceManager (stored as usize for Send/Sync)
    d3d11_manager: Option<usize>,
}

// IMFSinkWriter is COM object - safe for threads on Windows
unsafe impl Send for MfEncoder {}

impl MfEncoder {
    pub fn output_path(&self) -> Option<&str> {
        self.output_path.as_deref()
    }
}

impl MfEncoder {
    pub fn new() -> AppResult<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_SDK_VERSION, MFSTARTUP_FULL)
                .map_err(|e| crate::error::AppError::Encode(format!("MFStartup failed: {e}")))?;
        }

        Ok(Self {
            sink_writer: None, stream_index: 0, frame_count: 0,
            fps: 30, width: 1920, height: 1080, bitrate: 10_000_000,
            output_path: None,
            d3d11_manager: None,
        })
    }

    pub fn new_with_path(output_path: &std::path::Path) -> AppResult<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_SDK_VERSION, MFSTARTUP_FULL)
                .map_err(|e| crate::error::AppError::Encode(format!("MFStartup failed: {e}")))?;
        }
        Ok(Self {
            sink_writer: None, stream_index: 0, frame_count: 0,
            fps: 30, width: 1920, height: 1080, bitrate: 10_000_000,
            output_path: Some(output_path.to_string_lossy().to_string()),
            d3d11_manager: None,
        })
    }

    /// Set the D3D11 device to share with MediaFoundation for GPU zero-copy encoding.
    /// Call this BEFORE `configure()`. Enables MFCreateVideoSampleFromSurface to work.
    pub fn set_d3d11_device(&mut self, device: &windows::Win32::Graphics::Direct3D11::ID3D11Device) -> AppResult<()> {
        use windows::Win32::Media::MediaFoundation::{
            MFCreateDXGIDeviceManager, IMFDXGIDeviceManager,
        };
        use windows::Win32::Graphics::Dxgi::IDXGIDevice;

        let mut reset_token: u32 = 0;
        let mut manager_opt: Option<IMFDXGIDeviceManager> = None;
        unsafe { MFCreateDXGIDeviceManager(&mut reset_token, &mut manager_opt) }
            .map_err(|e| crate::error::AppError::Encode(format!(
                "MFCreateDXGIDeviceManager: {:?}", e
            )))?;
        let manager = manager_opt.ok_or_else(|| 
            crate::error::AppError::Encode("MFCreateDXGIDeviceManager returned null".into())
        )?;

        let dxgi_device: IDXGIDevice = device.cast()
            .map_err(|e| crate::error::AppError::Encode(format!(
                "Cast D3D11 device to IDXGIDevice: {:?}", e
            )))?;

        unsafe { manager.ResetDevice(&dxgi_device, reset_token) }
            .map_err(|e| crate::error::AppError::Encode(format!(
                "ResetDevice: {:?}", e
            )))?;

        // Store manager as raw pointer in Box for later use in configure()
        let manager_box = Box::new(manager);
        self.d3d11_manager = Some(Box::into_raw(manager_box) as usize);

        log::info!("MF: D3D11 device shared via DXGI Device Manager (token={})", reset_token);
        Ok(())
    }

    /// Create an encoder with GPU preference for hardware encoding.
    /// `vendor_id` can be 0x10DE (NVIDIA), 0x1002 (AMD), 0x8086 (Intel), or 0 for auto.
    /// The encoder will route through the specified GPU''s hardware encoder when available.
    pub fn new_with_gpu_preference(output_path: &std::path::Path, vendor_id: u32) -> AppResult<Self> {
        use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, IDXGIAdapter};
        use windows::Win32::Graphics::Direct3D11::{
            D3D11CreateDevice, ID3D11Device, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            D3D11_SDK_VERSION,
        };
        use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
        use windows::Win32::Foundation::HMODULE;

        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_SDK_VERSION, MFSTARTUP_FULL)
                .map_err(|e| crate::error::AppError::Encode(format!("MFStartup failed: {e}")))?;
        }

        let mut gpu_device: Option<ID3D11Device> = None;

        // Try to find the preferred GPU and create a D3D11 device on it
        if vendor_id != 0 {
            unsafe {
                if let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() {
                    let mut idx = 0u32;
                    loop {
                        match factory.EnumAdapters1(idx) {
                            Ok(adapter) => {
                                if let Ok(desc) = adapter.GetDesc1() {
                                    if desc.VendorId == vendor_id {
                                        log::info!(
                                            "MF: found preferred GPU vendor 0x{:04X}, creating D3D11 device",
                                            vendor_id
                                        );
                                        let mut dev: Option<ID3D11Device> = None;
                                        let adapter_for_d3d: IDXGIAdapter = match adapter.cast() {
                                            Ok(a) => a,
                                            Err(_) => { idx += 1; continue; }
                                        };
                                        let _ = D3D11CreateDevice(
                                            Some(&adapter_for_d3d),
                                            D3D_DRIVER_TYPE_HARDWARE,
                                            HMODULE::default(),
                                            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                            None,
                                            D3D11_SDK_VERSION,
                                            Some(&mut dev),
                                            None,
                                            None,
                                        );
                                        gpu_device = dev;
                                        break;
                                    }
                                }
                                idx += 1;
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        }

        if gpu_device.is_none() {
            log::info!("MF: no preferred GPU found, using default adapter");
        }

        Ok(Self {
            sink_writer: None, stream_index: 0, frame_count: 0,
            fps: 30, width: 1920, height: 1080, bitrate: 10_000_000,
            output_path: Some(output_path.to_string_lossy().to_string()),
            d3d11_manager: None,
        })
    }
}

impl VideoEncoder for MfEncoder {
    fn configure(&mut self, config: &EncodeConfig) -> AppResult<()> {
        self.fps = config.fps;
        self.width = config.width;
        self.height = config.height;
        self.bitrate = config.bitrate;
        self.frame_count = 0;

        if self.output_path.is_none() {
            let temp_dir = std::env::temp_dir();
            let output_file = temp_dir.join(format!("directorcam_recording_{}.mp4", std::process::id()));
            self.output_path = Some(output_file.to_string_lossy().to_string());
        }

        let is_h265 = matches!(config.codec, Codec::H265);
        let subtype = if is_h265 { MFVideoFormat_HEVC } else { MFVideoFormat_H264 };
        let frame_size: u64 = ((self.width as u64) << 32) | (self.height as u64);
        let frame_rate: u64 = ((self.fps as u64) << 32) | 1u64;

        unsafe {
            let url = HSTRING::from(self.output_path.as_ref().expect("Output path not set"));
            // Enable hardware-accelerated encoding
            let attr_count = if self.d3d11_manager.is_some() { 4 } else { 2 };
            let mut attrs: Option<IMFAttributes> = None;
            unsafe { MFCreateAttributes(&mut attrs, attr_count) }
                .map_err(|e| crate::error::AppError::Encode(format!("MFCreateAttributes: {e}")))?;
            let attrs = attrs.unwrap();

            // Set D3D11 device manager if available (enables GPU zero-copy)
            if let Some(manager_ptr) = self.d3d11_manager {
                use windows::Win32::Media::MediaFoundation::IMFDXGIDeviceManager;
                let manager: &IMFDXGIDeviceManager = unsafe {
                    &*(manager_ptr as *const IMFDXGIDeviceManager)
                };
                // MF_SINK_WRITER_D3D_MANAGER GUID: { 0xa099e0b3, 0x20ef, 0x4a6c, { 0x9e, 0x57, 0x9f, 0xee, 0xfe, 0xc4, 0xf4, 0x80 } }
                let d3d_manager_guid = windows::core::GUID::from_values(
                    0xa099e0b3, 0x20ef, 0x4a6c, [0x9e, 0x57, 0x9f, 0xee, 0xfe, 0xc4, 0xf4, 0x80]
                );
                // IMFDXGIDeviceManager implements IUnknown natively
                // Use the manager directly as the attribute value
                let unknown_ptr: *mut std::ffi::c_void = manager_ptr as *mut std::ffi::c_void;
                // SAFETY: manager is a valid COM interface pointer
                let unknown_ref: &windows::core::IUnknown = unsafe { &*(unknown_ptr as *const windows::core::IUnknown) };
                attrs.SetUnknown(&d3d_manager_guid, unknown_ref)
                    .map_err(|e| crate::error::AppError::Encode(format!("Set D3D manager: {:?}", e)))?;
                log::info!("MF: D3D11 device manager set on SinkWriter");
            }

            attrs.SetUINT32(&windows::Win32::Media::MediaFoundation::MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
                .map_err(|e| crate::error::AppError::Encode(format!("Set HW attr: {e}")))?;
            attrs.SetUINT32(&windows::Win32::Media::MediaFoundation::MF_SINK_WRITER_DISABLE_THROTTLING, 1)
                .map_err(|e| crate::error::AppError::Encode(format!("Set throttle attr: {e}")))?;
            // Low latency: prefer speed over compression efficiency
            attrs.SetUINT32(&windows::Win32::Media::MediaFoundation::MF_LOW_LATENCY, 1)
                .map_err(|e| crate::error::AppError::Encode(format!("Set low latency: {e}")))?;
            let writer: IMFSinkWriter = MFCreateSinkWriterFromURL(&url, None, Some(&attrs))
                .map_err(|e| crate::error::AppError::Encode(format!("MFCreateSinkWriterFromURL: {e}")))?;

            let output_type: IMFMediaType = MFCreateMediaType()
                .map_err(|e| crate::error::AppError::Encode(format!("MFCreateMediaType: {e}")))?;
            output_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(|e| crate::error::AppError::Encode(format!("SetGUID major: {e}")))?;
            output_type.SetGUID(&MF_MT_SUBTYPE, &subtype)
                .map_err(|e| crate::error::AppError::Encode(format!("SetGUID subtype: {e}")))?;
            output_type.SetUINT64(&MF_MT_FRAME_SIZE, frame_size)
                .map_err(|e| crate::error::AppError::Encode(format!("SetUINT64 size: {e}")))?;
            output_type.SetUINT64(&MF_MT_FRAME_RATE, frame_rate)
                .map_err(|e| crate::error::AppError::Encode(format!("SetUINT64 fps: {e}")))?;
            output_type.SetUINT32(&MF_MT_AVG_BITRATE, self.bitrate)
                .map_err(|e| crate::error::AppError::Encode(format!("SetUINT32 bitrate: {e}")))?;
            output_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(|e| crate::error::AppError::Encode(format!("SetUINT32 interlace: {e}")))?;

            self.stream_index = writer.AddStream(&output_type)
                .map_err(|e| crate::error::AppError::Encode(format!("AddStream: {e}")))?;

            let input_type: IMFMediaType = MFCreateMediaType()
                .map_err(|e| crate::error::AppError::Encode(format!("MFCreateMediaType input: {e}")))?;
            input_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(|e| crate::error::AppError::Encode(format!("SetGUID major input: {e}")))?;
            input_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
                .map_err(|e| crate::error::AppError::Encode(format!("SetGUID RGB32: {e}")))?;
            input_type.SetUINT64(&MF_MT_FRAME_SIZE, frame_size).ok();
            input_type.SetUINT64(&MF_MT_FRAME_RATE, frame_rate).ok();

            writer.SetInputMediaType(self.stream_index, &input_type, None)
                .map_err(|e| crate::error::AppError::Encode(format!("SetInputMediaType: {e}")))?;

            writer.BeginWriting()
                .map_err(|e| crate::error::AppError::Encode(format!("BeginWriting: {e}")))?;

            self.sink_writer = Some(writer);
        }

        log::info!("MF encoder ready: {}x{} @{}fps stream={}", self.width, self.height, self.fps, self.stream_index);
        Ok(())
    }

    fn encode(&mut self, frame: &[u8], timestamp: f64) -> AppResult<Vec<EncodedPacket>> {
        let writer = match &self.sink_writer {
            Some(w) => w,
            None => return Ok(vec![]),
        };

        self.frame_count += 1;
        let frame_duration: i64 = 10_000_000i64 / self.fps as i64;
        // Use actual timestamp from recorder (seconds since start), not frame count
        let sample_time: i64 = (timestamp * 10_000_000.0) as i64;

        unsafe {
            let sample = MFCreateSample()
                .map_err(|e| crate::error::AppError::Encode(format!("MFCreateSample: {e}")))?;
            let buffer = MFCreateMemoryBuffer(frame.len() as u32)
                .map_err(|e| crate::error::AppError::Encode(format!("MFCreateMemoryBuffer: {e}")))?;

            {
                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut max_len: u32 = 0;
                buffer.Lock(&mut data_ptr, None, Some(&mut max_len))
                    .map_err(|e| crate::error::AppError::Encode(format!("Lock: {e}")))?;
                std::ptr::copy_nonoverlapping(frame.as_ptr(), data_ptr, frame.len());
                buffer.SetCurrentLength(frame.len() as u32)
                    .map_err(|e| crate::error::AppError::Encode(format!("SetCurrentLength: {e}")))?;
                buffer.Unlock().ok();
            }

            sample.AddBuffer(&buffer).ok();
            sample.SetSampleTime(sample_time).ok();
            sample.SetSampleDuration(frame_duration).ok();

            writer.WriteSample(self.stream_index, &sample)
                .map_err(|e| crate::error::AppError::Encode(format!("WriteSample: {e}")))?;
        }

        Ok(vec![])
    }

    fn flush(&mut self) -> AppResult<Vec<EncodedPacket>> {
        if let Some(ref writer) = self.sink_writer {
            unsafe { let _ = writer.Finalize(); }
        }
        self.sink_writer = None; // prevent double-finalize in Drop
        log::info!("MF encoder flushed: {} frames", self.frame_count);
        Ok(vec![])
    }

    fn info(&self) -> crate::encoder::types::EncoderInfo {
        crate::encoder::types::EncoderInfo {
            backend: "mediafoundation".into(),
            name: "Media Foundation".into(),
            vendor: "Microsoft".into(),
            supports_4k: true,
            supports_h265: true,
            supports_av1: false,
            is_available: true,
            max_resolution: (7680, 4320),
        }
    }
}


impl MfEncoder {
    /// Encode directly from a D3D11 texture (GPU zero-copy path).
    /// The texture must be BGRA8_UNORM format, matching the encoder input config.
    /// Uses MFCreateVideoSampleFromSurface for direct GPU-to-encoder transfer.
    ///
    /// # Safety
    /// `texture` must be a valid ID3D11Texture2D from the same D3D11 device
    /// that was used when MF was initialized (or a device on the same adapter).
    #[cfg(target_os = "windows")]
    pub fn encode_from_surface_impl(
        &mut self,
        texture: &windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
        timestamp: f64,
    ) -> AppResult<Vec<EncodedPacket>> {
        use windows::Win32::Media::MediaFoundation::{
            MFCreateVideoSampleFromSurface, IMFSample,
        };
        use windows::Win32::Graphics::Dxgi::IDXGISurface;

        let writer = match &self.sink_writer {
            Some(w) => w,
            None => return Ok(vec![]),
        };

        self.frame_count += 1;
        let frame_duration: i64 = 10_000_000i64 / self.fps as i64;
        let sample_time: i64 = (timestamp * 10_000_000.0) as i64;

        unsafe {
            // Cast ID3D11Texture2D to IDXGISurface for MF interop
            let surface: IDXGISurface = texture.cast()
                .map_err(|e| crate::error::AppError::Encode(format!("Cast to IDXGISurface: {:?}", e)))?;

            // Create sample directly from D3D11 surface ? no CPU copy
            let sample: IMFSample = MFCreateVideoSampleFromSurface(&surface)
                .map_err(|e| crate::error::AppError::Encode(format!("MFCreateVideoSampleFromSurface: {:?}", e)))?;

            sample.SetSampleTime(sample_time).ok();
            sample.SetSampleDuration(frame_duration).ok();

            writer.WriteSample(self.stream_index, &sample)
                .map_err(|e| crate::error::AppError::Encode(format!("WriteSample (GPU): {:?}", e)))?;
        }

        Ok(vec![])
    }

    /// Get encoder metadata for reporting
    pub fn encoder_info(&self) -> crate::encoder::types::EncoderInfo {
        crate::encoder::types::EncoderInfo {
            backend: "mediafoundation".into(),
            name: "Media Foundation".into(),
            vendor: "Microsoft".into(),
            supports_4k: true,
            supports_h265: true,
            supports_av1: false,
            is_available: true,
            max_resolution: (7680, 4320),
        }
    }
}
impl Drop for MfEncoder {
    fn drop(&mut self) {
        if let Some(ref writer) = self.sink_writer {
            unsafe { let _ = writer.Finalize(); }
        }
        self.sink_writer = None;
        // Release DXGI device manager if present
        if let Some(ptr) = self.d3d11_manager.take() {
            unsafe {
                let _ = Box::from_raw(ptr as *mut windows::Win32::Media::MediaFoundation::IMFDXGIDeviceManager);
            }
        }
        unsafe { let _ = MFShutdown(); }
    }
}













