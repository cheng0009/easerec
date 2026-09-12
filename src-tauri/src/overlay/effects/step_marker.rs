use crate::overlay::RenderCommand;
// Step marker effect (Cmd+2)
// Renders numbered step indicators with bounce animation

pub struct StepMarker {
    pub number: u32,
    pub x: f32,
    pub y: f32,
    /// Animation progress 0.0-1.0 for bounce
    pub anim_t: f32,
}

pub struct StepMarkerEffect {
    pub markers: Vec<StepMarker>,
    pub active: bool,
}

impl Default for StepMarkerEffect {
    fn default() -> Self {
        Self {
            markers: vec![],
            active: false,
        }
    }
}

impl StepMarkerEffect {
    pub fn add_marker(&mut self, x: f32, y: f32) {
        let n = self.markers.len() as u32 + 1;
        self.markers.push(StepMarker {
            number: n,
            x,
            y,
            anim_t: 0.0,
        });
        self.active = true;
    }

    pub fn clear(&mut self) {
        self.markers.clear();
        self.active = false;
    }

    pub fn render_commands(&self) -> Vec<RenderCommand> {
        if !self.active {
            return vec![];
        }

        let mut cmds = Vec::new();
        let bounce_scale = 1.0 + 0.3 * (1.0 - self.markers.last().map(|m| m.anim_t).unwrap_or(1.0));

        for marker in &self.markers {
            // Circle with bounce on latest
            let scale = if marker.number == self.markers.len() as u32 {
                bounce_scale
            } else {
                1.0
            };
            let r = 0.025 * scale;

            cmds.push(RenderCommand::FillCircle {
                cx: marker.x, cy: marker.y, r,
                color: (0.25, 0.5, 1.0, 0.85),
            });
            cmds.push(RenderCommand::DrawText {
                text: marker.number.to_string(),
                x: marker.x,
                y: marker.y,
                size: 24.0,
                color: (1.0, 1.0, 1.0, 1.0),
            });

            // Connection line to previous marker
            if marker.number > 1 {
                if let Some(prev) = self.markers.get(marker.number as usize - 2) {
                    cmds.push(RenderCommand::DrawLine {
                        x1: prev.x, y1: prev.y,
                        x2: marker.x, y2: marker.y,
                        width: 3.0,
                        color: (0.25, 0.5, 1.0, 0.5),
                    });
                }
            }
        }

        cmds
    }
}
