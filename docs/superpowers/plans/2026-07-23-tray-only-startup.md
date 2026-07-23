# Tray-only Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the Windows desktop application in the system tray without any visible overlay, black rectangle, taskbar entry, or focus change.

**Architecture:** Keep the eagerly created Tauri `overlay` window and its existing capture/settings entry points. Add one focused startup lifecycle helper that requires the overlay to exist and hides it before setup returns, plus a reusable Windows probe that fails when the launched process owns a visible primary window.

**Tech Stack:** Rust, Tauri 2, PowerShell 5.1, Windows user32, Vitest, pnpm

## Global Constraints

- Startup leaves the application running only in the system tray.
- Capture and settings may show the existing `overlay` only after explicit user action.
- Missing overlay or hide failure is a startup initialization error.
- Do not introduce off-screen positioning, zero-size workarounds, timers, or lazy overlay creation.
- Do not modify long-capture stitching, masks, previews, or cancellation.
- Keep the default `Alt+Shift+A` shortcut, tray menu, settings interface, and installer behavior unchanged.

---

### Task 1: Enforce and verify hidden startup

**Files:**
- Create: `apps/desktop/src-tauri/src/startup.rs`
- Create: `scripts/verify-windows-startup.ps1`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: Tauri `WebviewWindow::hide()` and the configured `overlay` label.
- Produces: `startup::hide_startup_overlay<W: StartupWindow>(window: Option<&W>) -> Result<(), String>`.
- Produces: `scripts/verify-windows-startup.ps1`, which exits nonzero if `screenshot-tool.exe` exits early or owns a visible primary window after three seconds.

- [ ] **Step 1: Add the Windows probe and verify the runtime defect**

Create `scripts/verify-windows-startup.ps1`:

```powershell
param(
    [string]$Executable = (
        Join-Path $PSScriptRoot '..\apps\desktop\src-tauri\target\debug\screenshot-tool.exe'
    )
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class StartupWindowVisibility
{
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);
}
'@

$existing = @(Get-Process screenshot-tool -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    throw 'Close existing screenshot-tool processes before running the startup probe.'
}

$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$process = Start-Process -FilePath $resolvedExecutable -PassThru

try {
    Start-Sleep -Seconds 3
    $process.Refresh()
    if ($process.HasExited) {
        throw "screenshot-tool exited during startup with code $($process.ExitCode)."
    }

    $window = $process.MainWindowHandle
    $visible = $window -ne [IntPtr]::Zero -and
        [StartupWindowVisibility]::IsWindowVisible($window)
    if ($visible) {
        throw 'screenshot-tool owns a visible primary window after tray startup.'
    }

    [PSCustomObject]@{
        ProcessAlive = $true
        VisiblePrimaryWindow = $false
        WorkingSetBytes = $process.WorkingSet64
    } | Format-List
}
finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        $process.WaitForExit()
    }
}
```

Run:

```powershell
pnpm --filter @screenshot/desktop tauri:build --debug --no-bundle --no-sign
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-startup.ps1
```

Expected:

- The existing executable probe exits nonzero with
  `screenshot-tool owns a visible primary window after tray startup.`
- The probe stops only the process it started.

- [ ] **Step 2: Add lifecycle unit tests and verify RED**

Add the module declaration to `apps/desktop/src-tauri/src/lib.rs`:

```rust
pub mod startup;
```

Create `apps/desktop/src-tauri/src/startup.rs` with tests that specify the
contract before the implementation exists:

```rust
#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::{hide_startup_overlay, StartupWindow};

    struct FakeWindow {
        hide_calls: Cell<u32>,
        hide_result: Result<(), &'static str>,
    }

    impl StartupWindow for FakeWindow {
        fn hide_at_startup(&self) -> Result<(), String> {
            self.hide_calls.set(self.hide_calls.get() + 1);
            self.hide_result.map_err(str::to_string)
        }
    }

    #[test]
    fn hides_the_configured_overlay_once() {
        let window = FakeWindow {
            hide_calls: Cell::new(0),
            hide_result: Ok(()),
        };

        assert_eq!(hide_startup_overlay(Some(&window)), Ok(()));
        assert_eq!(window.hide_calls.get(), 1);
    }

    #[test]
    fn rejects_a_missing_overlay() {
        assert_eq!(
            hide_startup_overlay(None::<&FakeWindow>),
            Err("startup overlay window is unavailable".to_string())
        );
    }

    #[test]
    fn propagates_a_hide_failure() {
        let window = FakeWindow {
            hide_calls: Cell::new(0),
            hide_result: Err("native hide failed"),
        };

        assert_eq!(
            hide_startup_overlay(Some(&window)),
            Err("failed to hide startup overlay: native hide failed".to_string())
        );
    }
}
```

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml startup::tests
```

Expected: Rust compilation fails because `hide_startup_overlay` and
`StartupWindow` are not defined.

- [ ] **Step 3: Implement the minimal startup lifecycle helper**

Place this implementation before the tests in
`apps/desktop/src-tauri/src/startup.rs`:

```rust
pub trait StartupWindow {
    fn hide_at_startup(&self) -> Result<(), String>;
}

impl StartupWindow for tauri::WebviewWindow {
    fn hide_at_startup(&self) -> Result<(), String> {
        tauri::WebviewWindow::hide(self).map_err(|error| error.to_string())
    }
}

pub fn hide_startup_overlay<W: StartupWindow>(window: Option<&W>) -> Result<(), String> {
    let window = window.ok_or_else(|| "startup overlay window is unavailable".to_string())?;
    window
        .hide_at_startup()
        .map_err(|error| format!("failed to hide startup overlay: {error}"))
}
```

At the end of the `.setup(|app| { ... })` closure in
`apps/desktop/src-tauri/src/main.rs`, immediately before `Ok(())`, add:

```rust
let overlay = app.get_webview_window("overlay");
screenshot_tool::startup::hide_startup_overlay(overlay.as_ref())
    .map_err(std::io::Error::other)?;
```

- [ ] **Step 4: Run focused Rust verification and confirm GREEN**

Run:

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml startup::tests
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: format exits 0, three startup tests pass, and Clippy exits 0.

- [ ] **Step 5: Rebuild and run the Windows visibility probe**

Run:

```powershell
pnpm --filter @screenshot/desktop tauri:build --debug --no-bundle --no-sign
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-startup.ps1
```

Expected: the process remains alive for three seconds,
`VisiblePrimaryWindow` is `False`, idle working-set bytes are printed, and the
probe exits 0 after stopping its own process.

- [ ] **Step 6: Run the desktop regression suite**

Run:

```powershell
pnpm --filter @screenshot/desktop exec vitest run --maxWorkers=1 --minWorkers=1
pnpm --filter @screenshot/desktop typecheck
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

Expected: 22 desktop test files and 164 tests pass, typecheck exits 0, at
least 103 Rust tests pass, and `git diff --check` prints no errors.

- [ ] **Step 7: Commit the startup fix**

```powershell
git add apps/desktop/src-tauri/src/startup.rs `
  apps/desktop/src-tauri/src/lib.rs `
  apps/desktop/src-tauri/src/main.rs `
  scripts/verify-windows-startup.ps1
git commit -m "fix: keep tray startup window hidden"
```

### Task 2: Record the partial E2 evidence

**Files:**
- Modify: `docs/release-checklist.md`

**Interfaces:**
- Consumes: the successful startup probe from Task 1 and the existing E2 acceptance matrix.
- Produces: an honest, reproducible record that distinguishes direct-executable startup verification from clean-account installer acceptance.

- [ ] **Step 1: Add the startup smoke record**

Append this subsection to the automatic verification section in
`docs/release-checklist.md`:

````markdown
### E2 direct-executable startup smoke

After building the Windows debug executable, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/verify-windows-startup.ps1
```

The probe passed after three seconds: the process remained alive, owned no
visible primary window, printed its idle working-set size, and was then
stopped by the probe. This verifies tray-only startup for the directly built
debug executable. It does not replace clean-account MSI/NSIS installation,
upgrade, downgrade, shortcut, tray-menu, or uninstall acceptance.
````

- [ ] **Step 2: Verify documentation consistency**

Run:

```powershell
rg -n "VBSCRIPT|visible primary window|clean-account|干净账户" `
  docs/release-checklist.md `
  docs/superpowers/plans/2026-07-21-project-continuation-roadmap.md
git diff --check
```

Expected: no text claims VBSCRIPT is the current MSI blocker; the new startup
record explicitly says clean-account acceptance is still pending; diff check
prints no errors.

- [ ] **Step 3: Commit the verification record**

```powershell
git add docs/release-checklist.md
git commit -m "docs: record tray startup verification"
```

### Task 3: Final task review

**Files:**
- Review only: all files changed by Tasks 1–2

**Interfaces:**
- Consumes: commits from Tasks 1–2.
- Produces: a clean review result or a small corrective commit.

- [ ] **Step 1: Review the complete change**

Review:

```powershell
git diff 10f893c..HEAD --check
git diff 10f893c..HEAD -- `
  apps/desktop/src-tauri/src/startup.rs `
  apps/desktop/src-tauri/src/lib.rs `
  apps/desktop/src-tauri/src/main.rs `
  scripts/verify-windows-startup.ps1 `
  docs/release-checklist.md
```

Confirm:

- Startup always explicitly hides the configured overlay.
- Missing/hide failure cannot silently continue.
- The probe refuses to kill a pre-existing user process and cleans up only
  its own process.
- Capture and settings show paths are unchanged.
- No long-capture file changed.
- Documentation does not claim installer acceptance.

- [ ] **Step 2: Run final verification**

Run:

```powershell
pnpm --filter @screenshot/desktop exec vitest run --maxWorkers=1 --minWorkers=1
pnpm --filter @screenshot/desktop typecheck
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm --filter @screenshot/desktop tauri:build --debug --no-bundle --no-sign
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-startup.ps1
git status --short
```

Expected: every command exits 0; desktop tests remain 164/164; Rust tests are
at least 103/103; the startup probe reports no visible primary window; Git
shows no uncommitted tracked files.
