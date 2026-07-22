use crate::{
    scroll_motion_tracker::{MotionEstimate, ScrollMotionTracker},
    stitcher::{find_vertical_overlap_in_range, GrayFrame},
};

fn document_frame(offset: i32, fixed_rows: u32) -> GrayFrame {
    let width = 12_u32;
    let height = 64_u32;
    let mut pixels = Vec::with_capacity((width * height) as usize);
    for y in 0..height {
        for x in 0..width {
            let value = if y < fixed_rows || y >= height - fixed_rows {
                ((y * 11 + x * 29) % 251) as u8
            } else {
                let document_y = y as i32 + offset;
                ((document_y * 37 + x as i32 * 71 + document_y * x as i32 * 3).rem_euclid(251))
                    as u8
            };
            pixels.push(value);
        }
    }
    GrayFrame {
        width,
        height,
        pixels,
    }
}

fn forward_dy(estimate: MotionEstimate) -> i32 {
    match estimate {
        MotionEstimate::Forward { dy, confidence } => {
            assert!(confidence >= 0.65);
            dy
        }
        other => panic!("expected forward motion, got {other:?}"),
    }
}

#[test]
fn tracks_continuous_three_to_twenty_pixel_steps_and_acceleration() {
    let mut tracker = ScrollMotionTracker::new(12, 64);
    assert_eq!(
        tracker.observe(&document_frame(0, 0)),
        MotionEstimate::Stationary
    );
    assert_eq!(forward_dy(tracker.observe(&document_frame(3, 0))), 3);
    assert_eq!(forward_dy(tracker.observe(&document_frame(10, 0))), 7);
    assert_eq!(forward_dy(tracker.observe(&document_frame(30, 0))), 20);
    assert!(tracker
        .expected_overlap()
        .is_some_and(|range| range.contains(&44)));
}

#[test]
fn identifies_reverse_scrolling_without_advancing_forward_offset() {
    let mut tracker = ScrollMotionTracker::new(12, 64);
    tracker.observe(&document_frame(20, 0));
    tracker.observe(&document_frame(32, 0));
    let before = tracker.expected_overlap();

    assert!(matches!(
        tracker.observe(&document_frame(25, 0)),
        MotionEstimate::Reverse { dy: -7, .. }
    ));
    assert_eq!(tracker.expected_overlap(), before);
}

#[test]
fn ignores_fixed_headers_and_footers_when_estimating_motion() {
    let mut tracker = ScrollMotionTracker::new(12, 64);
    tracker.observe(&document_frame(0, 5));
    assert_eq!(forward_dy(tracker.observe(&document_frame(9, 5))), 9);
}

#[test]
fn rejects_repeated_rows_and_low_texture_as_uncertain() {
    let repeated = GrayFrame {
        width: 12,
        height: 64,
        pixels: vec![128; 12 * 64],
    };
    let changed = GrayFrame {
        width: 12,
        height: 64,
        pixels: vec![129; 12 * 64],
    };
    let mut tracker = ScrollMotionTracker::new(12, 64);
    tracker.observe(&repeated);
    assert_eq!(tracker.observe(&changed), MotionEstimate::Uncertain);

    let repeated_pattern = GrayFrame {
        width: 12,
        height: 64,
        pixels: (0..64)
            .flat_map(|y| vec![if y % 4 < 2 { 30 } else { 220 }; 12])
            .collect(),
    };
    tracker.observe(&repeated_pattern);
    assert_eq!(
        tracker.observe(&repeated_pattern),
        MotionEstimate::Stationary
    );
}

#[test]
fn constrains_overlap_search_to_the_motion_prediction() {
    let previous = document_frame(0, 0);
    let next = document_frame(20, 0);
    let matched = find_vertical_overlap_in_range(&previous, &next, 42..=46, 2.0, 0.8)
        .expect("predicted overlap should match");
    assert_eq!(matched.overlap_rows, 44);
}
