use std::time::Duration;

pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(120);
pub const STABLE_FOR: Duration = Duration::from_millis(200);
pub const COMPLETE_AFTER: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Observation {
    Unchanged,
    MotionStarted,
    Stabilizing,
    StableFrame,
    IdleComplete,
}

pub struct RegionObserver {
    change_threshold: f64,
    previous: Option<Vec<u8>>,
    motion_active: bool,
    last_change: Duration,
    last_activity: Duration,
    last_append: Option<Duration>,
}

impl RegionObserver {
    pub fn new(change_threshold: f64) -> Self {
        Self {
            change_threshold,
            previous: None,
            motion_active: false,
            last_change: Duration::ZERO,
            last_activity: Duration::ZERO,
            last_append: None,
        }
    }

    pub fn observe(&mut self, pixels: &[u8], now: Duration) -> Observation {
        let changed = self
            .previous
            .as_deref()
            .is_some_and(|previous| sample_difference(previous, pixels) > self.change_threshold);
        self.previous = Some(pixels.to_vec());

        if changed {
            self.last_change = now;
            self.last_activity = now;
            if self.motion_active {
                return Observation::Stabilizing;
            }
            self.motion_active = true;
            return Observation::MotionStarted;
        }

        if self.motion_active {
            if now.saturating_sub(self.last_change) >= STABLE_FOR {
                self.motion_active = false;
                return Observation::StableFrame;
            }
            return Observation::Stabilizing;
        }

        if let Some(appended_at) = self.last_append {
            let idle_since = appended_at.max(self.last_activity);
            if now.saturating_sub(idle_since) >= COMPLETE_AFTER {
                return Observation::IdleComplete;
            }
        }

        Observation::Unchanged
    }

    pub fn mark_appended(&mut self, now: Duration) {
        self.last_append = Some(now);
        self.last_activity = now;
    }
}

fn sample_difference(previous: &[u8], current: &[u8]) -> f64 {
    if previous.len() != current.len() || current.is_empty() {
        return 1.0;
    }
    let changed = previous
        .iter()
        .zip(current)
        .filter(|(left, right)| left.abs_diff(**right) > 3)
        .count();
    changed as f64 / current.len() as f64
}

#[cfg(test)]
mod tests {
    use super::{Observation, RegionObserver, COMPLETE_AFTER, STABLE_FOR};
    use std::time::Duration;

    #[test]
    fn idle_completion_requires_an_appended_frame() {
        let mut observer = RegionObserver::new(0.01);
        assert_eq!(
            observer.observe(&[0; 16], Duration::ZERO),
            Observation::Unchanged
        );
        assert_ne!(
            observer.observe(&[0; 16], COMPLETE_AFTER),
            Observation::IdleComplete
        );
        observer.mark_appended(Duration::ZERO);
        assert_eq!(
            observer.observe(&[0; 16], COMPLETE_AFTER),
            Observation::IdleComplete
        );
    }

    #[test]
    fn motion_becomes_one_stable_frame_after_the_stability_window() {
        let mut observer = RegionObserver::new(0.25);
        observer.observe(&[0; 16], Duration::ZERO);
        assert_eq!(
            observer.observe(&[255; 16], Duration::from_millis(10)),
            Observation::MotionStarted
        );
        assert_eq!(
            observer.observe(&[255; 16], Duration::from_millis(100)),
            Observation::Stabilizing
        );
        assert_eq!(
            observer.observe(&[255; 16], Duration::from_millis(10) + STABLE_FOR),
            Observation::StableFrame
        );
        assert_eq!(
            observer.observe(&[255; 16], Duration::from_millis(400)),
            Observation::Unchanged
        );
    }

    #[test]
    fn renewed_motion_resets_stability_and_idle_completion() {
        let mut observer = RegionObserver::new(0.25);
        observer.observe(&[0; 16], Duration::ZERO);
        observer.mark_appended(Duration::ZERO);
        observer.observe(&[255; 16], Duration::from_millis(100));
        assert_eq!(
            observer.observe(&[64; 16], Duration::from_millis(250)),
            Observation::Stabilizing
        );
        assert_eq!(
            observer.observe(&[64; 16], Duration::from_millis(450)),
            Observation::StableFrame
        );
        assert_ne!(
            observer.observe(&[64; 16], Duration::from_millis(2_050)),
            Observation::IdleComplete
        );
    }

    #[test]
    fn different_sample_lengths_are_treated_as_motion() {
        let mut observer = RegionObserver::new(0.25);
        observer.observe(&[0; 16], Duration::ZERO);
        assert_eq!(
            observer.observe(&[0; 8], Duration::from_millis(10)),
            Observation::MotionStarted
        );
    }
}
