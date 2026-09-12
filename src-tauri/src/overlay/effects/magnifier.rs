use crate::overlay::RenderCommand;
// Magnifier + Spotlight effect (Cmd+1)
// Renders a circular magnified region with dark vignette

pub struct MagnifierEffect {
    pub active: bool,
    /// Center position (screen coords, normalized 0-1)
    pub center_x: f32,
    pub center_y: f32,
    /// Radius of magnification circle (normalized 0-1)
    pub radius: f32,
    /// Zoom factor (1.5x - 3.0x)
    pub zoom: f32,
    /// Vignette darkness (0.0 - 1.0)
    pub vignette: f32,
}

impl Default for MagnifierEffect {
    fn default() -> Self {
        Self {
            active: false,
            center_x: 0.5,
            center_y: 0.5,
            radius: 0.15,
            zoom: 2.0,
            vignette: 0.6,
        }
    }
}

impl MagnifierEffect {
    pub fn render_commands(&self) -> Vec<RenderCommand> {
        if !self.active {
            return vec![];
        }

        vec![
            // Full-screen dark overlay (vignette)
            RenderCommand::FillRect {
                x: 0.0, y: 0.0, w: 1.0, h: 1.0,
                color: (0.0, 0.0, 0.0, self.vignette),
            },
            // Magnified circle cutout (bright center)
            RenderCommand::FillCircle {
                cx: self.center_x,
                cy: self.center_y,
                r: self.radius,
                color: (0.0, 0.0, 0.0, 0.0), // transparent = show original
            },
        ]
    }
}
