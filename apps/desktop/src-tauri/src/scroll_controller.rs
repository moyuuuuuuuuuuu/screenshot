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
    Scrolling,
    Stabilizing,
    Matching,
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
            self.state = LongCaptureState::Scrolling;
        } else {
            self.state = LongCaptureState::Matching;
        }
        Ok(())
    }

    pub fn scroll_sent(&mut self) -> Result<(), SessionError> {
        if self.state != LongCaptureState::Scrolling {
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
            self.state = LongCaptureState::Scrolling;
        }
        Ok(())
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
        session.begin_capture(Duration::ZERO).unwrap();
        session.frame_captured(height).unwrap();
        session
    }

    #[test]
    fn first_frame_is_required_before_scrolling() {
        let mut session = LongCaptureSession::default();
        session.start().unwrap();
        assert_eq!(session.scroll_sent(), Err(SessionError::InvalidTransition));

        session.begin_capture(Duration::ZERO).unwrap();
        session.frame_captured(800).unwrap();
        assert_eq!(session.state(), LongCaptureState::Scrolling);
    }

    #[test]
    fn two_no_content_matches_complete_the_session() {
        let mut session = session_with_first_frame(800);
        for expected_state in [LongCaptureState::Scrolling, LongCaptureState::Completed] {
            session.scroll_sent().unwrap();
            session.begin_capture(Duration::ZERO).unwrap();
            session.frame_captured(800).unwrap();
            session.match_completed(0).unwrap();
            assert_eq!(session.state(), expected_state);
        }
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
        session.scroll_sent().unwrap();
        assert_eq!(
            session.begin_capture(MAX_DURATION),
            Err(SessionError::ResourceLimit)
        );
        assert_eq!(session.state(), LongCaptureState::Partial);
    }

    #[test]
    fn frame_limit_stops_the_session() {
        let mut session = session_with_first_frame(1);
        for _ in 1..MAX_FRAMES {
            session.scroll_sent().unwrap();
            session.begin_capture(Duration::ZERO).unwrap();
            session.frame_captured(1).unwrap();
            session.match_completed(1).unwrap();
        }
        assert_eq!(session.state(), LongCaptureState::Partial);
        assert_eq!(session.frame_count(), MAX_FRAMES);
    }

    #[test]
    fn height_limit_stops_with_the_completed_pixels() {
        let mut session = session_with_first_frame(59_500);
        session.scroll_sent().unwrap();
        session.begin_capture(Duration::ZERO).unwrap();
        session.frame_captured(800).unwrap();
        session.match_completed(500).unwrap();

        assert_eq!(session.state(), LongCaptureState::Partial);
        assert_eq!(session.stitched_height(), 60_000);
    }
}
