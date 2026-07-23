# Tray-only Startup Verification Record

**Date:** 2026-07-23
**Status:** complete; no runtime fix required

## Goal

Determine whether the Windows application displays a screenshot window during
tray-only startup and leave a reproducible verification command for later
devices.

## Investigation

- [x] Build the unsigned debug executable without an installer.
- [x] Start it with no existing `screenshot-tool` process.
- [x] Sample `Process.MainWindowHandle`.
- [x] Enumerate every top-level window owned by the process.
- [x] Separate Tauri UI windows from framework helper windows.
- [x] Stop only the process created by the probe.

The original `Process.MainWindowHandle` check was invalid for this application.
It selected a visible 16×16 `Tao Thread Event Target`, not the hidden
2560×1440 `Tauri Window` screenshot overlay.

## Decision

The user selected the minimal option:

- Keep `app.windows[0].visible: false`.
- Do not add another startup `hide()` call.
- Do not introduce a new startup failure path for behavior already working.
- Ignore Tao, tray, global-shortcut, IME, and pseudo-console helper handles.
- Fail verification only when a process-owned `Tauri Window` is visible.

## Tracked change

Create `scripts/verify-windows-startup.ps1`. The script:

- rejects a pre-existing `screenshot-tool` process;
- launches the requested debug executable;
- waits three seconds;
- requires the process to remain alive;
- enumerates top-level windows by process ID;
- counts visible windows with class name `Tauri Window`;
- fails when that count is nonzero;
- reports the idle working-set size;
- stops only its own process.

No Rust, TypeScript, Tauri configuration, or long-capture implementation file
is changed.

## Verification

Run:

```powershell
pnpm --filter @screenshot/desktop tauri:build --debug --no-bundle --no-sign
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/verify-windows-startup.ps1
```

Observed:

```text
ProcessAlive         : True
VisibleTauriWindows  : 0
WorkingSetBytes      : 32686080
```

The command exited `0`, and no `screenshot-tool` process remained afterward.
An additional shortcut lifecycle check observed visible Tauri window counts
of `0` after startup, `1` after `Alt+Shift+A`, and `0` after `Esc`.

## Remaining E2 boundary

This result verifies only direct-executable tray startup. Clean-account
MSI/NSIS installation, upgrade, downgrade, shortcut, tray-menu, signed
artifact, and uninstall acceptance remain pending in
`docs/release-checklist.md`.
