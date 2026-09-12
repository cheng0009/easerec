// Cursor enhancement - smooth trajectory with Catmull-Rom spline & click ripple
// Integrated with the overlay render command system

use std::collections::VecDeque;
use std::time::Instant;

use crate::overlay::RenderCommand;

/// Catmull-Rom spline interpolation for smooth mouse trajectory
pub struct CursorSmoother {
    /// Recent cursor positions: (x, y, timestamp)
    history: VecDeque<(f32, f32, Instant)>,
    /// Maximum history points to keep
    max_history: usize,
    /// Whether smoothing is active
    pub enabled: bool,
}

impl CursorSmoother {
    pub fn new() -> Self {
        Self {
            history: VecDeque::with_capacity(16),
            max_history: 8,
            enabled: true,
        }
    }

    /// Add a new cursor position
    pub fn push(&mut self, x: f32, y: f32) {
        self.history.push_back((x, y, Instant::now()));
        if self.history.len() > self.max_history {
            self.history.pop_front();
        }
    }

    /// Get the smoothed cursor position using Catmull-Rom interpolation
    pub fn smooth_position(&self) -> Option<(f32, f32)> {
        if self.history.len() < 2 {
            return self.history.back().map(|(x, y, _)| (*x, *y));
        }

        if self.history.len() < 4 {
            // Not enough points for Catmull-Rom, use linear
            let last = self.history.back().cloned().unwrap_or((0.0, 0.0, std::time::Instant::now()));
            return Some((last.0, last.1));
        }

        // Use second-to-last point as P1 and last as P2 for smooth endpoint
        let len = self.history.len();
        let p0 = &self.history[len - 4];
        let p1 = &self.history[len - 3];
        let p2 = &self.history[len - 2];
        let p3 = &self.history[len - 1];

        // Catmull-Rom at t=1.0 (arriving at p2)
        let t = 0.5; // midpoint between p1 and p2 for smoothness
        let result = catmull_rom(
            (p0.0, p0.1), (p1.0, p1.1),
            (p2.0, p2.1), (p3.0, p3.1),
            t,
        );
        Some(result)
    }
}

/// Catmull-Rom spline interpolation at parameter t (0..1 between P1 and P2)
fn catmull_rom(
    p0: (f32, f32),
    p1: (f32, f32),
    p2: (f32, f32),
    p3: (f32, f32),
    t: f32,
) -> (f32, f32) {
    let t2 = t * t;
    let t3 = t2 * t;

    // Catmull-Rom basis functions
    let x = 0.5 * (
        (2.0 * p1.0)
        + (-p0.0 + p2.0) * t
        + (2.0 * p0.0 - 5.0 * p1.0 + 4.0 * p2.0 - p3.0) * t2
        + (-p0.0 + 3.0 * p1.0 - 3.0 * p2.0 + p3.0) * t3
    );

    let y = 0.5 * (
        (2.0 * p1.1)
        + (-p0.1 + p2.1) * t
        + (2.0 * p0.1 - 5.0 * p1.1 + 4.0 * p2.1 - p3.1) * t2
        + (-p0.1 + 3.0 * p1.1 - 3.0 * p2.1 + p3.1) * t3
    );

    (x, y)
}

/// Click ripple effect
#[derive(Debug, Clone)]
pub struct Ripple {
    /// Center position (normalized 0-1)
    pub x: f32,
    pub y: f32,
    /// Time ripple was created
    pub start_time: Instant,
    /// Ripple duration in seconds
    pub duration_secs: f32,
    /// Maximum radius (normalized 0-1)
    pub max_radius: f32,
}

pub struct RippleManager {
    pub ripples: Vec<Ripple>,
    pub enabled: bool,
}

impl RippleManager {
    pub fn new() -> Self {
        Self {
            ripples: Vec::new(),
            enabled: true,
        }
    }

    /// Add a ripple at the given position
    pub fn add(&mut self, x: f32, y: f32) {
        if !self.enabled {
            return;
        }
        self.ripples.push(Ripple {
            x,
            y,
            start_time: Instant::now(),
            duration_secs: 0.6,
            max_radius: 0.04,
        });
    }

    /// Remove expired ripples
    pub fn cleanup(&mut self) {
        let now = Instant::now();
        self.ripples.retain(|r| {
            now.duration_since(r.start_time).as_secs_f32() < r.duration_secs
        });
    }

    /// Generate render commands for active ripples
    pub fn render_commands(&mut self) -> Vec<RenderCommand> {
        self.cleanup();
        let now = Instant::now();

        self.ripples.iter().map(|r| {
            let elapsed = now.duration_since(r.start_time).as_secs_f32();
            let t = elapsed / r.duration_secs;
            let radius = r.max_radius * t;
            let alpha = (1.0 - t) * 0.5;

            RenderCommand::FillCircle {
                cx: r.x,
                cy: r.y,
                r: radius,
                color: (1.0, 1.0, 1.0, alpha),
            }
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_catmull_rom_straight_line() {
        // Points on a straight line should stay on the line
        let result = catmull_rom((0.0, 0.0), (1.0, 1.0), (2.0, 2.0), (3.0, 3.0), 0.5);
        assert!((result.0 - 1.5).abs() < 0.01);
        assert!((result.1 - 1.5).abs() < 0.01);
    }

    #[test]
    fn test_catmull_rom_endpoints() {
        let result = catmull_rom((0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0), 0.0);
        assert!((result.0 - 1.0).abs() < 0.01);
        let result = catmull_rom((0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0), 1.0);
        assert!((result.0 - 2.0).abs() < 0.01);
    }

    #[test]
    fn test_smoother_empty() {
        let smoother = CursorSmoother::new();
        assert!(smoother.smooth_position().is_none());
    }

    #[test]
    fn test_smoother_single_point() {
        let mut smoother = CursorSmoother::new();
        smoother.push(100.0, 200.0);
        let pos = smoother.smooth_position().unwrap_or((0.0, 0.0));
        assert_eq!(pos, (100.0_f32, 200.0_f32));
    }
}

