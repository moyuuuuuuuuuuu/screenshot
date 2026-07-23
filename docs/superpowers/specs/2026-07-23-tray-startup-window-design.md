# Tray-only startup verification design

**Date:** 2026-07-23
**Status:** closed after diagnosis; no runtime change required

## Goal

Verify that starting the Windows desktop application leaves it running only
in the system tray. No screenshot overlay, settings panel, black rectangle,
taskbar entry, or focus change may appear until the user invokes capture or
settings.

## Corrected diagnosis

The Tauri configuration declares the `overlay` window with `visible: false`.
An initial probe used `Process.MainWindowHandle` and reported a visible 16×16
window at `(0, 0)`. That result was incorrectly attributed to the overlay.

Enumeration of every top-level window owned by the process showed:

- `Tauri Window`, title `截图工具`, 2560×1440: not visible.
- `tray_icon_app`: not visible.
- `global_hotkey_app`: not visible.
- `Tao Thread Event Target`, 16×16: visible internal event target.
- `PseudoConsoleWindow`, 0×0: visible internal console target.

The 16×16 handle is not the screenshot surface and does not establish that a
black rectangle is rendered to the user. The actual overlay already satisfies
the no-visible-Tauri-UI requirement. Tray-icon presence, foreground focus,
and taskbar-button behavior remain manual E2 checks.

## Selected approach

Keep the existing startup behavior and `visible: false` configuration. Do not
add a redundant `hide()` call, a new startup failure path, off-screen
positioning, zero-size workarounds, timers, or lazy overlay creation.

Add a reusable Windows verification script that:

1. Refuses to run while a user-owned `screenshot-tool` process already exists.
2. Starts the requested debug executable.
3. Waits three seconds and confirms the process remains alive.
4. Enumerates top-level windows owned by that process.
5. Counts only visible windows whose class is exactly `Tauri Window`.
6. Fails if the count is nonzero.
7. Stops only the process it created.

Filtering by the Tauri window class avoids false positives from Tao, tray,
global-shortcut, IME, and pseudo-console helper windows.

## Verification result

The corrected probe passed against a fresh debug build with the original
startup implementation:

- Process remained alive.
- Visible Tauri windows: `0`.
- Working set after three seconds: `32,686,080` bytes.
- Probe exited `0` and stopped its own process.
- A shortcut lifecycle check observed `0 → 1 → 0` visible Tauri windows for
  startup, `Alt+Shift+A` capture, and `Esc` cancellation.

This is direct-executable startup evidence. It does not replace clean-account
MSI/NSIS installation, upgrade, downgrade, shortcut, tray-menu, or uninstall
acceptance.

## Out of scope

- Long-capture stitching, masks, preview windows, and cancellation.
- Installer signing and clean-account installation.
- Changing the tray menu, default shortcut, or settings interface.
- Suppressing third-party internal helper windows that are not Tauri UI.
