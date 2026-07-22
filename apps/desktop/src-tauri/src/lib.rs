pub mod app_state;
pub mod capture;
pub mod frame_stability;
pub mod hotkey;
pub mod long_capture;
pub mod output;
mod platform;
pub mod region_observer;
pub mod scroll_controller;
pub mod settings;
pub mod static_region_detector;
pub mod stitcher;
pub mod tray;

#[cfg(test)]
mod capture_tests;
