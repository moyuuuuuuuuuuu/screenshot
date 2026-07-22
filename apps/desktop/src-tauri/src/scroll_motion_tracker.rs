use std::ops::RangeInclusive;

use crate::stitcher::GrayFrame;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MotionEstimate {
    Stationary,
    Forward { dy: i32, confidence: f32 },
    Reverse { dy: i32, confidence: f32 },
    Uncertain,
}

pub struct ScrollMotionTracker {
    width: u32,
    height: u32,
    previous: Option<GrayFrame>,
    accumulated_offset: i64,
    last_forward_dy: Option<u32>,
}

impl ScrollMotionTracker {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            previous: None,
            accumulated_offset: 0,
            last_forward_dy: None,
        }
    }

    pub fn observe(&mut self, frame: &GrayFrame) -> MotionEstimate {
        if !self.is_valid(frame) {
            return MotionEstimate::Uncertain;
        }
        let Some(previous) = self.previous.replace(frame.clone()) else {
            return MotionEstimate::Stationary;
        };

        if aligned_mean_error(&previous, frame) <= 0.5 {
            return MotionEstimate::Stationary;
        }
        if frame_texture(frame) < 2.0 || frame_texture(&previous) < 2.0 {
            return MotionEstimate::Uncertain;
        }

        let maximum_shift = (self.height / 2).clamp(1, 32) as i32;
        let mut candidates = (-maximum_shift..=maximum_shift)
            .filter(|shift| *shift != 0)
            .filter_map(|shift| {
                shifted_mean_error(&previous, frame, shift).map(|error| (shift, error))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| left.1.total_cmp(&right.1));
        let Some(&(dy, best_error)) = candidates.first() else {
            return MotionEstimate::Uncertain;
        };
        let second_error = candidates.get(1).map_or(255.0, |candidate| candidate.1);
        let separation = ((second_error - best_error) / second_error.max(1.0)).clamp(0.0, 1.0);
        let fit = (1.0 - best_error / 32.0).clamp(0.0, 1.0);
        let confidence = fit * separation;
        if best_error > 18.0 || confidence < 0.65 {
            return MotionEstimate::Uncertain;
        }

        if dy > 0 {
            self.accumulated_offset += i64::from(dy);
            self.last_forward_dy = Some(dy as u32);
            MotionEstimate::Forward { dy, confidence }
        } else {
            MotionEstimate::Reverse { dy, confidence }
        }
    }

    pub fn expected_overlap(&self) -> Option<RangeInclusive<u32>> {
        let dy = self.last_forward_dy?;
        let center = self
            .height
            .saturating_sub(dy)
            .clamp(1, self.height.saturating_sub(1));
        let tolerance = (dy / 2 + 2).max(3);
        Some(
            center.saturating_sub(tolerance).max(1)
                ..=(center + tolerance).min(self.height.saturating_sub(1)),
        )
    }

    pub fn accumulated_offset(&self) -> i64 {
        self.accumulated_offset
    }

    fn is_valid(&self, frame: &GrayFrame) -> bool {
        frame.width == self.width
            && frame.height == self.height
            && frame.pixels.len() == self.width as usize * self.height as usize
            && self.width > 0
            && self.height > 2
    }
}

fn aligned_mean_error(left: &GrayFrame, right: &GrayFrame) -> f32 {
    left.pixels
        .iter()
        .zip(&right.pixels)
        .map(|(a, b)| u64::from(a.abs_diff(*b)))
        .sum::<u64>() as f32
        / left.pixels.len().max(1) as f32
}

fn frame_texture(frame: &GrayFrame) -> f32 {
    let width = frame.width as usize;
    let margin = (frame.height / 12).max(2) as usize;
    let mut difference = 0_u64;
    let mut samples = 0_u64;
    for y in margin..frame.height as usize - margin {
        for x in 1..width {
            let index = y * width + x;
            difference += u64::from(frame.pixels[index].abs_diff(frame.pixels[index - 1]));
            samples += 1;
        }
    }
    difference as f32 / samples.max(1) as f32
}

fn shifted_mean_error(previous: &GrayFrame, current: &GrayFrame, dy: i32) -> Option<f32> {
    let width = previous.width as usize;
    let margin = (previous.height / 12).max(2) as i32;
    let end = previous.height as i32 - margin;
    let mut difference = 0_u64;
    let mut samples = 0_u64;
    for current_y in margin..end {
        let previous_y = current_y + dy;
        if previous_y < margin || previous_y >= end {
            continue;
        }
        let current_offset = current_y as usize * width;
        let previous_offset = previous_y as usize * width;
        for x in 0..width {
            difference += u64::from(
                previous.pixels[previous_offset + x].abs_diff(current.pixels[current_offset + x]),
            );
            samples += 1;
        }
    }
    (samples > 0).then_some(difference as f32 / samples as f32)
}
