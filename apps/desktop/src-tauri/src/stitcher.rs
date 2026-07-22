#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RgbaFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrayFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OverlapMatch {
    pub overlap_rows: u32,
    pub mean_error: f32,
    pub confidence: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchError {
    InvalidFrame,
    DifferentDimensions,
    LowTexture,
    LowConfidence,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchDirection {
    Forward { overlap_rows: u32 },
    Reverse,
    Unmatched,
}

pub fn downscale_grayscale(frame: &RgbaFrame, scale: u32) -> Result<GrayFrame, MatchError> {
    let expected = frame.width as usize * frame.height as usize * 4;
    if frame.width == 0 || frame.height == 0 || frame.pixels.len() != expected {
        return Err(MatchError::InvalidFrame);
    }
    let scale = scale.max(1);
    let output_width = frame.width.div_ceil(scale);
    let output_height = frame.height.div_ceil(scale);
    let mut pixels = Vec::with_capacity(output_width as usize * output_height as usize);

    for output_y in 0..output_height {
        for output_x in 0..output_width {
            let start_x = output_x * scale;
            let start_y = output_y * scale;
            let end_x = (start_x + scale).min(frame.width);
            let end_y = (start_y + scale).min(frame.height);
            let mut sum = 0_u32;
            let mut count = 0_u32;
            for y in start_y..end_y {
                for x in start_x..end_x {
                    let offset = ((y * frame.width + x) * 4) as usize;
                    let red = u32::from(frame.pixels[offset]);
                    let green = u32::from(frame.pixels[offset + 1]);
                    let blue = u32::from(frame.pixels[offset + 2]);
                    sum += (red * 77 + green * 150 + blue * 29) >> 8;
                    count += 1;
                }
            }
            pixels.push((sum / count) as u8);
        }
    }

    Ok(GrayFrame {
        width: output_width,
        height: output_height,
        pixels,
    })
}

fn region_texture(frame: &GrayFrame, start_row: u32, rows: u32) -> f32 {
    let width = frame.width as usize;
    let start = start_row as usize;
    let end = (start_row + rows) as usize;
    let mut difference = 0_u64;
    let mut samples = 0_u64;
    for y in start..end {
        for x in 1..width {
            let offset = y * width + x;
            difference += u64::from(frame.pixels[offset].abs_diff(frame.pixels[offset - 1]));
            samples += 1;
        }
        if y > start {
            for x in 0..width {
                let offset = y * width + x;
                difference +=
                    u64::from(frame.pixels[offset].abs_diff(frame.pixels[offset - width]));
                samples += 1;
            }
        }
    }
    if samples == 0 {
        0.0
    } else {
        difference as f32 / samples as f32
    }
}

pub fn find_vertical_overlap(
    previous: &GrayFrame,
    next: &GrayFrame,
    minimum_overlap: u32,
    maximum_overlap: u32,
    minimum_texture: f32,
    minimum_confidence: f32,
) -> Result<OverlapMatch, MatchError> {
    find_vertical_overlap_in_range(
        previous,
        next,
        minimum_overlap..=maximum_overlap,
        minimum_texture,
        minimum_confidence,
    )
}

pub fn find_vertical_overlap_in_range(
    previous: &GrayFrame,
    next: &GrayFrame,
    overlap_range: std::ops::RangeInclusive<u32>,
    minimum_texture: f32,
    minimum_confidence: f32,
) -> Result<OverlapMatch, MatchError> {
    if previous.width == 0
        || previous.height == 0
        || next.width == 0
        || next.height == 0
        || previous.pixels.len() != previous.width as usize * previous.height as usize
        || next.pixels.len() != next.width as usize * next.height as usize
    {
        return Err(MatchError::InvalidFrame);
    }
    if previous.width != next.width || previous.height != next.height {
        return Err(MatchError::DifferentDimensions);
    }

    let upper = (*overlap_range.end()).min(previous.height.saturating_sub(1));
    let lower = (*overlap_range.start()).max(1).min(upper);
    if lower > upper {
        return Err(MatchError::InvalidFrame);
    }

    let mut best: Option<(u32, f32, f32)> = None;
    for overlap in lower..=upper {
        let previous_start = previous.height - overlap;
        let texture = region_texture(previous, previous_start, overlap);
        if texture < minimum_texture {
            continue;
        }
        let width = previous.width as usize;
        let sample_count = overlap as usize * width;
        let previous_offset = previous_start as usize * width;
        let difference: u64 = previous.pixels[previous_offset..previous_offset + sample_count]
            .iter()
            .zip(&next.pixels[..sample_count])
            .map(|(left, right)| u64::from(left.abs_diff(*right)))
            .sum();
        let mean_error = difference as f32 / sample_count as f32;
        if best.is_none_or(|(_, best_error, _)| mean_error < best_error) {
            best = Some((overlap, mean_error, texture));
        }
    }

    let Some((overlap_rows, mean_error, texture)) = best else {
        return Err(MatchError::LowTexture);
    };
    let fit = 1.0 - mean_error / 255.0;
    let texture_factor = (texture / (minimum_texture * 4.0).max(1.0)).min(1.0);
    let confidence = fit.clamp(0.0, 1.0) * texture_factor;
    if confidence < minimum_confidence {
        return Err(MatchError::LowConfidence);
    }
    Ok(OverlapMatch {
        overlap_rows,
        mean_error,
        confidence,
    })
}

pub fn classify_scroll_direction(
    accepted_tail: &GrayFrame,
    candidate: &GrayFrame,
    minimum_overlap: u32,
) -> MatchDirection {
    const MAX_DIRECTION_MEAN_ERROR: f32 = 32.0;
    let maximum_overlap = accepted_tail.height.saturating_sub(1);
    let forward = find_vertical_overlap(
        accepted_tail,
        candidate,
        minimum_overlap,
        maximum_overlap,
        2.0,
        0.75,
    )
    .ok()
    .filter(|matched| matched.mean_error <= MAX_DIRECTION_MEAN_ERROR);
    let reverse = find_vertical_overlap(
        candidate,
        accepted_tail,
        minimum_overlap,
        maximum_overlap,
        2.0,
        0.75,
    )
    .ok()
    .filter(|matched| matched.mean_error <= MAX_DIRECTION_MEAN_ERROR);

    match (forward, reverse) {
        (Some(forward), Some(reverse)) if reverse.confidence > forward.confidence + 0.08 => {
            MatchDirection::Reverse
        }
        (Some(forward), _) => MatchDirection::Forward {
            overlap_rows: forward.overlap_rows,
        },
        (None, Some(_)) => MatchDirection::Reverse,
        (None, None) => MatchDirection::Unmatched,
    }
}

#[derive(Default)]
pub struct ChunkedStitcher {
    width: Option<u32>,
    height: u32,
    chunks: Vec<RgbaFrame>,
    pending_footer: Option<RgbaFrame>,
}

impl ChunkedStitcher {
    pub fn append(&mut self, frame: RgbaFrame, overlap_rows: u32) -> Result<(), MatchError> {
        let expected = frame.width as usize * frame.height as usize * 4;
        if frame.width == 0 || frame.height == 0 || frame.pixels.len() != expected {
            return Err(MatchError::InvalidFrame);
        }
        if self.width.is_some_and(|width| width != frame.width) {
            return Err(MatchError::DifferentDimensions);
        }
        if overlap_rows >= frame.height && !self.chunks.is_empty() {
            return Err(MatchError::InvalidFrame);
        }

        let retained = if self.chunks.is_empty() {
            frame
        } else {
            let row_bytes = frame.width as usize * 4;
            RgbaFrame {
                width: frame.width,
                height: frame.height - overlap_rows,
                pixels: frame.pixels[overlap_rows as usize * row_bytes..].to_vec(),
            }
        };
        self.width = Some(retained.width);
        self.height = self.height.saturating_add(retained.height);
        self.chunks.push(retained);
        Ok(())
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn preview(&self) -> Result<RgbaFrame, MatchError> {
        let width = self.width.ok_or(MatchError::InvalidFrame)?;
        let footer_height = self
            .pending_footer
            .as_ref()
            .map_or(0, |footer| footer.height);
        let height = self.height.saturating_add(footer_height);
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
        for chunk in &self.chunks {
            pixels.extend_from_slice(&chunk.pixels);
        }
        if let Some(footer) = &self.pending_footer {
            pixels.extend_from_slice(&footer.pixels);
        }
        Ok(RgbaFrame {
            width,
            height,
            pixels,
        })
    }

    pub fn append_with_static_regions(
        &mut self,
        frame: RgbaFrame,
        overlap_rows: u32,
        top_static_rows: u32,
        bottom_static_rows: u32,
        static_confidence: f32,
        is_final: bool,
    ) -> Result<(), MatchError> {
        if static_confidence < 0.9 || top_static_rows + bottom_static_rows >= frame.height {
            return self.append(frame, overlap_rows);
        }
        let row_bytes = frame.width as usize * 4;
        let first_frame = self.chunks.is_empty();
        let content_start = if first_frame {
            0
        } else {
            overlap_rows.max(top_static_rows)
        };
        let content_end = frame.height - bottom_static_rows;
        if content_start < content_end {
            self.append(
                RgbaFrame {
                    width: frame.width,
                    height: content_end - content_start,
                    pixels: frame.pixels
                        [content_start as usize * row_bytes..content_end as usize * row_bytes]
                        .to_vec(),
                },
                0,
            )?;
        }

        if bottom_static_rows > 0 {
            self.pending_footer = Some(RgbaFrame {
                width: frame.width,
                height: bottom_static_rows,
                pixels: frame.pixels[content_end as usize * row_bytes..].to_vec(),
            });
        }
        if is_final {
            if let Some(footer) = self.pending_footer.take() {
                self.append(footer, 0)?;
            }
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<RgbaFrame, MatchError> {
        if let Some(footer) = self.pending_footer.take() {
            self.append(footer, 0)?;
        }
        let width = self.width.ok_or(MatchError::InvalidFrame)?;
        let capacity = width as usize * self.height as usize * 4;
        let mut pixels = Vec::with_capacity(capacity);
        for chunk in self.chunks {
            pixels.extend_from_slice(&chunk.pixels);
        }
        Ok(RgbaFrame {
            width,
            height: self.height,
            pixels,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_scroll_direction, downscale_grayscale, find_vertical_overlap, ChunkedStitcher,
        MatchDirection, MatchError, RgbaFrame,
    };

    fn document_frame(start_row: u32, height: u32, width: u32) -> RgbaFrame {
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
        for y in start_row..start_row + height {
            for x in 0..width {
                let value = ((y * 37 + x * 71 + y * x * 3) % 251) as u8;
                pixels.extend_from_slice(&[value, value.wrapping_add(31), value / 2, 255]);
            }
        }
        RgbaFrame {
            width,
            height,
            pixels,
        }
    }

    fn match_frames(previous: &RgbaFrame, next: &RgbaFrame) -> Result<u32, MatchError> {
        let previous = downscale_grayscale(previous, 1)?;
        let next = downscale_grayscale(next, 1)?;
        Ok(find_vertical_overlap(&previous, &next, 4, 36, 2.0, 0.8)?.overlap_rows)
    }

    #[test]
    fn finds_overlap_in_normal_content() {
        assert_eq!(
            match_frames(&document_frame(0, 40, 8), &document_frame(20, 40, 8)),
            Ok(20)
        );
    }

    #[test]
    fn supports_variable_scroll_steps() {
        assert_eq!(
            match_frames(&document_frame(0, 40, 8), &document_frame(13, 40, 8)),
            Ok(27)
        );
        assert_eq!(
            match_frames(&document_frame(0, 40, 8), &document_frame(28, 40, 8)),
            Ok(12)
        );
    }

    #[test]
    fn rejects_low_texture_content() {
        let blank = RgbaFrame {
            width: 8,
            height: 40,
            pixels: vec![128; 8 * 40 * 4],
        };
        assert_eq!(match_frames(&blank, &blank), Err(MatchError::LowTexture));
    }

    #[test]
    fn classifies_forward_and_reverse_scrolling() {
        let first = downscale_grayscale(&document_frame(0, 40, 8), 1).unwrap();
        let forward = downscale_grayscale(&document_frame(20, 40, 8), 1).unwrap();
        let reverse = downscale_grayscale(&document_frame(10, 40, 8), 1).unwrap();

        assert_eq!(
            classify_scroll_direction(&first, &forward, 4),
            MatchDirection::Forward { overlap_rows: 20 }
        );
        assert_eq!(
            classify_scroll_direction(&forward, &reverse, 4),
            MatchDirection::Reverse
        );
    }

    #[test]
    fn classifies_unrelated_frames_as_unmatched() {
        let first = downscale_grayscale(&document_frame(0, 40, 8), 1).unwrap();
        let mut seed = 0x9e37_79b9_u32;
        let unrelated = super::GrayFrame {
            width: 8,
            height: 40,
            pixels: (0..320)
                .map(|_| {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (seed >> 24) as u8
                })
                .collect(),
        };

        assert_eq!(
            classify_scroll_direction(&first, &unrelated, 4),
            MatchDirection::Unmatched
        );
    }

    #[test]
    fn chunked_stitcher_copies_the_complete_output_only_on_finish() {
        let first = document_frame(0, 4, 2);
        let second = document_frame(2, 4, 2);
        let expected = document_frame(0, 6, 2);
        let mut stitcher = ChunkedStitcher::default();

        stitcher.append(first, 0).unwrap();
        stitcher.append(second, 2).unwrap();
        assert_eq!(stitcher.height(), 6);
        assert_eq!(stitcher.finish().unwrap(), expected);
    }

    #[test]
    fn preview_contains_all_chunks_without_consuming_the_stitcher() {
        let mut stitcher = ChunkedStitcher::default();
        stitcher.append(document_frame(0, 4, 2), 0).unwrap();
        stitcher.append(document_frame(2, 4, 2), 2).unwrap();

        assert_eq!(stitcher.preview().unwrap(), document_frame(0, 6, 2));
        assert_eq!(stitcher.finish().unwrap(), document_frame(0, 6, 2));
    }

    #[test]
    fn fixed_header_and_footer_are_not_repeated() {
        let first = document_frame(0, 6, 2);
        let mut second = document_frame(2, 6, 2);
        let first_row_bytes = 2 * 4;
        second.pixels[..first_row_bytes].copy_from_slice(&first.pixels[..first_row_bytes]);
        let first_footer = first.pixels[5 * first_row_bytes..6 * first_row_bytes].to_vec();
        second.pixels[5 * first_row_bytes..6 * first_row_bytes].copy_from_slice(&first_footer);
        let mut stitcher = ChunkedStitcher::default();

        stitcher
            .append_with_static_regions(first, 0, 1, 1, 1.0, false)
            .unwrap();
        stitcher
            .append_with_static_regions(second, 4, 1, 1, 1.0, true)
            .unwrap();

        assert_eq!(stitcher.height(), 7);
        let output = stitcher.finish().unwrap();
        assert_eq!(
            &output.pixels[..first_row_bytes],
            &document_frame(0, 1, 2).pixels
        );
        assert_eq!(&output.pixels[6 * first_row_bytes..], &first_footer);
    }
}
