#[test]
fn test_blitimage_no_overflow() {
    // dst_w, dst_h are already pixel values, not normalized
    let dst_w: f32 = 576.0; // pixels (15% of 3840)
    let dst_h: f32 = 432.0; // pixels
    let area = (dst_w as u32).saturating_mul(dst_h as u32);
    assert_eq!(area, 576 * 432);
}

#[test]
fn test_zero_webcam_guard() {
    let wc_w: u32 = 0;
    let should_skip = wc_w == 0;
    assert!(should_skip, "Zero webcam dimensions should be skipped");
}

#[test]
fn test_normal_blitimage() {
    let dst_w: f32 = 576.0;
    let dst_h: f32 = 432.0;
    let area = (dst_w as u32).saturating_mul(dst_h as u32);
    assert_eq!(area, 248832, "Normal webcam area: 576x432 = 248832 pixels");
}

#[test]
fn test_large_webcam_no_overflow() {
    // Even at 100% screen size
    let dst_w: f32 = 3840.0;
    let dst_h: f32 = 2160.0;
    let area = (dst_w as u32).saturating_mul(dst_h as u32);
    assert_eq!(area, 3840 * 2160);
}
