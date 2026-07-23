use crate::region_observer::Observation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CycleDecision {
    None,
    MotionStarted,
    StableCandidate,
}

#[derive(Debug, Default)]
pub(crate) struct StableFrameGate {
    motion_active: bool,
}

impl StableFrameGate {
    pub(crate) fn observe(&mut self, observation: Observation) -> CycleDecision {
        match observation {
            Observation::MotionStarted => {
                self.motion_active = true;
                CycleDecision::MotionStarted
            }
            Observation::StableFrame if self.motion_active => {
                self.motion_active = false;
                CycleDecision::StableCandidate
            }
            Observation::MotionFrame
            | Observation::Stabilizing
            | Observation::StableFrame
            | Observation::Unchanged
            | Observation::IdleWaiting => CycleDecision::None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CycleDecision, StableFrameGate};
    use crate::region_observer::Observation;

    #[test]
    fn motion_frames_never_become_match_candidates() {
        let mut gate = StableFrameGate::default();
        assert_eq!(
            gate.observe(Observation::MotionStarted),
            CycleDecision::MotionStarted
        );
        assert_eq!(gate.observe(Observation::MotionFrame), CycleDecision::None);
        assert_eq!(gate.observe(Observation::Stabilizing), CycleDecision::None);
    }

    #[test]
    fn a_motion_cycle_yields_exactly_one_stable_candidate() {
        let mut gate = StableFrameGate::default();
        gate.observe(Observation::MotionStarted);
        gate.observe(Observation::MotionFrame);
        assert_eq!(
            gate.observe(Observation::StableFrame),
            CycleDecision::StableCandidate
        );
        assert_eq!(gate.observe(Observation::StableFrame), CycleDecision::None);
        assert_eq!(gate.observe(Observation::Unchanged), CycleDecision::None);
    }

    #[test]
    fn a_new_motion_cycle_can_recover_after_a_failed_match() {
        let mut gate = StableFrameGate::default();
        gate.observe(Observation::MotionStarted);
        assert_eq!(
            gate.observe(Observation::StableFrame),
            CycleDecision::StableCandidate
        );
        assert_eq!(
            gate.observe(Observation::MotionStarted),
            CycleDecision::MotionStarted
        );
        assert_eq!(
            gate.observe(Observation::StableFrame),
            CycleDecision::StableCandidate
        );
    }
}
