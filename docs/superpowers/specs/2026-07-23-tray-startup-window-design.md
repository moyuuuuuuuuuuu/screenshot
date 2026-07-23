# Tray-only startup window design

**Date:** 2026-07-23  
**Status:** approved for planning

## Goal

Starting the Windows desktop application must leave it running only in the
system tray. No overlay, settings panel, black rectangle, taskbar entry, or
focus change may appear until the user invokes capture or settings.

## Current evidence

The Tauri configuration already declares the `overlay` window with
`visible: false`. A Windows runtime probe nevertheless found a visible
16×16 black window at `(0, 0)` after startup. The process remained healthy
and used approximately 30–33 MB after three seconds.

## Selected approach

Keep the existing eagerly created `overlay` window and explicitly hide it
during Tauri setup after the tray and shortcut have been initialized.

This is preferred over moving or shrinking the window because a displaced
window can still receive focus and behave incorrectly on multi-monitor
desktops. It is preferred over creating the overlay lazily because that would
expand the lifecycle change and could add first-capture latency.

## Behavior

1. Tauri creates the configured `overlay` window without displaying it.
2. Setup loads settings, creates the tray, and registers the global shortcut.
3. Setup explicitly hides the `overlay` before returning.
4. Capture initiated by the shortcut or tray continues to use
   `request_capture`, which hides the overlay before desktop capture and shows
   it only after a fresh frame is ready.
5. The settings tray action may continue to show the same window deliberately.

No startup capture is performed. No off-screen positioning, zero-size window,
or delayed timer is introduced.

## Failure handling

Failure to obtain or hide the configured overlay is a startup initialization
error. The application must not silently continue with a visible or
half-initialized capture window. Existing shortcut registration error handling
remains unchanged.

## Verification

- Add a regression test that requires an explicit startup-hide operation in
  the Tauri setup path while retaining `visible: false`.
- Run the desktop test suite and TypeScript typecheck.
- Run Rust format, tests, and Clippy with warnings denied.
- Build and start the Windows debug executable.
- After three seconds, verify through the Windows window API that the overlay
  is not visible.
- Confirm capture and settings entry points still show the overlay when
  deliberately invoked.
- Confirm no long-capture implementation file changed.

## Out of scope

- Long-capture stitching, masks, preview windows, and cancellation.
- Installer signing and clean-account installation.
- Changing the tray menu, default shortcut, or settings interface.
- Lazy creation or destruction of the primary overlay window.
