//! DXGI Desktop Duplication screen capture (Windows)

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, ID3D11Resource,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_READ, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, IDXGIAdapter1, IDXGIOutput, IDXGIOutput1,
    IDXGIOutputDuplication, DXGI_OUTPUT_DESC,
    DXGI_OUTDUPL_FRAME_INFO, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_ERROR_INVALID_CALL,
    IDXGIResource,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::System::Com::CoInitializeEx;
use windows::Win32::Foundation::HMODULE;

use super::types::{CapturedFrame, CaptureConfig};
use super::ScreenCapture;
use crate::compositor::gpu::{GpuCompositor, MagnifierParams};
use crate::error::{AppError, AppResult};

pub struct DxgiCapture {
    config: Option<CaptureConfig>,
    device: Option<ID3D11Device>,
    context: Option<ID3D11DeviceContext>,
    duplication: Option<IDXGIOutputDuplication>,
    staging_texture: Option<ID3D11Texture2D>,
    staging_width: u32,
    staging_height: u32,
    cursor_enabled: bool,
    gpu_compositor: Option<GpuCompositor>,
    pub magnifier_params: Option<MagnifierParams>,
    frame_timeout_ms: u32,
}

impl DxgiCapture {
    pub fn new() -> Self {
        Self {
            config: None,
            device: None,
            context: None,
            duplication: None,
            staging_texture: None,
            staging_width: 0,
            staging_height: 0,
            cursor_enabled: false,
            frame_timeout_ms: 16,
            gpu_compositor: None,
            magnifier_params: None,
        }
    }

    fn initialize(&mut self, config: &CaptureConfig) -> AppResult<()> {
        unsafe { let _ = CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED); }

        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;

        unsafe {
            D3D11CreateDevice(
                None,
                windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            ).map_err(|e| AppError::Capture(format!("D3D11CreateDevice failed: {e}")))?;
        }

        let device = device.ok_or_else(|| AppError::Capture("No D3D11 device".into()))?;
        let context = context.ok_or_else(|| AppError::Capture("No D3D11 context".into()))?;

        let factory: IDXGIFactory1 = unsafe {
            CreateDXGIFactory1().map_err(|e| AppError::Capture(format!("CreateDXGIFactory1: {e}")))?
        };

        let target_output = config.output_monitor;
        let mut output_count: u32 = 0;
        let mut found_output: Option<IDXGIOutput> = None;

        for adapter_idx in 0u32.. {
            let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(adapter_idx) } {
                Ok(a) => a,
                Err(_) => break,
            };

            for output_idx in 0u32.. {
                let output: IDXGIOutput = match unsafe { adapter.EnumOutputs(output_idx) } {
                    Ok(o) => o,
                    Err(_) => break,
                };

                if output_count as usize == target_output {
                    found_output = Some(output);
                    break;
                }
                output_count += 1;
            }

            if found_output.is_some() {
                break;
            }
        }

        let output = found_output.ok_or_else(|| {
            AppError::Capture(format!("Monitor {} not found ({} outputs found)", target_output, output_count))
        })?;

        let output_desc: DXGI_OUTPUT_DESC = unsafe {
            output.GetDesc().map_err(|e| AppError::Capture(format!("GetDesc: {e}")))?
        };

        log::info!("Monitor: {}x{}", 
            output_desc.DesktopCoordinates.right - output_desc.DesktopCoordinates.left,
            output_desc.DesktopCoordinates.bottom - output_desc.DesktopCoordinates.top);

        let output1: IDXGIOutput1 = output.cast()
            .map_err(|e| AppError::Capture(format!("Cast to IDXGIOutput1: {e}")))?;

        let duplication: IDXGIOutputDuplication = unsafe {
            output1.DuplicateOutput(&device)
                .map_err(|e| AppError::Capture(format!(
                    "DuplicateOutput failed: {e}. Run as admin, not in RDP."
                )))?
        };

        let dup_desc = unsafe { duplication.GetDesc() };

        let width = dup_desc.ModeDesc.Width;
        let height = dup_desc.ModeDesc.Height;

        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };

        let mut staging_option: Option<ID3D11Texture2D> = None;
        unsafe {
            device.CreateTexture2D(&staging_desc, None, Some(&mut staging_option))
                .map_err(|e| AppError::Capture(format!("CreateTexture2D: {e}")))?;
        }
        let staging = staging_option.ok_or_else(|| AppError::Capture("CreateTexture2D returned None".into()))?;

        self.device = Some(device);
        self.context = Some(context);
        self.duplication = Some(duplication);
        self.staging_texture = Some(staging);
        self.staging_width = width;
        self.staging_height = height;
        self.cursor_enabled = config.capture_cursor;

        log::info!("DXGI capture ready: {}x{}", width, height);
        Ok(())
    }

    fn cleanup(&mut self) {
        // Do NOT call ReleaseFrame here - it is the FrameReleaser job.
        // Calling ReleaseFrame when no frame is acquired can corrupt COM proxy state.
        self.duplication = None;
        self.staging_texture = None;
        self.context = None;
        self.device = None;
    }
}

impl DxgiCapture {
    /// Test if the capture pipeline is healthy by calling AcquireNextFrame with timeout 0.
    /// Returns Ok if the call succeeds or returns WAIT_TIMEOUT (both mean pipeline is alive).
    /// Returns Err if the call fails with another error (pipeline is broken).
    pub fn validate_pipeline(&mut self) -> AppResult<()> {
        let dup = match &self.duplication {
            Some(d) => d,
            None => return Err(crate::error::AppError::Capture("No duplication".into())),
        };
        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut desktop_resource: Option<IDXGIResource> = None;
        let result = unsafe {
            dup.AcquireNextFrame(0, &mut frame_info, &mut desktop_resource)
        };
        match result {
            Ok(()) => {
                // Got a frame immediately - release it
                unsafe { dup.ReleaseFrame().ok(); }
                Ok(())
            }
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                // No frame available yet, but pipeline is alive
                Ok(())
            }
            Err(e) => {
                Err(crate::error::AppError::Capture(format!("Pipeline validation failed: {e}")))
            }
        }
    }

    pub fn capture_width(&self) -> u32 { self.staging_width }
    pub fn capture_height(&self) -> u32 { self.staging_height }

    pub fn init_gpu_compositor(&mut self, width: u32, height: u32) -> bool {
        if let Some(ref device) = self.device {
            let mut gc = GpuCompositor::new();
            if gc.init(device, width, height) {
                self.gpu_compositor = Some(gc);
                return true;
            }
        }
        false
    }

    pub fn render_magnifier_gpu(
        &mut self,
        d3d_context: &ID3D11DeviceContext,
        desktop_texture: &ID3D11Texture2D,
        params: &MagnifierParams,
    ) -> bool {
        if !params.active { return false; }
        if let Some(ref mut gc) = self.gpu_compositor {
            gc.render(d3d_context, desktop_texture, params);
            true
        } else { false }
    }

    pub fn gpu_output_texture(&self) -> Option<&ID3D11Texture2D> {
        self.gpu_compositor.as_ref().and_then(|gc| gc.get_output_texture())
    }

    /// Get a reference to the D3D11 device for sharing with encoder/compositor.
    pub fn get_device(&self) -> Option<&ID3D11Device> {
        self.device.as_ref()
    }

    /// Get the D3D11 device context.
    pub fn get_context(&self) -> Option<&ID3D11DeviceContext> {
        self.context.as_ref()
    }

    /// Acquire next frame and return the raw desktop texture (GPU path).
    /// The returned texture is the desktop surface; caller should NOT hold it
    /// across calls ? copy it to your own texture first.
    /// Returns (texture, cursor_pos) or None if no new frame.
    pub fn next_frame_texture(&mut self) -> AppResult<Option<(ID3D11Texture2D, Option<(i32, i32)>)>> {
        use windows::Win32::Graphics::Dxgi::{
            DXGI_OUTDUPL_FRAME_INFO, DXGI_ERROR_WAIT_TIMEOUT,
            DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_INVALID_CALL, IDXGIResource,
        };
        use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

        let dup = match &self.duplication {
            Some(d) => d,
            None => return Ok(None),
        };

        unsafe { let _ = windows::Win32::Graphics::Dwm::DwmFlush(); }

        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut desktop_resource: Option<IDXGIResource> = None;

        let result = unsafe {
            dup.AcquireNextFrame(self.frame_timeout_ms, &mut frame_info, &mut desktop_resource)
        };

        match result {
            Ok(()) => {}
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
            Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST || e.code() == DXGI_ERROR_INVALID_CALL => {
                log::warn!("[DXGI GPU] interface invalidated, reconnecting...");
                self.cleanup();
                if let Some(cfg) = self.config.clone() {
                    self.initialize(&cfg)?;
                }
                return Ok(None);
            }
            Err(e) => return Err(crate::error::AppError::Capture(format!("AcquireNextFrame (GPU): {e}"))),
        }

        // We MUST release the frame after copying ? use RAII guard
        struct FrameGuard(IDXGIOutputDuplication);
        impl Drop for FrameGuard {
            fn drop(&mut self) { unsafe { self.0.ReleaseFrame().ok(); } }
        }
        let _guard = FrameGuard(dup.clone());

        let desktop_resource = match desktop_resource {
            Some(r) => r,
            None => return Ok(None),
        };

        let desktop_tex: ID3D11Texture2D = desktop_resource.cast()
            .map_err(|e| crate::error::AppError::Capture(format!("Cast to texture (GPU): {e}")))?;

        let cursor_pos = if self.cursor_enabled && frame_info.PointerPosition.Visible.as_bool() {
            Some((frame_info.PointerPosition.Position.x, frame_info.PointerPosition.Position.y))
        } else {
            None
        };

        Ok(Some((desktop_tex, cursor_pos)))
    }

    /// Create a shared GPU texture suitable for pipeline passing.
    /// This texture lives on the capture D3D11 device and can be shared
    /// with compositor and encoder stages.
    pub fn create_shared_texture(&self, width: u32, height: u32) -> AppResult<ID3D11Texture2D> {
        use windows::Win32::Graphics::Direct3D11::{
            D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
            D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
        };
        use windows::Win32::Graphics::Dxgi::Common::{
            DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
        };

        let device = self.device.as_ref()
            .ok_or_else(|| crate::error::AppError::Capture("No D3D11 device".into()))?;

        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };

        let mut tex: Option<ID3D11Texture2D> = None;
        unsafe {
            device.CreateTexture2D(&desc, None, Some(&mut tex))
                .map_err(|e| crate::error::AppError::Capture(format!("CreateTexture2D: {e}")))?;
        }

        tex.ok_or_else(|| crate::error::AppError::Capture("CreateTexture2D returned null".into()))
    }
}

impl ScreenCapture for DxgiCapture {
    fn start(&mut self, config: CaptureConfig) -> AppResult<()> {
        self.cleanup();
        let target_fps = config.target_fps;
        self.initialize(&config)?;
        self.config = Some(config);
        self.frame_timeout_ms = (1000 / target_fps) as u32;
        Ok(())
    }

    fn stop(&mut self) -> AppResult<()> {
        self.cleanup();
        self.config = None;
        Ok(())
    }

    fn next_frame(&mut self) -> AppResult<Option<CapturedFrame>> {
        let dup = match &self.duplication {
            Some(d) => d,
            None => return Ok(None),
        };
        let context = match &self.context {
            Some(c) => c,
            None => return Ok(None),
        };
        let staging = match &self.staging_texture {
            Some(s) => s,
            None => return Ok(None),
        };

        // Flush DWM to ensure layered windows are fully composited before capture
        unsafe { let _ = windows::Win32::Graphics::Dwm::DwmFlush(); }

        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut desktop_resource: Option<IDXGIResource> = None;

        let result = unsafe {
            dup.AcquireNextFrame(self.frame_timeout_ms, &mut frame_info, &mut desktop_resource)
        };

        match result {
            Ok(()) => {}
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
            Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST || e.code() == DXGI_ERROR_INVALID_CALL => {
                log::warn!("DXGI interface invalidated (code: {:#x}), reconnecting...", e.code().0);
                self.cleanup();
                let config_clone = self.config.clone();
                if let Some(cfg) = config_clone { self.initialize(&cfg)?; }
                return Ok(None);
            }
            Err(e) => return Err(AppError::Capture(format!("AcquireNextFrame: {e}"))),
        }

        struct FrameReleaser(IDXGIOutputDuplication);
        impl Drop for FrameReleaser {
            fn drop(&mut self) { unsafe { self.0.ReleaseFrame().ok(); } }
        }
        let _releaser = FrameReleaser(dup.clone());

        let desktop_resource = match desktop_resource {
            Some(r) => r,
            None => return Ok(None),
        };

        let desktop_tex: ID3D11Texture2D = desktop_resource.cast()
            .map_err(|e| AppError::Capture(format!("Cast to texture: {e}")))?;

        // GPU magnifier compositing
        let use_work_tex = if let Some(ref params) = self.magnifier_params {
            if params.active {
                if let Some(ref mut gc) = self.gpu_compositor {
                    gc.render(context, &desktop_tex, params);
                    true
                } else { false }
            } else { false }
        } else { false };
        if use_work_tex {
            if let Some(work_tex) = self.gpu_output_texture() {
                unsafe { context.CopyResource(staging, work_tex); }
            } else {
                unsafe { context.CopyResource(staging, &desktop_tex); }
            }
        } else {
            unsafe { context.CopyResource(staging, &desktop_tex); }
        }

        let staging_resource: ID3D11Resource = staging.clone().cast()
            .map_err(|_| AppError::Capture("Cast to resource".into()))?;

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            context.Map(&staging_resource, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|e| AppError::Capture(format!("Map: {e}")))?;
        }

        let row_pitch = mapped.RowPitch as usize;
        let pixel_bytes = self.staging_width as usize * 4;
        let height = self.staging_height as usize;

        let mut data = vec![0u8; pixel_bytes * height];
        if row_pitch == pixel_bytes {
            unsafe {
                std::ptr::copy_nonoverlapping(mapped.pData as *const u8, data.as_mut_ptr(), data.len());
            }
        } else {
            for row in 0..height {
                let src = unsafe { mapped.pData.add(row * row_pitch) as *const u8 };
                let dst = &mut data[row * pixel_bytes..(row + 1) * pixel_bytes];
                unsafe { std::ptr::copy_nonoverlapping(src, dst.as_mut_ptr(), pixel_bytes); }
            }
        }

        unsafe { context.Unmap(&staging_resource, 0); }

        let cursor_pos = if self.cursor_enabled && frame_info.PointerPosition.Visible.as_bool() {
            Some((frame_info.PointerPosition.Position.x, frame_info.PointerPosition.Position.y))
        } else {
            None
        };

        let timestamp = frame_info.LastPresentTime as f64 / 10_000_000.0;

        Ok(Some(CapturedFrame {
            data,
            width: self.staging_width,
            height: self.staging_height,
            stride: pixel_bytes as u32,
            timestamp,
            cursor_pos,
        }))
    }
}

