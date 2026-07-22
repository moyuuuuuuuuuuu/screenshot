# Long Capture Finish and Mask Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Enter/checkmark copy the completed long screenshot natively before exit and eliminate the four flying black rectangles by reusing hidden mask windows instead of closing them.

**Architecture:** The Rust capture pipeline owns Finish clipboard output and reports success only after native copy completes; the React editor only closes after a successful Finish result. The four mask windows become reusable Tauri windows: every session hides all existing masks, creates or reconfigures the required layouts, excludes them from capture, and shows them; cleanup hides masks but never closes them.

**Tech Stack:** Rust, Tauri 2, `clipboard-win`, React 19, TypeScript, Vitest, Windows WebView2.

## Global Constraints

- Work directly on `main`; do not create a worktree or feature branch.
- Do not push the repository unless the user explicitly requests it.
- Enter and the checkmark must use the same `Finish` action.
- Native clipboard copy must succeed before the screenshot overlay exits.
- The four mask windows must not be closed during a capture session lifecycle.
- Cancel, edit, save, finish, and error paths must leave no visible mask and no input-blocking mask.
- Do not modify stitching, OCR, translation, ordinary screenshot output, or shortcut configuration.

---

### Task 1: Move Finish Clipboard Output Into the Native Capture Pipeline

**Files:**
- Modify: `apps/desktop/src-tauri/src/long_capture.rs`
- Modify: `apps/desktop/src/components/ScreenshotEditor.tsx`
- Test: `apps/desktop/src-tauri/src/long_capture.rs`
- Test: `apps/desktop/src/components/ScreenshotEditor.test.tsx`

**Interfaces:**
- Consumes: `crate::output::copy_png(Vec<u8>) -> Result<(), String>` and `LongCaptureAction::Finish`.
- Produces: `finalize_capture_result(png_bytes, partial, action, copy_png) -> Result<LongCaptureResult, String>`; a Finish result means the PNG is already in the native clipboard.

- [ ] **Step 1: Write a failing Rust test for native Finish copy**

Add tests beside the existing long-capture action tests:

```rust
#[test]
fn finish_copies_the_final_png_before_returning_success() {
    let copied = Rc::new(RefCell::new(Vec::new()));
    let copied_bytes = Rc::clone(&copied);
    let result = finalize_capture_result(
        vec![137, 80, 78, 71],
        false,
        LongCaptureAction::Finish,
        move |png| {
            *copied_bytes.borrow_mut() = png.to_vec();
            Ok(())
        },
    )
    .unwrap();

    assert_eq!(*copied.borrow(), vec![137, 80, 78, 71]);
    assert_eq!(result.action, LongCaptureAction::Finish);
}

#[test]
fn finish_copy_failure_prevents_success() {
    let error = finalize_capture_result(
        vec![137, 80, 78, 71],
        false,
        LongCaptureAction::Finish,
        |_| Err("clipboard busy".to_string()),
    )
    .unwrap_err();

    assert_eq!(error, "clipboard busy");
}

#[test]
fn edit_does_not_write_the_clipboard() {
    let copy_calls = Rc::new(Cell::new(0));
    let calls = Rc::clone(&copy_calls);
    finalize_capture_result(
        vec![137, 80, 78, 71],
        false,
        LongCaptureAction::Edit,
        move |_| {
            calls.set(calls.get() + 1);
            Ok(())
        },
    )
    .unwrap();

    assert_eq!(copy_calls.get(), 0);
}
```

- [ ] **Step 2: Run the Rust test and verify RED**

Run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test \
  --manifest-path apps/desktop/src-tauri/Cargo.toml \
  long_capture::tests::finish_
```

Expected: compilation fails because `finalize_capture_result` does not exist.

- [ ] **Step 3: Write a failing frontend test that forbids duplicate clipboard output**

Add a `ScreenshotEditor` test that starts a long capture and resolves it with a Finish action:

```tsx
it('closes after a natively copied long capture without copying twice', async () => {
  const bridge = createBridge({
    startLongCapture: vi.fn().mockResolvedValue({
      png: new Blob(['long']),
      partial: false,
      action: 'finish',
    }),
  });
  render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
  const surface = screen.getByTestId('selection-surface');
  fireEvent.pointerDown(surface, { clientX: 20, clientY: 30, pointerId: 1 });
  fireEvent.pointerMove(surface, { clientX: 220, clientY: 180, pointerId: 1 });
  fireEvent.pointerUp(surface, { clientX: 220, clientY: 180, pointerId: 1 });

  await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));
  await waitFor(() => expect(bridge.closeOverlay).toHaveBeenCalledOnce());

  expect(bridge.copyPng).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run the frontend test and verify RED**

Run:

```bash
cmd.exe /d /c pnpm --filter @screenshot/desktop exec vitest --run \
  src/components/ScreenshotEditor.test.tsx
```

Expected: FAIL because the Finish branch currently calls `bridge.copyPng`.

- [ ] **Step 5: Implement native completion and remove frontend duplicate copy**

Add a small testable finalizer and call it after `stitcher.finish()`:

```rust
fn finalize_capture_result(
    png_bytes: Vec<u8>,
    partial: bool,
    action: LongCaptureAction,
    copy_png: impl FnOnce(&[u8]) -> Result<(), String>,
) -> Result<LongCaptureResult, String> {
    if action == LongCaptureAction::Finish {
        copy_png(&png_bytes)?;
    }
    Ok(LongCaptureResult {
        png_bytes,
        partial,
        action,
    })
}
```

Normalize `None`/`Cancel` to `Edit`, encode once, and invoke:

```rust
let action = match runtime.requested_action() {
    LongCaptureAction::Save => LongCaptureAction::Save,
    LongCaptureAction::Finish => LongCaptureAction::Finish,
    _ => LongCaptureAction::Edit,
};
let png_bytes = encode_png(&output)?;
finalize_capture_result(png_bytes, outcome == CaptureTermination::Partial, action, |png| {
    crate::output::copy_png(png.to_vec())
})
```

Change the frontend Finish branch to:

```tsx
if (result.action === 'finish') {
  await bridge.closeOverlay();
  return;
}
```

- [ ] **Step 6: Run targeted tests and verify GREEN**

Run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test \
  --manifest-path apps/desktop/src-tauri/Cargo.toml long_capture::tests
cmd.exe /d /c pnpm --filter @screenshot/desktop exec vitest --run \
  src/components/ScreenshotEditor.test.tsx
```

Expected: both targeted suites pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add apps/desktop/src-tauri/src/long_capture.rs \
  apps/desktop/src/components/ScreenshotEditor.tsx \
  apps/desktop/src/components/ScreenshotEditor.test.tsx
git commit -m "fix: copy completed long capture natively"
```

---

### Task 2: Reuse Hidden Mask Windows Without Closing Them

**Files:**
- Modify: `apps/desktop/src-tauri/src/preview_windows.rs`
- Modify: `apps/desktop/src-tauri/src/long_capture.rs`
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/src-tauri/src/preview_windows.rs`
- Test: `apps/desktop/src-tauri/src/long_capture.rs`
- Test: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Consumes: `mask_window_layouts(selection, monitor) -> Vec<MaskWindowLayout>`.
- Produces: `MaskWindowUpdate` serialized with `edge`, `edge_start`, and `edge_length`; event name `scroll-mask-layout`; cleanup policy that hides mask labels and closes only the preview label.

- [ ] **Step 1: Write failing lifecycle-policy tests**

Extract a pure cleanup policy and add tests:

```rust
#[test]
fn cleanup_hides_all_masks_without_closing_them() {
    let events = RefCell::new(Vec::new());
    cleanup_capture_windows(
        &["scroll-mask-top", "scroll-mask-right"],
        &["scroll-capture-preview"],
        |label| events.borrow_mut().push(format!("hide:{label}")),
        |label| events.borrow_mut().push(format!("close:{label}")),
    );

    assert_eq!(
        events.into_inner(),
        vec![
            "hide:scroll-mask-top",
            "hide:scroll-mask-right",
            "hide:scroll-capture-preview",
            "close:scroll-capture-preview",
        ]
    );
}
```

Add a pure planning test in `preview_windows.rs`:

```rust
#[test]
fn existing_mask_labels_are_reused_and_missing_edges_stay_hidden() {
    let layouts = mask_window_layouts(
        ScreenRect { x: 0, y: 0, width: 1000, height: 700 },
        ScreenRect { x: 0, y: 0, width: 1920, height: 1080 },
    );
    let plan = mask_window_lifecycle_plan(
        &layouts,
        &["scroll-mask-top", "scroll-mask-right", "scroll-mask-bottom", "scroll-mask-left"],
    );

    assert!(plan.iter().any(|item| item.label == "scroll-mask-right"
        && item.operation == MaskWindowOperation::Reuse));
    assert!(plan.iter().any(|item| item.label == "scroll-mask-top"
        && item.operation == MaskWindowOperation::Hide));
    assert!(plan.iter().any(|item| item.label == "scroll-mask-left"
        && item.operation == MaskWindowOperation::Hide));
}
```

Define the planning types used by the test and by `open_capture_mask_windows`:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MaskWindowOperation {
    Hide,
    Reuse,
    Create,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MaskWindowPlan {
    label: &'static str,
    layout: Option<MaskLayout>,
    operation: MaskWindowOperation,
}

fn mask_window_lifecycle_plan(
    layouts: &[MaskLayout],
    existing_labels: &[&str],
) -> Vec<MaskWindowPlan> {
    const LABELS: [&str; 4] = [
        "scroll-mask-top",
        "scroll-mask-right",
        "scroll-mask-bottom",
        "scroll-mask-left",
    ];
    LABELS
        .into_iter()
        .map(|label| {
            let layout = layouts.iter().find(|layout| layout.label == label).copied();
            let operation = match (layout, existing_labels.contains(&label)) {
                (None, _) => MaskWindowOperation::Hide,
                (Some(_), true) => MaskWindowOperation::Reuse,
                (Some(_), false) => MaskWindowOperation::Create,
            };
            MaskWindowPlan { label, layout, operation }
        })
        .collect()
}
```

- [ ] **Step 2: Run Rust tests and verify RED**

Run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test \
  --manifest-path apps/desktop/src-tauri/Cargo.toml \
  cleanup_hides_all_masks_without_closing_them
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test \
  --manifest-path apps/desktop/src-tauri/Cargo.toml \
  existing_mask_labels_are_reused_and_missing_edges_stay_hidden
```

Expected: compilation fails because the new lifecycle helpers do not exist.

- [ ] **Step 3: Write a failing React test for live mask layout updates**

Mock the Tauri event listener, render a mask window, send the update payload, and assert CSS variables change:

```tsx
it('updates a reused mask edge from the native layout event', async () => {
  window.history.replaceState({}, '', '/?window=scroll-mask&edge=top&edgeStart=20&edgeLength=200');
  render(<App />);
  expect(document.querySelector('.scroll-capture-mask__edge'))
    .toHaveStyle({ '--edge-start': '20px', '--edge-length': '200px' });

  act(() => tauriListeners.get('scroll-mask-layout')?.({
    payload: { edge: 'top', edgeStart: 80, edgeLength: 640 },
  }));

  expect(document.querySelector('.scroll-capture-mask__edge'))
    .toHaveStyle({ '--edge-start': '80px', '--edge-length': '640px' });
});
```

- [ ] **Step 4: Run the App test and verify RED**

Run:

```bash
cmd.exe /d /c pnpm --filter @screenshot/desktop exec vitest --run src/App.test.tsx
```

Expected: FAIL because mask layout is read only from the initial URL.

- [ ] **Step 5: Implement hidden-window reuse**

In `preview_windows.rs`:

1. Hide every known mask label at the beginning of preparation.
2. For each required layout, reuse an existing window when present; otherwise build it with `.visible(false)`.
3. Configure position, size, cursor blocking, opacity, and emit the new layout to an existing window.
4. Return all required handles while they remain hidden.
5. On any setup error, hide configured windows without closing them.

Drive the operations returned by `mask_window_lifecycle_plan`: `Hide` hides an existing
label, `Reuse` configures the existing handle, and `Create` builds one hidden handle before
running the same configuration function. The common configuration function must execute:

```rust
fn configure_mask_window(
    window: &tauri::WebviewWindow,
    layout: MaskLayout,
) -> Result<(), String> {
    window
        .set_position(PhysicalPosition::new(layout.rect.x, layout.rect.y))
        .map_err(|error| format!("failed to position {}: {error}", layout.label))?;
    window
        .set_size(PhysicalSize::new(
            layout.rect.width as u32,
            layout.rect.height as u32,
        ))
        .map_err(|error| format!("failed to size {}: {error}", layout.label))?;
    window
        .set_ignore_cursor_events(false)
        .map_err(|error| format!("failed to block input for {}: {error}", layout.label))?;
    crate::platform::set_window_opacity(window, 77)
        .map_err(|error| format!("failed to set {} opacity: {error}", layout.label))
}
```

Use the event payload:

```rust
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaskWindowUpdate {
    edge: &'static str,
    edge_start: i32,
    edge_length: i32,
}
```

For a reused window:

```rust
app.emit_to(
    layout.label,
    "scroll-mask-layout",
    MaskWindowUpdate {
        edge: layout.edge.as_str(),
        edge_start: layout.edge_start,
        edge_length: layout.edge_length,
    },
)?;
```

In `long_capture.rs`, exclude every returned mask, then show all masks only after every exclusion succeeds:

```rust
for mask in &masks {
    platform::exclude_window_from_capture(mask)?;
}
for mask in &masks {
    mask.show().map_err(|error| format!("failed to show capture mask: {error}"))?;
}
```

Replace common cleanup with:

```rust
cleanup_capture_windows(
    &MASK_LABELS,
    &["scroll-capture-preview"],
    |label| {
        if let Some(window) = close_app.get_webview_window(label) {
            let _ = window.hide();
        }
    },
    |label| {
        if let Some(window) = close_app.get_webview_window(label) {
            let _ = window.close();
        }
    },
);
```

- [ ] **Step 6: Implement React layout-event handling**

Initialize mask layout from the URL, then listen for updates in mask windows:

```tsx
type ScrollMaskLayout = Readonly<{
  edge: string;
  edgeStart: number;
  edgeLength: number;
}>;

const [maskLayout, setMaskLayout] = useState<ScrollMaskLayout>({
  edge: windowParameters.get('edge') ?? '',
  edgeStart: Number(windowParameters.get('edgeStart')) || 0,
  edgeLength: Number(windowParameters.get('edgeLength')) || 0,
});
```

Inside the existing effect, only for `maskWindow`, register:

```tsx
void listen<ScrollMaskLayout>('scroll-mask-layout', (event) => {
  setMaskLayout(event.payload);
}).then(retainUnlisten).catch(() => undefined);
```

Render `maskLayout.edge`, `maskLayout.edgeStart`, and `maskLayout.edgeLength` instead of immutable URL values.

- [ ] **Step 7: Run targeted tests and verify GREEN**

Run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test \
  --manifest-path apps/desktop/src-tauri/Cargo.toml \
  long_capture::tests
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test \
  --manifest-path apps/desktop/src-tauri/Cargo.toml \
  preview_windows::tests
cmd.exe /d /c pnpm --filter @screenshot/desktop exec vitest --run \
  src/App.test.tsx src/components/ScrollCapturePreview.test.tsx
```

Expected: all targeted tests pass and no mask label is closed by session cleanup.

- [ ] **Step 8: Commit Task 2**

```bash
git add apps/desktop/src-tauri/src/preview_windows.rs \
  apps/desktop/src-tauri/src/long_capture.rs \
  apps/desktop/src/App.tsx \
  apps/desktop/src/App.test.tsx
git commit -m "fix: reuse long capture mask windows"
```

---

### Task 3: Full Regression and Windows Acceptance

**Files:**
- Verify only: `apps/desktop/src-tauri/src/**`
- Verify only: `apps/desktop/src/**`

**Interfaces:**
- Consumes: completed native Finish output and reusable mask lifecycle from Tasks 1–2.
- Produces: verified Windows executable and a clean `main` worktree.

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
cmd.exe /d /c pnpm --filter @screenshot/desktop exec vitest --run
cmd.exe /d /c pnpm --filter @screenshot/desktop typecheck
cmd.exe /d /c pnpm --filter @screenshot/desktop build
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test \
  --manifest-path apps/desktop/src-tauri/Cargo.toml
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe fmt \
  --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe clippy \
  --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: every command exits 0 with no failed tests or warnings.

- [ ] **Step 2: Rebuild and start one clean Windows instance**

Stop only `screenshot-tool.exe`, then run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe build \
  --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Start `apps/desktop/src-tauri/target/debug/screenshot-tool.exe` without remote-debug arguments.

Expected: exactly one `screenshot-tool.exe` process.

- [ ] **Step 3: Verify Enter clipboard completion**

Create a long screenshot with at least three accepted frames and press Enter. Read the Windows clipboard image and assert:

- an image format exists;
- clipboard width equals the selected width;
- clipboard height equals the final stitched height and exceeds the selection height;
- the screenshot overlay exits only after clipboard output succeeds.

- [ ] **Step 4: Verify checkmark clipboard completion**

Repeat the capture and click the checkmark. Assert the same clipboard dimensions and that no second clipboard write/error occurs.

- [ ] **Step 5: Verify mask reuse without close animation**

For Enter, checkmark, Esc, edit, and save paths:

- no black rectangles fly toward screen corners;
- `scroll-mask-top/right/bottom/left` remain hidden and reusable after cleanup;
- a second capture correctly repositions and shows the masks;
- outside-selection input remains blocked and selection input reaches the target application.

- [ ] **Step 6: Confirm repository state**

Run:

```bash
git status --short --branch
git log -3 --oneline
```

Expected: clean `main`, ahead of `origin/main`, with Task 1 and Task 2 commits present. Do not push.
