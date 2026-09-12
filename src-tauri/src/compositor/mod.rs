pub mod gpu;
// Multi-threaded CPU compositor using rayon
// Splits pixel operations across all CPU cores for significant speedup.

use rayon::prelude::*;
use crate::error::AppResult;
use crate::overlay::RenderCommand;

pub struct Compositor {
    magnifier_source: Vec<u8>,
    magnifier_source_w: u32,
    magnifier_source_h: u32,
}

impl Compositor {
    pub fn new() -> Self {
        Self {
            magnifier_source: Vec::new(),
            magnifier_source_w: 0,
            magnifier_source_h: 0,
        }
    }

    pub fn set_magnifier_source(&mut self, data: Vec<u8>, w: u32, h: u32) {
        self.magnifier_source = data;
        self.magnifier_source_w = w;
        self.magnifier_source_h = h;
    }

    /// Pixel threshold above which parallel (rayon) path is used.
    /// For a 4K frame, anything over ~64K pixels benefits from threading.
    const PARALLEL_THRESHOLD: u32 = 65536;

    pub fn composite(
        &self,
        screen_frame: &[u8],
        width: u32,
        height: u32,
        overlay_commands: &[RenderCommand],
    ) -> AppResult<Vec<u8>> {
        if overlay_commands.is_empty() {
            return Ok(screen_frame.to_vec());
        }
        let mut output = screen_frame.to_vec();
        for cmd in overlay_commands {
            match cmd {
                RenderCommand::FillRect { x, y, w, h, color } => {
                    let x0 = (x.max(0.0) as u32).min(width);
                    let y0 = (y.max(0.0) as u32).min(height);
                    let x1 = ((x + w).max(0.0) as u32).min(width);
                    let y1 = ((y + h).max(0.0) as u32).min(height);
                    let area = (x1.saturating_sub(x0)) * (y1.saturating_sub(y0));
                    if area >= Self::PARALLEL_THRESHOLD {
                        blend_rect_par_raw(&mut output, width, x0, y0, x1, y1, *color);
                    } else {
                        blend_rect_seq(&mut output, width, x0, y0, x1, y1, *color);
                    }
                }
                RenderCommand::FillCircle { cx, cy, r, color } => {
                    let x0 = ((cx - r).max(0.0) as u32).min(width);
                    let y0 = ((cy - r).max(0.0) as u32).min(height);
                    let x1 = ((cx + r).max(0.0) as u32).min(width);
                    let y1 = ((cy + r).max(0.0) as u32).min(height);
                    let area = (x1.saturating_sub(x0)) * (y1.saturating_sub(y0));
                    if area >= Self::PARALLEL_THRESHOLD {
                        blend_circle_par_raw(&mut output, width, x0, y0, x1, y1, *cx, *cy, r * r, *color);
                    } else {
                        blend_circle_par_raw(&mut output, width, x0, y0, x1, y1, *cx, *cy, r * r, *color);
                    }
                }
                RenderCommand::DrawLine { x1, y1, x2, y2, width: lw, color } =>
                    blend_line_seq(&mut output, width, height, *x1, *y1, *x2, *y2, *lw, *color),
                RenderCommand::DrawText { ref text, x, y, size: _, color } =>
                    draw_text(&mut output, width, height, text, *x, *y, *color),
                RenderCommand::Magnify { src_cx, src_cy, src_hw, src_hh, dst_cx, dst_cy, dst_r } => {
                    let src = if !self.magnifier_source.is_empty() {
                        &self.magnifier_source
                    } else {
                        screen_frame
                    };
                    // Magnifier area = Pi * r^2 in normalized coords -> pixel area
                    let r_px = dst_r * (width.min(height) as f32);
                    let area = (std::f32::consts::PI * r_px * r_px) as u32;
                    if area >= Self::PARALLEL_THRESHOLD {
                        magnify_par_raw(&mut output, width, height, src, *src_cx, *src_cy, *src_hw, *src_hh, *dst_cx, *dst_cy, *dst_r);
                    } else {
                        magnify_par_raw(&mut output, width, height, src, *src_cx, *src_cy, *src_hw, *src_hh, *dst_cx, *dst_cy, *dst_r);
                    }
                }
                RenderCommand::BlitImage { ref data, src_w, src_h, dst_x, dst_y, dst_w, dst_h, ref shape, corner_radius, border_color, border_width } => {
                    // dst_w/dst_h are already pixel dimensions; area for parallelism decision
                    let area = (*dst_w as u32).saturating_mul(*dst_h as u32);
                    if area >= Self::PARALLEL_THRESHOLD {
                        blit_image_par_raw(&mut output, width, height, data, *src_w, *src_h, *dst_x, *dst_y, *dst_w, *dst_h, shape, *corner_radius, *border_color, *border_width);
                    } else {
                        blit_image_par_raw(&mut output, width, height, data, *src_w, *src_h, *dst_x, *dst_y, *dst_w, *dst_h, shape, *corner_radius, *border_color, *border_width);
                    }
                }
            }
        }
        Ok(output)
    }
}

#[inline(always)]
fn alpha_blend(pixel: &mut [u8], src: (f32,f32,f32,f32)) {
    let a_src = src.3;
    let a_dst = pixel[3] as f32 / 255.0;
    let a_out = a_src + a_dst * (1.0 - a_src);
    if a_out > 0.0 {
        let inv = 1.0 / a_out;
        pixel[0] = ((src.2 * a_src + pixel[0] as f32 / 255.0 * a_dst * (1.0 - a_src)) * inv * 255.0) as u8;
        pixel[1] = ((src.1 * a_src + pixel[1] as f32 / 255.0 * a_dst * (1.0 - a_src)) * inv * 255.0) as u8;
        pixel[2] = ((src.0 * a_src + pixel[2] as f32 / 255.0 * a_dst * (1.0 - a_src)) * inv * 255.0) as u8;
        pixel[3] = (a_out * 255.0) as u8;
    }
}

/// Parallel rect fill using rayon: splits rows across CPU cores.
fn blend_rect_par_raw(pixels: &mut [u8], img_w: u32, x0: u32, y0: u32, x1: u32, y1: u32, color: (f32,f32,f32,f32)) {
    let total = (y1.saturating_sub(y0)) as usize;
    if total < 8 { return blend_rect_seq(pixels, img_w, x0, y0, x1, y1, color); }
    let stride = img_w as usize * 4;
    let ptr = pixels.as_ptr() as usize;
    let chunks: Vec<u32> = (y0..y1).collect();
    let chunk_size = (total / rayon::current_num_threads().max(1)).max(1);
    chunks.par_chunks(chunk_size).for_each(|rows| {
        if rows.is_empty() { return; }
        let offset = rows[0] as usize * stride;
        for &py in rows {
            let base = py as usize * stride - offset;
            for px in x0..x1 {
                let idx = base + (px as usize) * 4;
                unsafe {
                    let p = (ptr + offset + idx) as *mut u8;
                    alpha_blend(std::slice::from_raw_parts_mut(p, 4), color);
                }
            }
        }
    });
}

#[allow(dead_code)]
fn blend_circle_par(pixels: &mut [u8], img_w: u32, img_h: u32, cx: f32, cy: f32, r: f32, color: (f32,f32,f32,f32)) {
    let x0 = ((cx - r).max(0.0) as u32).min(img_w);
    let y0 = ((cy - r).max(0.0) as u32).min(img_h);
    let x1 = ((cx + r).max(0.0) as u32).min(img_w);
    let y1 = ((cy + r).max(0.0) as u32).min(img_h);
    let r2 = r * r;
    let total = (y1 - y0) as usize;
    if total < 8 { return blend_circle_seq(pixels, img_w, x0,y0,x1,y1, cx,cy,r2, color); }
    let stride = img_w as usize * 4;
    let ptr = pixels.as_ptr() as usize;
    let chunks: Vec<_> = (y0..y1).collect();
    let chunk_size = (total / rayon::current_num_threads().max(1)).max(1);
    chunks.par_chunks(chunk_size).for_each(|rows| {
        if rows.is_empty() { return; }
        let offset = rows[0] as usize * stride;
        for &py in rows {
            let dy = py as f32 - cy;
            let base = py as usize * stride - offset;
            for px in x0..x1 {
                if (px as f32 - cx).powi(2) + dy.powi(2) > r2 { continue; }
                let idx = base + (px as usize) * 4;
                unsafe {
                    let p = (ptr + offset + idx) as *mut u8;
                    alpha_blend(std::slice::from_raw_parts_mut(p, 4), color);
                }
            }
        }
    });
}

fn blend_line_seq(pixels: &mut [u8], img_w: u32, img_h: u32, x1: f32, y1: f32, x2: f32, y2: f32, thickness: f32, color: (f32,f32,f32,f32)) {
    // Lines are thin - sequential is fine
    let half_t = (thickness / 2.0).max(0.5) as i32;
    let mut x = x1 as i32; let mut y = y1 as i32;
    let dx = (x2 - x1).abs() as i32; let dy = -(y2 - y1).abs() as i32;
    let sx = if x1 < x2 { 1 } else { -1 };
    let sy = if y1 < y2 { 1 } else { -1 };
    let mut err = dx + dy;
    let stride = img_w as usize * 4;
    loop {
        for ty in -half_t..=half_t {
            for tx in -half_t..=half_t {
                let px = (x + tx) as u32; let py = (y + ty) as u32;
                if px >= img_w || py >= img_h { continue; }
                let idx = py as usize * stride + px as usize * 4;
                if idx + 3 >= pixels.len() { continue; }
                alpha_blend_line(&mut pixels[idx..idx+4], color);
            }
        }
        if x == x2 as i32 && y == y2 as i32 { break; }
        let e2 = 2 * err;
        if e2 >= dy { err += dy; x += sx; }
        if e2 <= dx { err += dx; y += sy; }
    }
}

#[allow(clippy::too_many_arguments)]
fn blit_image_seq(pixels: &mut [u8], img_w: u32, img_h: u32, src_data: &[u8], src_w: u32, src_h: u32, dst_x: f32, dst_y: f32, dst_w: f32, dst_h: f32, shape: &str, cr: f32, border_color: (f32,f32,f32,f32), border_width: f32) {
    if src_data.is_empty() || src_w == 0 || src_h == 0 { return; }
    let px = |v: f32| (v * img_w as f32) as i32;
    let x0 = px(dst_x); let y0 = px(dst_y);
    let w = px(dst_w); let h = px(dst_h);
    if w <= 0 || h <= 0 { return; }
    let w = w as u32; let h = h as u32;
    let cx = (x0 + w as i32/2) as f32; let cy = (y0 + h as i32/2) as f32;
    let radius = (w.min(h) as f32) / 2.0;
    let cr_px = cr * w as f32;
    let stride = img_w as usize * 4;
    let ptr = pixels.as_ptr() as usize;
    let total_rows = h as usize;
    let chunks: Vec<_> = (0..h).collect();
    let chunk_size = (total_rows / rayon::current_num_threads().max(1)).max(1);
    chunks.par_chunks(chunk_size).for_each(|rows| {
        for &py in rows {
            let sy = y0 + py as i32;
            if sy < 0 || sy >= img_h as i32 { continue; }
            for pxi in 0..w {
                let sx = x0 + pxi as i32;
                if sx < 0 || sx >= img_w as i32 { continue; }
                let inside = match shape {
                    "circle" => { let dx=sx as f32-cx; let dy=sy as f32-cy; dx*dx+dy*dy<=radius*radius }
                    "rounded_rect" => inside_rounded_rect(x0 as f32, y0 as f32, w as f32, h as f32, cr_px, sx as f32, sy as f32),
                    _ => true,
                };
                if !inside { continue; }
                let su = (pxi as f32 / w as f32 * src_w as f32) as u32;
                let sv = (py as f32 / h as f32 * src_h as f32) as u32;
                let si = (sv.min(src_h-1) * src_w + su.min(src_w-1)) as usize;
                let di = (sy as u32 * stride as u32 + sx as u32 * 4) as usize;
                if si + 3 < src_data.len() {
                    unsafe {
                        let p = (ptr + di) as *mut u8;
                        *p = src_data[si];
                        *p.add(1) = src_data[si+1];
                        *p.add(2) = src_data[si+2];
                        *p.add(3) = 255;
                    }
                }
            }
        }
    });

    // Border (sequential, lightweight)
    if border_width > 0.0 && border_color.3 > 0.0 {
        let bw = border_width.max(1.0) as i32;
        for py in 0..h as i32 {
            for pxi in 0..w as i32 {
                let sx = x0 + pxi; let sy = y0 + py;
                if sx < 0 || sy < 0 || sx >= img_w as i32 || sy >= img_h as i32 { continue; }
                let on_border = match shape {
                    "circle" => { let dx=sx as f32-cx; let dy=sy as f32-cy; let dist=(dx*dx+dy*dy).sqrt(); dist>=radius-bw as f32 && dist<=radius }
                    _ => pxi < bw || pxi >= w as i32 - bw || py < bw || py >= h as i32 - bw,
                };
                if on_border {
                    let di = (sy as usize * stride + sx as usize * 4) as usize;
                    if di + 3 < pixels.len() {
                        pixels[di] = (border_color.2 * 255.0) as u8;
                        pixels[di+1] = (border_color.1 * 255.0) as u8;
                        pixels[di+2] = (border_color.0 * 255.0) as u8;
                        pixels[di+3] = (border_color.3.max(0.3) * 255.0) as u8;
                    }
                }
            }
        }
    }
}

// 5x3 digit bitmaps for step marker numbers
static DIGITS: [[u8; 15]; 10] = [
    [1,1,1, 1,0,1, 1,0,1, 1,0,1, 1,1,1],
    [0,1,0, 1,1,0, 0,1,0, 0,1,0, 1,1,1],
    [1,1,1, 0,0,1, 1,1,1, 1,0,0, 1,1,1],
    [1,1,1, 0,0,1, 0,1,1, 0,0,1, 1,1,1],
    [1,0,1, 1,0,1, 1,1,1, 0,0,1, 0,0,1],
    [1,1,1, 1,0,0, 1,1,1, 0,0,1, 1,1,1],
    [1,1,1, 1,0,0, 1,1,1, 1,0,1, 1,1,1],
    [1,1,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1],
    [1,1,1, 1,0,1, 1,1,1, 1,0,1, 1,1,1],
    [1,1,1, 1,0,1, 1,1,1, 0,0,1, 1,1,1],
];

fn draw_text(
    pixels: &mut [u8], img_w: u32, img_h: u32,
    text: &str, x: f32, y: f32, color: (f32, f32, f32, f32),
) {
    let stride = (img_w * 4) as usize;
    let r = (color.0 * 255.0) as u8;
    let g = (color.1 * 255.0) as u8;
    let b = (color.2 * 255.0) as u8;
    let a = color.3;

    let cx = (x * img_w as f32) as i32;
    let cy = (y * img_h as f32) as i32;

    // Parse digits from text
    let digits: Vec<usize> = text.chars()
        .filter_map(|c| c.to_digit(10).map(|d| d as usize))
        .collect();
    if digits.is_empty() { return; }

    let char_w = 4; // 3 pixels + 1 gap
    let total_w = (digits.len() * char_w) as i32;
    let start_x = cx - total_w / 2;
    let start_y = cy - 2;

    for (i, &d) in digits.iter().enumerate() {
        let map = &DIGITS[d.min(9)];
        let ox = start_x + (i * char_w) as i32;
        for row in 0..5 {
            for col in 0..3 {
                if map[row * 3 + col] == 1 {
                    let px = ox + col as i32;
                    let py = start_y + row as i32;
                    if px >= 0 && px < img_w as i32 && py >= 0 && py < img_h as i32 {
                        let idx = py as usize * stride + px as usize * 4;
                        if idx + 3 < pixels.len() {
                            // Alpha blend text onto existing pixel
                            let bg = pixels[idx] as f32 / 255.0;
                            let bg_g = pixels[idx+1] as f32 / 255.0;
                            let bg_r = pixels[idx+2] as f32 / 255.0;
                            pixels[idx]   = ((b as f32 * a + bg * (1.0 - a)) * 255.0) as u8;
                            pixels[idx+1] = ((g as f32 * a + bg_g * (1.0 - a)) * 255.0) as u8;
                            pixels[idx+2] = ((r as f32 * a + bg_r * (1.0 - a)) * 255.0) as u8;
                            pixels[idx+3] = 255;
                        }
                    }
                }
            }
        }
    }
}

fn magnify_seq(
    pixels: &mut [u8], img_w: u32, img_h: u32,
    screen_frame: &[u8],
    src_cx: f32, src_cy: f32, src_hw: f32, src_hh: f32,
    dst_cx: f32, dst_cy: f32, dst_r: f32,
) {
    let dst_x0 = ((dst_cx - dst_r).max(0.0) * img_w as f32) as i32;
    let dst_y0 = ((dst_cy - dst_r).max(0.0) * img_h as f32) as i32;
    let dst_x1 = ((dst_cx + dst_r).min(1.0) * img_w as f32) as i32;
    let dst_y1 = ((dst_cy + dst_r).min(1.0) * img_h as f32) as i32;
    let dst_r_px = (dst_r * img_w.min(img_h) as f32) as i32;
    let dst_r2 = (dst_r_px * dst_r_px) as f32;
    let dst_cx_px = (dst_cx * img_w as f32) as f32;
    let dst_cy_px = (dst_cy * img_h as f32) as f32;

    let src_x0 = ((src_cx - src_hw).max(0.0) * img_w as f32) as i32;
    let src_y0 = ((src_cy - src_hh).max(0.0) * img_h as f32) as i32;
    let src_w = ((src_hw * 2.0 * img_w as f32) as i32).max(1);
    let src_h = ((src_hh * 2.0 * img_h as f32) as i32).max(1);

    let stride = (img_w * 4) as usize;
    let screen_stride = (img_w * 4) as usize;

    for py in dst_y0..dst_y1 {
        let dy = py as f32 - dst_cy_px;
        for px in dst_x0..dst_x1 {
            let dx = px as f32 - dst_cx_px;
            if dx * dx + dy * dy > dst_r2 { continue; }
            // Map dest pixel to source pixel (linear)
            let su = ((dx / (dst_r_px as f32 * 2.0) + 0.5) * src_w as f32) as i32 + src_x0;
            let sv = ((dy / (dst_r_px as f32 * 2.0) + 0.5) * src_h as f32) as i32 + src_y0;
            if su < 0 || su >= img_w as i32 || sv < 0 || sv >= img_h as i32 { continue; }
            let si = sv as usize * screen_stride + su as usize * 4;
            let di = py as usize * stride + px as usize * 4;
            if si + 3 < screen_frame.len() && di + 3 < pixels.len() {
                pixels[di] = screen_frame[si];
                pixels[di+1] = screen_frame[si+1];
                pixels[di+2] = screen_frame[si+2];
                pixels[di+3] = 255;
            }
        }
    }
}

fn inside_rounded_rect(x: f32, y: f32, w: f32, h: f32, r: f32, px: f32, py: f32) -> bool {
    if px < x || py < y || px > x + w || py > y + h { return false; }
    if px < x + r && py < y + r { let dx=px-(x+r); let dy=py-(y+r); return dx*dx+dy*dy<=r*r; }
    if px > x+w-r && py < y+r { let dx=px-(x+w-r); let dy=py-(y+r); return dx*dx+dy*dy<=r*r; }
    if px < x+r && py > y+h-r { let dx=px-(x+r); let dy=py-(y+h-r); return dx*dx+dy*dy<=r*r; }
    if px > x+w-r && py > y+h-r { let dx=px-(x+w-r); let dy=py-(y+h-r); return dx*dx+dy*dy<=r*r; }
    true
}

// ── Sequential fallbacks ──

fn blend_rect_seq(pixels: &mut [u8], img_w: u32, x0: u32, y0: u32, x1: u32, y1: u32, color: (f32,f32,f32,f32)) {
    let stride = img_w as usize * 4;
    for py in y0..y1 {
        let base = py as usize * stride;
        for px in x0..x1 {
            let idx = base + px as usize * 4;
            if idx + 3 < pixels.len() { alpha_blend(&mut pixels[idx..idx+4], color); }
        }
    }
}


// ?? Parallel circle fill using rayon ??
fn blend_circle_par_raw(pixels: &mut [u8], img_w: u32, x0: u32, y0: u32, x1: u32, y1: u32, cx: f32, cy: f32, r2: f32, color: (f32,f32,f32,f32)) {
    let total = (y1.saturating_sub(y0)) as usize;
    if total < 8 { return blend_circle_seq(pixels, img_w, x0, y0, x1, y1, cx, cy, r2, color); }
    let stride = img_w as usize * 4;
    let ptr = pixels.as_ptr() as usize;
    let chunks: Vec<u32> = (y0..y1).collect();
    let chunk_size = (total / rayon::current_num_threads().max(1)).max(1);
    chunks.par_chunks(chunk_size).for_each(|rows| {
        if rows.is_empty() { return; }
        let offset = rows[0] as usize * stride;
        for &py in rows {
            let dy = py as f32 - cy;
            let base = py as usize * stride - offset;
            for px in x0..x1 {
                if (px as f32 - cx).powi(2) + dy.powi(2) > r2 { continue; }
                let idx = base + (px as usize) * 4;
                unsafe {
                    let p = (ptr + offset + idx) as *mut u8;
                    alpha_blend(std::slice::from_raw_parts_mut(p, 4), color);
                }
            }
        }
    });
}

// ?? Parallel magnifier using rayon ??
fn magnify_par_raw(
    pixels: &mut [u8], img_w: u32, img_h: u32,
    screen_frame: &[u8],
    src_cx: f32, src_cy: f32, src_hw: f32, src_hh: f32,
    dst_cx: f32, dst_cy: f32, dst_r: f32,
) {
    let dst_x0 = ((dst_cx - dst_r).max(0.0) * img_w as f32) as i32;
    let dst_y0 = ((dst_cy - dst_r).max(0.0) * img_h as f32) as i32;
    let dst_x1 = ((dst_cx + dst_r).min(1.0) * img_w as f32) as i32;
    let dst_y1 = ((dst_cy + dst_r).min(1.0) * img_h as f32) as i32;
    let total = (dst_y1 - dst_y0) as usize;
    if total < 8 { return magnify_seq(pixels, img_w, img_h, screen_frame, src_cx, src_cy, src_hw, src_hh, dst_cx, dst_cy, dst_r); }

    let dst_r_px = (dst_r * (img_w.min(img_h)) as f32) as i32;
    let dst_r2 = (dst_r_px * dst_r_px) as f32;
    let dst_cx_px = (dst_cx * img_w as f32) as f32;
    let dst_cy_px = (dst_cy * img_h as f32) as f32;
    let src_x0 = ((src_cx - src_hw).max(0.0) * img_w as f32) as i32;
    let src_y0 = ((src_cy - src_hh).max(0.0) * img_h as f32) as i32;
    let src_w = ((src_hw * 2.0 * img_w as f32) as i32).max(1);
    let src_h = ((src_hh * 2.0 * img_h as f32) as i32).max(1);
    let stride = (img_w * 4) as usize;
    let screen_stride = (img_w * 4) as usize;
    let pix_ptr = pixels.as_ptr() as usize;
    let scr_ptr = screen_frame.as_ptr() as usize;

    let chunks: Vec<i32> = (dst_y0..dst_y1).collect();
    let chunk_size = (total / rayon::current_num_threads().max(1)).max(1);
    chunks.par_chunks(chunk_size).for_each(|rows| {
        for &py in rows {
            let dy = py as f32 - dst_cy_px;
            let di_base = py as usize * stride;
            for px in dst_x0..dst_x1 {
                let dx = px as f32 - dst_cx_px;
                if dx * dx + dy * dy > dst_r2 { continue; }
                let su = ((dx / (dst_r_px as f32 * 2.0) + 0.5) * src_w as f32) as i32 + src_x0;
                let sv = ((dy / (dst_r_px as f32 * 2.0) + 0.5) * src_h as f32) as i32 + src_y0;
                if su < 0 || su >= img_w as i32 || sv < 0 || sv >= img_h as i32 { continue; }
                let si = sv as usize * screen_stride + su as usize * 4;
                let di = di_base + px as usize * 4;
                if si + 3 < screen_frame.len() && di + 3 < pixels.len() {
                    unsafe {
                        let dst = (pix_ptr + di) as *mut u8;
                        let src = (scr_ptr + si) as *const u8;
                        *dst = *src;
                        *dst.add(1) = *src.add(1);
                        *dst.add(2) = *src.add(2);
                        *dst.add(3) = 255;
                    }
                }
            }
        }
    });
}

// ?? Parallel blit_image using rayon ??
fn blit_image_par_raw(
    pixels: &mut [u8], img_w: u32, img_h: u32,
    src_data: &[u8], src_w: u32, src_h: u32,
    dst_x: f32, dst_y: f32, dst_w: f32, dst_h: f32,
    shape: &str, corner_radius: f32, border_color: (f32, f32, f32, f32), border_width: f32,
) {
    // For now, delegate to sequential ? image blitting is typically small-area
    blit_image_seq(pixels, img_w, img_h, src_data, src_w, src_h, dst_x, dst_y, dst_w, dst_h, shape, corner_radius, border_color, border_width);
}

fn blend_circle_seq(pixels: &mut [u8], img_w: u32, x0: u32, y0: u32, x1: u32, y1: u32, cx: f32, cy: f32, r2: f32, color: (f32,f32,f32,f32)) {
    let stride = img_w as usize * 4;
    for py in y0..y1 {
        let dy = py as f32 - cy;
        let base = py as usize * stride;
        for px in x0..x1 {
            if (px as f32 - cx).powi(2) + dy.powi(2) > r2 { continue; }
            let idx = base + px as usize * 4;
            if idx + 3 < pixels.len() { alpha_blend(&mut pixels[idx..idx+4], color); }
        }
    }
}

#[inline(always)]
fn alpha_blend_line(pixel: &mut [u8], src: (f32,f32,f32,f32)) {
    pixel[0] = ((src.2 * src.3 + pixel[0] as f32 / 255.0 * (1.0 - src.3)) * 255.0) as u8;
    pixel[1] = ((src.1 * src.3 + pixel[1] as f32 / 255.0 * (1.0 - src.3)) * 255.0) as u8;
    pixel[2] = ((src.0 * src.3 + pixel[2] as f32 / 255.0 * (1.0 - src.3)) * 255.0) as u8;
    pixel[3] = (src.3 * 255.0) as u8;
}


