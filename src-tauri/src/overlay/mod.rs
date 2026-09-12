pub mod window; pub mod d2d_overlay; pub mod rewind_notifier; pub mod mouse_hook;
pub mod effects;

use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Instant;

#[derive(Debug, Clone)]
pub enum RenderCommand {
    FillRect { x: f32, y: f32, w: f32, h: f32, color: (f32, f32, f32, f32) },
    FillCircle { cx: f32, cy: f32, r: f32, color: (f32, f32, f32, f32) },
    DrawLine { x1: f32, y1: f32, x2: f32, y2: f32, width: f32, color: (f32, f32, f32, f32) },
    DrawText { text: String, x: f32, y: f32, size: f32, color: (f32, f32, f32, f32) },
    BlitImage { data: Vec<u8>, src_w: u32, src_h: u32, dst_x: f32, dst_y: f32, dst_w: f32, dst_h: f32, shape: String, corner_radius: f32, border_color: (f32, f32, f32, f32), border_width: f32 },
    Magnify { src_cx: f32, src_cy: f32, src_hw: f32, src_hh: f32, dst_cx: f32, dst_cy: f32, dst_r: f32 },
}

pub struct EffectSnapshot {
    pub magnifier_active: bool,
    pub step_marker_active: bool,
    pub highlighter_active: bool,
    pub magnifier_cx: f32, pub magnifier_cy: f32, pub magnifier_zoom: u32,
    pub step_markers: Vec<(u32, f32, f32)>,
    pub highlighter_strokes: Vec<Vec<(f32, f32)>>,
    pub ripples: Vec<(f32, f32, f32, f32)>,
}

struct MagnifierState { active: bool, cx: f32, cy: f32, zoom_level: u32 }
struct StepMarkerState { active: bool, markers: Vec<(u32, f32, f32, f32)> }
struct HighlighterState { active: bool, is_drawing: bool, strokes: Vec<Vec<(f32, f32)>>, current: Vec<(f32, f32)> }
struct RippleState { active: bool, ripples: Vec<(f32, f32, Instant)> }

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PrivacyPhase { Inactive, Adjust, Mosaic }

pub struct OverlayManager {
    magnifier: Arc<Mutex<MagnifierState>>,
    step_marker: Arc<Mutex<StepMarkerState>>,
    highlighter: Arc<Mutex<HighlighterState>>,
    ripple: Arc<Mutex<RippleState>>,
    shared_frame: Arc<Mutex<Option<(Vec<u8>, u32, u32)>>>,
    privacy_paused: Arc<AtomicBool>,
    privacy_phase: Arc<Mutex<PrivacyPhase>>,
    privacy_rewind_offset: Arc<Mutex<f64>>,
    mosaic_regions: Arc<Mutex<Vec<(f32, f32, f32, f32)>>>,
    mosaic_drag_start: Arc<Mutex<Option<(f32, f32)>>>,
    mosaic_drag_current: Arc<Mutex<Option<(f32, f32)>>>,
}

impl OverlayManager {
    pub fn new() -> Self {
        Self {
            magnifier: Arc::new(Mutex::new(MagnifierState { active: false, cx: 0.5, cy: 0.5, zoom_level: 1 })),
            step_marker: Arc::new(Mutex::new(StepMarkerState { active: false, markers: vec![] })),
            highlighter: Arc::new(Mutex::new(HighlighterState { active: false, is_drawing: false, strokes: vec![], current: vec![] })),
            ripple: Arc::new(Mutex::new(RippleState { active: false, ripples: vec![] })),
            shared_frame: Arc::new(Mutex::new(None)),
            mosaic_regions: Arc::new(Mutex::new(vec![])),
            mosaic_drag_start: Arc::new(Mutex::new(None)),
            mosaic_drag_current: Arc::new(Mutex::new(None)),
            privacy_paused: Arc::new(AtomicBool::new(false)),
            privacy_phase: Arc::new(Mutex::new(PrivacyPhase::Inactive)),
            privacy_rewind_offset: Arc::new(Mutex::new(2.0)),
        }
    }

    pub fn has_active_effects(&self) -> bool {
        self.magnifier.lock().map(|m| m.active).unwrap_or(false)
        || self.step_marker.lock().map(|m| m.active).unwrap_or(false)
        || self.highlighter.lock().map(|m| m.active).unwrap_or(false)
        || self.ripple.lock().map(|r| r.active).unwrap_or(false)
        || !self.mosaic_regions.lock().map(|m| m.is_empty()).unwrap_or(true)
    }

    /// Effects that need the overlay window (excludes ripple ? cursor-only)
    pub fn needs_overlay(&self) -> bool {
        self.magnifier.lock().map(|m| m.active).unwrap_or(false)
        || self.step_marker.lock().map(|m| m.active).unwrap_or(false)
        || self.highlighter.lock().map(|m| m.active).unwrap_or(false)
    }

    pub fn snapshot(&self) -> EffectSnapshot {
        let m = self.magnifier.lock().unwrap();
        let s = self.step_marker.lock().unwrap();
        let h = self.highlighter.lock().unwrap();
        let r = self.ripple.lock().unwrap();
        let now = Instant::now();
        EffectSnapshot {
            magnifier_active: m.active, step_marker_active: s.active, highlighter_active: h.active, magnifier_cx: m.cx, magnifier_cy: m.cy, magnifier_zoom: m.zoom_level,
            step_markers: s.markers.iter().map(|(n,x,y,_)| (*n,*x,*y)).collect(),
            highlighter_strokes: h.strokes.clone(),
            ripples: r.ripples.iter().map(|(x,y,t)| {
                let elapsed = now.duration_since(*t).as_secs_f32();
                let alpha = (1.0 - elapsed / 0.6).max(0.0);
                (*x, *y, elapsed * 0.05, alpha * 0.5)
            }).collect(),
        }
    }

    pub fn track_cursor(&self, screen_w: i32, screen_h: i32) {
        let mut pt = windows::Win32::Foundation::POINT { x: 0, y: 0 };
        unsafe { let _ = windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut pt); }
        let cx = pt.x as f32 / screen_w as f32;
        let cy = pt.y as f32 / screen_h as f32;
        if let Ok(mut m) = self.magnifier.lock() { m.cx = cx; m.cy = cy; }
    }

    pub fn add_step_marker(&self, x: f32, y: f32) {
        if let Ok(mut s) = self.step_marker.lock() {
            if s.active { let n = s.markers.len() as u32 + 1; s.markers.push((n, x, y, 0.0)); }
        }
    }

    pub fn add_ripple(&self, x: f32, y: f32) {
        if let Ok(mut r) = self.ripple.lock() { if r.active { r.ripples.push((x, y, Instant::now())); } }
    }

    pub fn highlighter_move(&self, x: f32, y: f32) {
        if let Ok(mut h) = self.highlighter.lock() { if h.active && h.is_drawing { h.current.push((x, y)); } }
    }

    pub fn highlighter_start(&self, x: f32, y: f32) {
        if let Ok(mut h) = self.highlighter.lock() { if h.active { h.is_drawing = true; h.current.push((x, y)); } }
    }

    pub fn highlighter_end(&self) {
        if let Ok(mut h) = self.highlighter.lock() {
            if h.active && h.is_drawing { h.is_drawing = false; let pts = std::mem::take(&mut h.current); if pts.len() > 1 { h.strokes.push(pts); } }
        }
    }

    pub fn collect_commands(&self) -> Vec<RenderCommand> {
        let mut cmds = Vec::new();
        let now = Instant::now();

        if let Ok(m) = self.magnifier.lock() {
            if m.active {
                let zoom_f = match m.zoom_level { 1=>1.5, 2=>2.5, 3=>4.0, _=>1.5 };
                cmds.push(RenderCommand::FillRect { x:0.0,y:0.0,w:1.0,h:1.0,color:(0.0,0.0,0.0,0.18) });
                let hw = 0.12 / zoom_f;
                cmds.push(RenderCommand::Magnify { src_cx:m.cx,src_cy:m.cy,src_hw:hw,src_hh:hw,dst_cx:m.cx,dst_cy:m.cy,dst_r:0.12 });
            }
        }

        if let Ok(s) = self.step_marker.lock() {
            for (n,x,y,_) in &s.markers {
                cmds.push(RenderCommand::FillCircle { cx:*x,cy:*y,r:0.015,color:(0.25,0.50,1.0,0.9) });
                cmds.push(RenderCommand::DrawText { text:format!("{}",n),x:*x,y:*y,size:16.0,color:(1.0,1.0,1.0,1.0) });
            }
        }

        if let Ok(h) = self.highlighter.lock() {
            for stroke in &h.strokes {
                for w in stroke.windows(2) {
                    cmds.push(RenderCommand::DrawLine { x1:w[0].0,y1:w[0].1,x2:w[1].0,y2:w[1].1,width:0.004,color:(1.0,1.0,0.0,0.8) });
                }
            }
        }

        if let Ok(r) = self.ripple.lock() {
            for (x,y,t) in &r.ripples {
                let e = now.duration_since(*t).as_secs_f32();
                let a = (1.0-e/1.0).max(0.0);
                if a>0.01 { cmds.push(RenderCommand::FillCircle { cx:*x,cy:*y,r:e*0.05+0.02,color:(1.0,1.0,1.0,a*0.3) }); }
            }
        }

        cmds
    }

    /// Start dragging a mosaic rectangle
    pub fn mosaic_drag_start(&self, x: f32, y: f32) {
        if let Ok(mut s) = self.mosaic_drag_start.lock() { *s = Some((x, y)); }
        if let Ok(mut c) = self.mosaic_drag_current.lock() { *c = Some((x, y)); }
    }
    /// Update drag position (live preview)
    pub fn mosaic_drag_update(&self, x: f32, y: f32) {
        if let Ok(mut c) = self.mosaic_drag_current.lock() { *c = Some((x, y)); }
    }
    /// Finish drag: confirm rectangle
    pub fn mosaic_drag_end(&self, x: f32, y: f32) {
        if let Ok(s_guard) = self.mosaic_drag_start.lock() {
            if let Some((sx, sy)) = *s_guard {
                let (x1, y1) = (sx.min(x), sy.min(y));
                let (x2, y2) = (sx.max(x), sy.max(y));
                if (x2 - x1) * (y2 - y1) > 0.0001 {
                    if let Ok(mut regions) = self.mosaic_regions.lock() {
                        regions.push((x1, y1, x2, y2));
                    }
                }
            }
        }
        if let Ok(mut s) = self.mosaic_drag_start.lock() { *s = None; }
        if let Ok(mut c) = self.mosaic_drag_current.lock() { *c = None; }
    }
    /// Cancel current drag
    pub fn mosaic_drag_cancel(&self) {
        if let Ok(mut s) = self.mosaic_drag_start.lock() { *s = None; }
        if let Ok(mut c) = self.mosaic_drag_current.lock() { *c = None; }
    }
    /// Get current drag preview rect if any
    pub fn get_mosaic_drag_preview(&self) -> Option<(f32, f32, f32, f32)> {
        let s = self.mosaic_drag_start.lock().ok()?.clone()?;
        let c = self.mosaic_drag_current.lock().ok()?.clone()?;
        Some((s.0.min(c.0), s.1.min(c.1), s.0.max(c.0), s.1.max(c.1)))
    }

    pub fn is_effect_active(&self, effect: &str) -> bool {
        match effect {
            "magnifier" => self.magnifier.lock().map(|m|m.active).unwrap_or(false),
            "step_marker" => self.step_marker.lock().map(|m|m.active).unwrap_or(false),
            "highlighter" => self.highlighter.lock().map(|m|m.active).unwrap_or(false),
            "ripple" => self.ripple.lock().map(|r|r.active).unwrap_or(false),
            _ => false,
        }
    }

    pub fn toggle_effect(&self, effect: &str, active: bool) {
        match effect {
            "magnifier" => { if let Ok(mut m) = self.magnifier.lock() { m.active = active; } }
            "step_marker" => { if let Ok(mut s)=self.step_marker.lock() { s.active=active; if !active { s.markers.clear(); } } }
            "highlighter" => { if let Ok(mut h)=self.highlighter.lock() { h.active=active; if !active { h.is_drawing=false; h.current.clear(); h.strokes.clear(); } } }
            "ripple" => { if let Ok(mut r)=self.ripple.lock() { r.active=active; } }
            _ => log::warn!("Unknown effect: {}", effect),
        }
    }

    pub fn get_zoom(&self) -> u32 { self.magnifier.lock().map(|m|m.zoom_level).unwrap_or(1) }
    pub fn set_zoom(&self, lvl: u32) {
        if let Ok(mut m) = self.magnifier.lock() { m.zoom_level = lvl.max(1).min(3); }
    }
    pub fn cycle_zoom(&self) {
        if let Ok(mut m) = self.magnifier.lock() { m.zoom_level = if m.zoom_level >= 3 { 1 } else { m.zoom_level + 1 }; }
    }
    pub fn set_shared_frame(&mut self, sf: Arc<Mutex<Option<(Vec<u8>, u32, u32)>>>) { self.shared_frame = sf; }
    pub fn needs_redraw(&self) -> bool { self.has_active_effects() }
    pub fn get_commands_for_compositor(&self) -> Vec<RenderCommand> { self.collect_commands() }

    pub fn add_mosaic_region(&self, x1: f32, y1: f32, x2: f32, y2: f32) {
        if let Ok(mut r) = self.mosaic_regions.lock() {
            r.push((x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)));
        }
    }
    pub fn clear_mosaic_regions(&self) {
        if let Ok(mut r) = self.mosaic_regions.lock() { r.clear(); }
    }
    pub fn get_mosaic_regions(&self) -> Vec<(f32, f32, f32, f32)> {
        self.mosaic_regions.lock().map(|r| r.clone()).unwrap_or_default()
    }
    pub fn has_mosaic_regions(&self) -> bool {
        !self.mosaic_regions.lock().map(|r| r.is_empty()).unwrap_or(true)
    }
    pub fn set_privacy_paused(&self, paused: bool) {
        self.privacy_paused.store(paused, Ordering::SeqCst);
    }
    pub fn get_privacy_phase(&self) -> PrivacyPhase { self.privacy_phase.lock().map(|p| *p).unwrap_or(PrivacyPhase::Inactive) }
    pub fn set_privacy_phase(&self, phase: PrivacyPhase) { if let Ok(mut p) = self.privacy_phase.lock() { *p = phase; } }
    pub fn get_privacy_rewind_offset(&self) -> f64 { self.privacy_rewind_offset.lock().map(|o| *o).unwrap_or(2.0) }
    pub fn adjust_rewind_offset(&self, delta: f64) -> f64 {
        if let Ok(mut o) = self.privacy_rewind_offset.lock() {
            *o = (*o + delta).max(0.0).min(30.0);
            *o
        } else { 2.0 }
    }

    pub fn is_privacy_paused(&self) -> bool {
        self.privacy_paused.load(Ordering::SeqCst)
    }

    pub fn get_magnifier_frame(&self) -> Option<(Vec<u8>,u32,u32,f32,f32,f32,u32)> {
        let m = self.magnifier.lock().ok()?;
        if !m.active { return None; }
        let sf = self.shared_frame.lock().ok()?;
        let (ref data, w, h) = sf.as_ref()?;
        Some((data.clone(), *w, *h, m.cx, m.cy, match m.zoom_level { 1=>1.5, 2=>2.5, 3=>4.0, _=>1.5 }, m.zoom_level))
    }
}

unsafe impl Send for OverlayManager {}
unsafe impl Sync for OverlayManager {}