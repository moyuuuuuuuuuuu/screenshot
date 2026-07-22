use std::time::Duration;

pub const MAX_FRAMES: u32 = 200;
pub const MAX_HEIGHT: u32 = 60_000;
pub const MAX_DURATION: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LongCaptureState {
    #[default]
    Idle,
    Preparing,
    Capturing,
    Observing,
    Scrolling,
    Stabilizing,
    Matching,
    PausedReverse,
    Warning,
    Completed,
    Partial,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionError {
    InvalidTransition,
    ResourceLimit,
}

#[derive(Debug, Default)]
pub struct LongCaptureSession {
    state: LongCaptureState,
    frame_count: u32,
    stitched_height: u32,
    consecutive_no_content: u8,
}

impl LongCaptureSession {
    pub fn state(&self) -> LongCaptureState {
        self.state
    }

    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    pub fn stitched_height(&self) -> u32 {
        self.stitched_height
    }

    pub fn start(&mut self) -> Result<(), SessionError> {
        if self.state != LongCaptureState::Idle {
            return Err(SessionError::InvalidTransition);
        }
        self.state = LongCaptureState::Preparing;
        Ok(())
    }

    pub fn begin_capture(&mut self, elapsed: Duration) -> Result<(), SessionError> {
        if !matches!(
            self.state,
            LongCaptureState::Preparing | LongCaptureState::Stabilizing
        ) {
            return Err(SessionError::InvalidTransition);
        }
        if self.limit_reached(elapsed) {
            self.finish_for_limit();
            return Err(SessionError::ResourceLimit);
        }
        self.state = LongCaptureState::Capturing;
        Ok(())
    }

    pub fn frame_captured(&mut self, frame_height: u32) -> Result<(), SessionError> {
        if self.state != LongCaptureState::Capturing {
            return Err(SessionError::InvalidTransition);
        }
        self.frame_count = self.frame_count.saturating_add(1);
        if self.frame_count == 1 {
            self.stitched_height = frame_height;
            self.state = LongCaptureState::Observing;
        } else {
            self.state = LongCaptureState::Matching;
        }
        Ok(())
    }

    pub fn scroll_sent(&mut self) -> Result<(), SessionError> {
        if self.state != LongCaptureState::Observing {
            return Err(SessionError::InvalidTransition);
        }
        self.state = LongCaptureState::Stabilizing;
        Ok(())
    }

    pub fn match_completed(&mut self, added_height: u32) -> Result<(), SessionError> {
        if self.state != LongCaptureState::Matching {
            return Err(SessionError::InvalidTransition);
        }
        self.stitched_height = self.stitched_height.saturating_add(added_height);
        self.consecutive_no_content = if added_height == 0 {
            self.consecutive_no_content.saturating_add(1)
        } else {
            0
        };

        if self.consecutive_no_content >= 2 {
            self.state = LongCaptureState::Completed;
        } else if self.stitched_height >= MAX_HEIGHT || self.frame_count >= MAX_FRAMES {
            self.finish_for_limit();
        } else {
            self.state = LongCaptureState::Observing;
        }
        Ok(())
    }

    pub fn accept_first_frame(
        &mut self,
        frame_height: u32,
        elapsed: Duration,
    ) -> Result<(), SessionError> {
        if self.state != LongCaptureState::Preparing {
            return Err(SessionError::InvalidTransition);
        }
        self.check_limits(elapsed)?;
        self.frame_count = 1;
        self.stitched_height = frame_height;
        self.state = LongCaptureState::Observing;
        Ok(())
    }

    pub fn motion_started(&mut self) -> Result<(), SessionError> {
        if !matches!(
            self.state,
            LongCaptureState::Observing
                | LongCaptureState::PausedReverse
                | LongCaptureState::Warning
        ) {
            return Err(SessionError::InvalidTransition);
        }
        self.state = LongCaptureState::Scrolling;
        Ok(())
    }

    pub fn stable_frame_ready(&mut self) -> Result<(), SessionError> {
        if self.state != LongCaptureState::Scrolling {
            return Err(SessionError::InvalidTransition);
        }
        self.state = LongCaptureState::Matching;
        Ok(())
    }

    pub fn forward_matched(&mut self, added_height: u32) -> Result<(), SessionError> {
        if self.state != LongCaptureState::Matching {
            return Err(SessionError::InvalidTransition);
        }
        self.frame_count = self.frame_count.saturating_add(1);
        self.stitched_height = self.stitched_height.saturating_add(added_height);
        if self.frame_count >= MAX_FRAMES || self.stitched_height >= MAX_HEIGHT {
            self.finish_for_limit();
        } else {
            self.state = LongCaptureState::Observing;
        }
        Ok(())
    }

    pub fn reverse_detected(&mut self) -> Result<(), SessionError> {
        if self.state != LongCaptureState::Matching {
            return Err(SessionError::InvalidTransition);
        }
        self.state = LongCaptureState::PausedReverse;
        Ok(())
    }

    pub fn tail_recovered(&mut self) -> Result<(), SessionError> {
        if self.state != LongCaptureState::PausedReverse {
            return Err(SessionError::InvalidTransition);
        }
        self.state = LongCaptureState::Observing;
        Ok(())
    }

    pub fn unmatched(&mut self) -> Result<(), SessionError> {
        if self.state != LongCaptureState::Matching {
            return Err(SessionError::InvalidTransition);
        }
        self.state = LongCaptureState::Warning;
        Ok(())
    }

    pub fn complete(&mut self) -> Result<(), SessionError> {
        if self.frame_count == 0
            || matches!(
                self.state,
                LongCaptureState::Idle
                    | LongCaptureState::Completed
                    | LongCaptureState::Partial
                    | LongCaptureState::Failed
                    | LongCaptureState::Cancelled
            )
        {
            return Err(SessionError::InvalidTransition);
        }
        self.state = LongCaptureState::Completed;
        Ok(())
    }

    pub fn check_limits(&mut self, elapsed: Duration) -> Result<(), SessionError> {
        if self.limit_reached(elapsed) {
            self.finish_for_limit();
            Err(SessionError::ResourceLimit)
        } else {
            Ok(())
        }
    }

    pub fn request_stop(&mut self) {
        self.state = if self.frame_count == 0 {
            LongCaptureState::Cancelled
        } else {
            LongCaptureState::Partial
        };
    }

    pub fn fail(&mut self) {
        self.state = if self.frame_count == 0 {
            LongCaptureState::Failed
        } else {
            LongCaptureState::Partial
        };
    }

    fn limit_reached(&self, elapsed: Duration) -> bool {
        elapsed >= MAX_DURATION
            || self.frame_count >= MAX_FRAMES
            || self.stitched_height >= MAX_HEIGHT
    }

    fn finish_for_limit(&mut self) {
        self.state = if self.frame_count == 0 {
            LongCaptureState::Failed
        } else {
            LongCaptureState::Partial
        };
    }
}

#[cfg(test)]
mod tests {
    use super::{LongCaptureSession, LongCaptureState, SessionError, MAX_DURATION, MAX_FRAMES};
    use std::time::Duration;

    fn session_with_first_frame(height: u32) -> LongCaptureSession {
        let mut session = LongCaptureSession::default();
        session.start().unwrap();
        session.accept_first_frame(height, Duration::ZERO).unwrap();
        session
    }

    #[test]
    fn first_frame_is_required_before_observing_motion() {
        let mut session = LongCaptureSession::default();
        session.start().unwrap();
        assert_eq!(
            session.motion_started(),
            Err(SessionError::InvalidTransition)
        );

        session.accept_first_frame(800, Duration::ZERO).unwrap();
        assert_eq!(session.state(), LongCaptureState::Observing);
    }

    #[test]
    fn forward_match_returns_to_observing() {
        let mut session = session_with_first_frame(800);
        session.motion_started().unwrap();
        assert_eq!(session.state(), LongCaptureState::Scrolling);
        session.stable_frame_ready().unwrap();
        assert_eq!(session.state(), LongCaptureState::Matching);
        session.forward_matched(320).unwrap();
        assert_eq!(session.state(), LongCaptureState::Observing);
        assert_eq!(session.stitched_height(), 1_120);
    }

    #[test]
    fn reverse_scroll_pauses_until_the_tail_matches_again() {
        let mut session = session_with_first_frame(800);
        session.motion_started().unwrap();
        session.stable_frame_ready().unwrap();
        session.reverse_detected().unwrap();
        assert_eq!(session.state(), LongCaptureState::PausedReverse);
        session.tail_recovered().unwrap();
        assert_eq!(session.state(), LongCaptureState::Observing);
    }

    #[test]
    fn unmatched_frame_warns_without_counting_a_frame() {
        let mut session = session_with_first_frame(800);
        session.motion_started().unwrap();
        session.stable_frame_ready().unwrap();
        session.unmatched().unwrap();
        assert_eq!(session.state(), LongCaptureState::Warning);
        assert_eq!(session.frame_count(), 1);
        session.motion_started().unwrap();
        assert_eq!(session.state(), LongCaptureState::Scrolling);
    }

    #[test]
    fn explicit_completion_keeps_the_accepted_image() {
        let mut session = session_with_first_frame(800);
        session.complete().unwrap();
        assert_eq!(session.state(), LongCaptureState::Completed);
    }

    #[test]
    fn failure_after_a_frame_preserves_a_partial_result() {
        let mut session = session_with_first_frame(900);
        session.fail();
        assert_eq!(session.state(), LongCaptureState::Partial);
        assert_eq!(session.frame_count(), 1);
        assert_eq!(session.stitched_height(), 900);
    }

    #[test]
    fn stopping_before_a_frame_cancels_without_a_partial_result() {
        let mut session = LongCaptureSession::default();
        session.start().unwrap();
        session.request_stop();
        assert_eq!(session.state(), LongCaptureState::Cancelled);
    }

    #[test]
    fn stopping_after_a_frame_preserves_a_partial_result() {
        let mut session = session_with_first_frame(900);
        session.request_stop();
        assert_eq!(session.state(), LongCaptureState::Partial);
        assert_eq!(session.stitched_height(), 900);
    }

    #[test]
    fn elapsed_time_limit_returns_a_partial_result() {
        let mut session = session_with_first_frame(900);
        assert_eq!(
            session.check_limits(MAX_DURATION),
            Err(SessionError::ResourceLimit)
        );
        assert_eq!(session.state(), LongCaptureState::Partial);
    }

    #[test]
    fn frame_limit_stops_the_session() {
        let mut session = session_with_first_frame(1);
        for _ in 1..MAX_FRAMES {
            session.motion_started().unwrap();
            session.stable_frame_ready().unwrap();
            session.forward_matched(1).unwrap();
        }
        assert_eq!(session.state(), LongCaptureState::Partial);
        assert_eq!(session.frame_count(), MAX_FRAMES);
    }

    #[test]
    fn height_limit_stops_with_the_completed_pixels() {
        let mut session = session_with_first_frame(59_500);
        session.motion_started().unwrap();
        session.stable_frame_ready().unwrap();
        session.forward_matched(500).unwrap();

        assert_eq!(session.state(), LongCaptureState::Partial);
        assert_eq!(session.stitched_height(), 60_000);
    }
}
