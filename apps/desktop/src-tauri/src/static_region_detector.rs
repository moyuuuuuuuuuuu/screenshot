use crate::stitcher::{GrayFrame, MatchError};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StaticRegions {
    pub top_rows: u32,
    pub bottom_rows: u32,
    pub confidence: f32,
}

pub fn detect_static_regions(
    frames: &[GrayFrame],
    pixel_tolerance: u8,
    required_row_coverage: f32,
    minimum_region_rows: u32,
) -> Result<StaticRegions, MatchError> {
    let Some(reference) = frames.first() else {
        return Err(MatchError::InvalidFrame);
    };
    if frames.len() < 2
        || reference.width == 0
        || reference.height == 0
        || frames.iter().any(|frame| {
            frame.width != reference.width
                || frame.height != reference.height
                || frame.pixels.len() != frame.width as usize * frame.height as usize
        })
    {
        return Err(MatchError::DifferentDimensions);
    }

    let required_row_coverage = required_row_coverage.clamp(0.5, 1.0);
    let width = reference.width as usize;
    let height = reference.height as usize;
    let mut row_coverages = vec![0.0_f32; height];

    for (row, coverage) in row_coverages.iter_mut().enumerate() {
        let start = row * width;
        let mut matching = 0_usize;
        for column in 0..width {
            let reference_pixel = reference.pixels[start + column];
            if frames[1..].iter().all(|frame| {
                reference_pixel.abs_diff(frame.pixels[start + column]) <= pixel_tolerance
            }) {
                matching += 1;
            }
        }
        *coverage = matching as f32 / width as f32;
    }

    let mut top_rows = row_coverages
        .iter()
        .take_while(|coverage| **coverage >= required_row_coverage)
        .count() as u32;
    let mut bottom_rows = row_coverages
        .iter()
        .rev()
        .take_while(|coverage| **coverage >= required_row_coverage)
        .count() as u32;
    if top_rows < minimum_region_rows {
        top_rows = 0;
    }
    if bottom_rows < minimum_region_rows || top_rows + bottom_rows > reference.height {
        bottom_rows = 0;
    }

    let static_rows = top_rows + bottom_rows;
    let confidence = if static_rows == 0 {
        0.0
    } else {
        let top = &row_coverages[..top_rows as usize];
        let bottom = &row_coverages[height - bottom_rows as usize..];
        top.iter().chain(bottom).sum::<f32>() / static_rows as f32
    };
    Ok(StaticRegions {
        top_rows,
        bottom_rows,
        confidence,
    })
}

#[cfg(test)]
mod tests {
    use super::{detect_static_regions, StaticRegions};
    use crate::stitcher::GrayFrame;

    fn frame(seed: u8, fixed_top: u32, fixed_bottom: u32) -> GrayFrame {
        let width = 10;
        let height = 12;
        let mut pixels = Vec::with_capacity((width * height) as usize);
        for y in 0..height {
            for x in 0..width {
                let value = if y < fixed_top {
                    20 + x as u8
                } else if y >= height - fixed_bottom {
                    210 + x as u8
                } else {
                    seed.wrapping_add((y * 17 + x * 9) as u8)
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

    #[test]
    fn detects_fixed_headers_and_footers_across_frames() {
        let regions = detect_static_regions(
            &[frame(1, 2, 2), frame(37, 2, 2), frame(91, 2, 2)],
            1,
            0.9,
            2,
        )
        .unwrap();

        assert_eq!(regions.top_rows, 2);
        assert_eq!(regions.bottom_rows, 2);
        assert_eq!(regions.confidence, 1.0);
    }

    #[test]
    fn local_floating_control_does_not_become_a_static_row() {
        let first = frame(1, 0, 0);
        let mut second = frame(40, 0, 0);
        let mut third = frame(90, 0, 0);
        for row in 3..8 {
            for column in 7..10 {
                let offset = row * 10 + column;
                second.pixels[offset] = first.pixels[offset];
                third.pixels[offset] = first.pixels[offset];
            }
        }

        assert_eq!(
            detect_static_regions(&[first, second, third], 1, 0.8, 2).unwrap(),
            StaticRegions::default()
        );
    }

    #[test]
    fn ambiguous_single_static_row_is_preserved() {
        assert_eq!(
            detect_static_regions(&[frame(1, 1, 0), frame(33, 1, 0)], 1, 0.9, 2)
                .unwrap()
                .top_rows,
            0
        );
    }
}
