#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StabilityObservation {
    Unstable { difference: f32 },
    Stable { difference: f32 },
}

pub struct FrameStabilitySampler {
    previous: Option<Vec<u8>>,
    stable_samples: u8,
    required_stable_samples: u8,
    difference_threshold: f32,
}

impl FrameStabilitySampler {
    pub fn new(required_stable_samples: u8, difference_threshold: f32) -> Self {
        Self {
            previous: None,
            stable_samples: 0,
            required_stable_samples: required_stable_samples.max(1),
            difference_threshold: difference_threshold.clamp(0.0, 1.0),
        }
    }

    pub fn observe(&mut self, grayscale: &[u8]) -> Result<StabilityObservation, &'static str> {
        if grayscale.is_empty() {
            return Err("stability frame cannot be empty");
        }
        let Some(previous) = self.previous.replace(grayscale.to_vec()) else {
            return Ok(StabilityObservation::Unstable { difference: 1.0 });
        };
        if previous.len() != grayscale.len() {
            self.stable_samples = 0;
            return Err("stability frame dimensions changed");
        }

        let total_difference: u64 = previous
            .iter()
            .zip(grayscale)
            .map(|(left, right)| u64::from(left.abs_diff(*right)))
            .sum();
        let difference = total_difference as f32 / (grayscale.len() as f32 * 255.0);
        if difference <= self.difference_threshold {
            self.stable_samples = self.stable_samples.saturating_add(1);
        } else {
            self.stable_samples = 0;
        }

        if self.stable_samples >= self.required_stable_samples {
            Ok(StabilityObservation::Stable { difference })
        } else {
            Ok(StabilityObservation::Unstable { difference })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FrameStabilitySampler, StabilityObservation};

    #[test]
    fn requires_consecutive_stable_samples() {
        let mut sampler = FrameStabilitySampler::new(2, 0.01);

        assert!(matches!(
            sampler.observe(&[10, 20, 30]).unwrap(),
            StabilityObservation::Unstable { .. }
        ));
        assert!(matches!(
            sampler.observe(&[10, 20, 30]).unwrap(),
            StabilityObservation::Unstable { .. }
        ));
        assert!(matches!(
            sampler.observe(&[10, 20, 30]).unwrap(),
            StabilityObservation::Stable { .. }
        ));
    }

    #[test]
    fn motion_resets_the_consecutive_sample_count() {
        let mut sampler = FrameStabilitySampler::new(2, 0.01);
        sampler.observe(&[0, 0]).unwrap();
        sampler.observe(&[0, 0]).unwrap();
        assert!(matches!(
            sampler.observe(&[255, 255]).unwrap(),
            StabilityObservation::Unstable { .. }
        ));
        assert!(matches!(
            sampler.observe(&[255, 255]).unwrap(),
            StabilityObservation::Unstable { .. }
        ));
    }
}
