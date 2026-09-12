//! Audio crossfade / splicing utilities
//! Implements short crossfade to eliminate pops at splice points

/// Apply a short crossfade between two audio segments
/// `fade_samples`: number of overlapping samples for the crossfade (e.g., 441 = 10ms @ 44.1kHz)
pub fn crossfade(
    before: &[f32],
    after: &[f32],
    fade_samples: usize,
) -> Vec<f32> {
    if fade_samples == 0 || before.is_empty() || after.is_empty() {
        let mut result = before.to_vec();
        result.extend_from_slice(after);
        return result;
    }

    let fade = fade_samples.min(before.len()).min(after.len());
    let total = before.len() + after.len() - fade;

    let mut result = Vec::with_capacity(total);

    // Copy pre-fade samples from "before"
    result.extend_from_slice(&before[..before.len() - fade]);

    // Crossfade overlap region
    for i in 0..fade {
        let t = i as f32 / fade as f32;
        let before_sample = before[before.len() - fade + i];
        let after_sample = after[i];
        // Linear crossfade: before fades out, after fades in
        result.push(before_sample * (1.0 - t) + after_sample * t);
    }

    // Copy remaining from "after"
    result.extend_from_slice(&after[fade..]);

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crossfade_empty() {
        let result = crossfade(&[], &[], 10);
        assert!(result.is_empty());
    }

    #[test]
    fn test_crossfade_simple() {
        let before = vec![1.0; 100];
        let after = vec![0.0; 100];
        let result = crossfade(&before, &after, 10);
        // Should have 100 + 100 - 10 = 190 samples
        assert_eq!(result.len(), 190);
        // First 90 should be 1.0
        assert!((result[0] - 1.0).abs() < 0.001);
        assert!((result[89] - 1.0).abs() < 0.001);
        // Last 90 should be 0.0
        assert!((result[189] - 0.0).abs() < 0.001);
    }

    #[test]
    fn test_crossfade_short() {
        let before = vec![1.0, 1.0, 1.0];
        let after = vec![0.0, 0.0, 0.0];
        let result = crossfade(&before, &after, 2);
        assert_eq!(result.len(), 4);
    }
}
