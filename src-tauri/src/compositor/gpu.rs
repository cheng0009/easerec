//! GPU compositor: Direct2D renders magnifier effect using D3D11 textures.
//! Zero CPU pixel operations. No overlay window.

use std::mem::ManuallyDrop;

use windows::core::Interface;
use windows::Win32::Graphics::Direct2D::{
    D2D1CreateFactory, D2D1CreateDevice,
    ID2D1Factory1, ID2D1Device, ID2D1DeviceContext, ID2D1Bitmap1,
    D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_DEVICE_CONTEXT_OPTIONS_NONE,
    D2D1_BITMAP_PROPERTIES1,
    D2D1_INTERPOLATION_MODE_LINEAR,
    D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_OPTIONS_NONE,
    D2D1_ANTIALIAS_MODE_ALIASED, D2D1_ELLIPSE,
};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_PIXEL_FORMAT, D2D1_COLOR_F, D2D_RECT_F,
    D2D1_ALPHA_MODE_PREMULTIPLIED,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGISurface};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Texture2D, ID3D11DeviceContext,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
};
use windows::Win32::System::Com::CoInitializeEx;
use windows_numerics::Vector2;

#[derive(Clone, Default)]
pub struct MagnifierParams {
    pub active: bool,
    pub cursor_x: f32,
    pub cursor_y: f32,
    pub zoom: u32,
}

pub struct GpuCompositor {
    d2d_context: Option<ID2D1DeviceContext>,
    work_texture: Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
}

impl GpuCompositor {
    pub fn new() -> Self {
        unsafe { let _ = CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED); }
        Self { d2d_context: None, work_texture: None, width: 0, height: 0 }
    }

    pub fn init(&mut self, d3d_device: &ID3D11Device, width: u32, height: u32) -> bool {
        self.width = width;
        self.height = height;

        let dxgi_device: IDXGIDevice = match d3d_device.cast() {
            Ok(d) => d,
            Err(e) => { log::error!("Cast to IDXGIDevice: {:?}", e); return false; }
        };

        let _factory: ID2D1Factory1 = match unsafe {
            D2D1CreateFactory::<ID2D1Factory1>(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)
        } {
            Ok(f) => f,
            Err(e) => { log::error!("D2D1CreateFactory: {:?}", e); return false; }
        };

        let d2d_device: ID2D1Device = match unsafe { D2D1CreateDevice(&dxgi_device, None) } {
            Ok(d) => d,
            Err(e) => { log::error!("D2D1CreateDevice: {:?}", e); return false; }
        };

        let dc: ID2D1DeviceContext = match unsafe {
            d2d_device.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)
        } {
            Ok(c) => c,
            Err(e) => { log::error!("CreateDeviceContext: {:?}", e); return false; }
        };

        let tex_desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };

        let mut work_tex: Option<ID3D11Texture2D> = None;
        match unsafe { d3d_device.CreateTexture2D(&tex_desc, None, Some(&mut work_tex)) } {
            Ok(()) => {
                match work_tex {
                    Some(t) => self.work_texture = Some(t),
                    None => { log::error!("CreateTexture2D returned null"); return false; }
                }
            }
            Err(e) => { log::error!("CreateTexture2D: {:?}", e); return false; }
        }

        self.d2d_context = Some(dc);
        log::info!("GPU compositor ready: {}x{}", width, height);
        true
    }

    pub fn render(
        &mut self,
        d3d_context: &ID3D11DeviceContext,
        desktop_texture: &ID3D11Texture2D,
        params: &MagnifierParams,
    ) {
        let dc = match &self.d2d_context { Some(d) => d, None => return };
        let work_tex = match &self.work_texture { Some(t) => t, None => return };

        unsafe { d3d_context.CopyResource(work_tex, desktop_texture); }

        let dxgi_surface: IDXGISurface = match work_tex.cast() {
            Ok(s) => s, Err(_) => return,
        };

        let target_props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0, dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_NONE,
            colorContext: ManuallyDrop::new(None),
        };
        let target_bmp: ID2D1Bitmap1 = match unsafe {
            dc.CreateBitmapFromDxgiSurface(&dxgi_surface, Some(&target_props))
        } {
            Ok(b) => b, Err(_) => return,
        };

        let src_surface: IDXGISurface = match desktop_texture.cast() {
            Ok(s) => s, Err(_) => return,
        };
        let src_props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0, dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
            colorContext: ManuallyDrop::new(None),
        };
        let src_bmp: ID2D1Bitmap1 = match unsafe {
            dc.CreateBitmapFromDxgiSurface(&src_surface, Some(&src_props))
        } {
            Ok(b) => b, Err(_) => return,
        };

        let wf = self.width as f32;
        let hf = self.height as f32;
        let zf = match params.zoom { 1 => 1.5f32, 2 => 2.5f32, 3 => 4.0f32, _ => 1.5f32 };
        let rad = 0.12f32;
        let cx_px = (params.cursor_x * wf).clamp(0.0, wf);
        let cy_px = (params.cursor_y * hf).clamp(0.0, hf);
        let r_px = rad * (wf.min(hf));
        let src_half_px = r_px / zf;
        let src_cx_px = params.cursor_x * wf;
        let src_cy_px = params.cursor_y * hf;

        unsafe {
            dc.SetTarget(&target_bmp);
            dc.SetDpi(96.0, 96.0);
            dc.BeginDraw();

            let dim_col = D2D1_COLOR_F { r: 0.0, g: 0.0, b: 0.0, a: 0.45 };
            if let Ok(dim_brush) = dc.CreateSolidColorBrush(&dim_col, None) {
                dc.FillRectangle(
                    &D2D_RECT_F { left: 0.0, top: 0.0, right: wf, bottom: hf },
                    &dim_brush,
                );
            }

            let src_x = (src_cx_px - src_half_px).max(0.0);
            let src_y = (src_cy_px - src_half_px).max(0.0);
            let src_size = (src_half_px * 2.0).min(wf - src_x).min(hf - src_y);
            let src_rect = D2D_RECT_F { left: src_x, top: src_y, right: src_x + src_size, bottom: src_y + src_size };
            let dst_rect = D2D_RECT_F {
                left: cx_px - r_px, top: cy_px - r_px,
                right: cx_px + r_px, bottom: cy_px + r_px,
            };

            dc.PushAxisAlignedClip(&dst_rect, D2D1_ANTIALIAS_MODE_ALIASED);
            let _ = dc.DrawBitmap(
                &src_bmp,
                Some(&dst_rect),
                1.0,
                D2D1_INTERPOLATION_MODE_LINEAR,
                Some(&src_rect),
                None,
            );
            dc.PopAxisAlignedClip();

            let border_col = D2D1_COLOR_F { r: 1.0, g: 1.0, b: 1.0, a: 0.85 };
            if let Ok(b_brush) = dc.CreateSolidColorBrush(&border_col, None) {
                let ellipse = D2D1_ELLIPSE {
                    point: Vector2 { X: cx_px, Y: cy_px },
                    radiusX: r_px, radiusY: r_px,
                };
                dc.DrawEllipse(&ellipse, &b_brush, 3.0, None);
            }

            let _ = dc.EndDraw(None, None);
        }
    }

    pub fn get_output_texture(&self) -> Option<&ID3D11Texture2D> {
        self.work_texture.as_ref()
    }
}
