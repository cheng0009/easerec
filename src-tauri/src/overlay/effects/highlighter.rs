use crate::overlay::RenderCommand;
// Highlighter pen effect (Cmd+3)
// Renders a smooth pen stroke that fades after release

use std::time::Instant;

pub struct HighlighterEffect {
    pub active: bool,
    pub strokes: Vec<Stroke>,
    pub current_stroke: Vec<(f32, f32)>,
    pub is_drawing: bool,
    pub fade_duration_secs: f32,
}

#[derive(Clone)]
pub struct Stroke {
    pub points: Vec<(f32, f32)>,
    pub color: (f32, f32, f32, f32),
    pub width: f32,
    pub start_time: Instant,
}

impl Default for HighlighterEffect {
    fn default() -> Self {
        Self {
            active: false,
            strokes: vec![],
            current_stroke: vec![],
            is_drawing: false,
            fade_duration_secs: 3.0,
        }
    }
}

impl HighlighterEffect {
    pub fn begin_stroke(&mut self, x: f32, y: f32) {
        self.is_drawing = true;
        self.active = true;
        self.current_stroke = vec![(x, y)];
    }

    pub fn add_point(&mut self, x: f32, y: f32) {
        if self.is_drawing {
            self.current_stroke.push((x, y));
        }
    }

    pub fn end_stroke(&mut self) {
        if self.is_drawing && !self.current_stroke.is_empty() {
            self.strokes.push(Stroke {
                points: std::mem::take(&mut self.current_stroke),
                color: (1.0, 0.9, 0.2, 0.7),
                width: 4.0,
                start_time: Instant::now(),
            });
        }
        self.is_drawing = false;
    }

    /// Remove strokes that have faded out
    pub fn cleanup(&mut self) {
        let now = Instant::now();
        self.strokes.retain(|s| {
            let elapsed = now.duration_since(s.start_time).as_secs_f32();
            elapsed < self.fade_duration_secs
        });
    }

    pub fn render_commands(&mut self) -> Vec<RenderCommand> {
        self.cleanup();
        let mut cmds = Vec::new();

        // Render completed strokes with fade
        let now = Instant::now();
        for stroke in &self.strokes {
            let elapsed = now.duration_since(stroke.start_time).as_secs_f32();
            let alpha = (1.0 - elapsed / self.fade_duration_secs).max(0.0);
            let (r, g, b, a) = stroke.color;
            let fade_color = (r, g, b, a * alpha);

            if stroke.points.len() >= 2 {
                for window in stroke.points.windows(2) {
                    cmds.push(RenderCommand::DrawLine {
                        x1: window[0].0, y1: window[0].1,
                        x2: window[1].0, y2: window[1].1,
                        width: stroke.width,
                        color: fade_color,
                    });
                }
            }
        }

        // Render current stroke
        if self.is_drawing && self.current_stroke.len() >= 2 {
            for window in self.current_stroke.windows(2) {
                cmds.push(RenderCommand::DrawLine {
                    x1: window[0].0, y1: window[0].1,
                    x2: window[1].0, y2: window[1].1,
                    width: 4.0,
                    color: (1.0, 0.9, 0.2, 0.7),
                });
            }
        }

        cmds
    }
}
