# Long Capture Stitching, Mask, and Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual scrolling produce a real stitched long image, block input outside the selected region with a 0.3 monitor mask, and update the requested toolbar icons while removing the privacy entry.

**Architecture:** Replace the fixed 32-row motion gate at stable-frame time with a coarse-to-fine full-height matcher that compares every stable candidate with the last accepted frame. Replace one-pixel border windows with four capture-excluded mask windows that cover the selected monitor outside the selection, consume pointer input, and render a green inner edge; create the sidecar after the masks so it remains interactive. Keep Lucide as the single icon system.

**Tech Stack:** Rust, Tauri 2, Windows Win32 capture, React 19, TypeScript, Lucide React, Vitest, Cargo test.

## Global Constraints

- The user scrolls manually; do not add automatic scrolling.
- Only the monitor containing the selection is masked; other monitors remain untouched.
- Mask opacity is exactly `rgba(0, 0, 0, 0.3)`.
- The selection remains a transparent input hole; input outside it must not reach underlying apps.
- Preview, edit, save, and finish use the same accumulated stitcher output.
- Keep all icons at 20px with 1.8 stroke width where the existing toolbar contract applies.
- Work directly on `main`; do not create a worktree or push without an explicit user request.

---

### Task 1: Coarse-to-fine stable-frame matcher

**Files:**
- Modify: `apps/desktop/src-tauri/src/stitcher.rs`
- Test: `apps/desktop/src-tauri/src/stitcher.rs`

**Interfaces:**
- Consumes: two equal-sized `RgbaFrame` values representing the last accepted frame and the newly stable frame.
- Produces: `match_vertical_scroll(previous: &RgbaFrame, next: &RgbaFrame) -> Result<MatchDirection, MatchError>` where a forward result contains physical-pixel overlap rows.

- [ ] **Step 1: Write failing tests for large forward movement and reverse movement**

Add tests that exceed the old 128-physical-pixel limit:

```rust
#[test]
fn multiscale_match_accepts_a_real_wheel_sized_step() {
    let previous = document_frame(0, 700, 80);
    let next = document_frame(260, 700, 80);
    assert_eq!(
        match_vertical_scroll(&previous, &next),
        Ok(MatchDirection::Forward { overlap_rows: 440 })
    );
}

#[test]
fn multiscale_match_rejects_reverse_scroll() {
    let previous = document_frame(260, 700, 80);
    let next = document_frame(120, 700, 80);
    assert_eq!(match_vertical_scroll(&previous, &next), Ok(MatchDirection::Reverse));
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test --manifest-path apps/desktop/src-tauri/Cargo.toml multiscale_match
```

Expected: compilation fails because `match_vertical_scroll` does not exist.

- [ ] **Step 3: Implement coarse and fine searches**

Implement a private directional helper and the public matcher. Coarse matching uses scale 8 across the complete valid overlap range; fine matching uses scale 4 in a bounded range around the coarse result. Compare forward and reverse confidence and return physical overlap rows:

```rust
pub fn match_vertical_scroll(
    previous: &RgbaFrame,
    next: &RgbaFrame,
) -> Result<MatchDirection, MatchError> {
    let previous_coarse = downscale_grayscale(previous, 8)?;
    let next_coarse = downscale_grayscale(next, 8)?;
    let previous_fine = downscale_grayscale(previous, 4)?;
    let next_fine = downscale_grayscale(next, 4)?;
    let minimum_coarse = (previous_coarse.height / 10).max(2);

    let forward = refine_direction(
        &previous_coarse, &next_coarse,
        &previous_fine, &next_fine,
        minimum_coarse,
    );
    let reverse = refine_direction(
        &next_coarse, &previous_coarse,
        &next_fine, &previous_fine,
        minimum_coarse,
    );

    Ok(select_direction(forward, reverse))
}
```

`refine_direction` must convert the coarse overlap to scale-4 rows, search at least ±6 fine rows, require mean error at most 32, and return the match confidence. `select_direction` returns `Unmatched` when neither direction is confident and prefers reverse only when its confidence exceeds forward by at least 0.08.

- [ ] **Step 4: Run matcher and stitcher tests and verify GREEN**

Run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test --manifest-path apps/desktop/src-tauri/Cargo.toml stitcher
```

Expected: all stitcher tests pass, including the new 260-pixel movement case.

- [ ] **Step 5: Commit the matcher**

```bash
git add apps/desktop/src-tauri/src/stitcher.rs
git commit -m "fix: match real wheel-sized capture movement"
```

### Task 2: Feed every accepted stable frame into preview and final output

**Files:**
- Modify: `apps/desktop/src-tauri/src/long_capture.rs:1-583`
- Test: `apps/desktop/src-tauri/src/long_capture.rs`

**Interfaces:**
- Consumes: `stitcher::match_vertical_scroll` from Task 1.
- Produces: one accepted-frame path that updates `ChunkedStitcher`, `LongCaptureSession`, preview PNG, and final PNG from the same data.

- [ ] **Step 1: Write a failing pipeline test**

Extract a small pure helper named `append_stable_candidate` and test that two 700-row frames separated by 260 rows produce identical preview and final heights:

```rust
#[test]
fn accepted_candidate_grows_preview_and_final_output() {
    let first = document_frame(0, 700, 80);
    let next = document_frame(260, 700, 80);
    let mut stitcher = ChunkedStitcher::default();
    stitcher.append(first.clone(), 0).unwrap();

    let added = append_stable_candidate(&mut stitcher, &first, next).unwrap();
    assert_eq!(added, Some(260));
    assert_eq!(stitcher.preview().unwrap().height, 960);
    assert_eq!(stitcher.finish().unwrap().height, 960);
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test --manifest-path apps/desktop/src-tauri/Cargo.toml accepted_candidate_grows_preview
```

Expected: compilation fails because `append_stable_candidate` is missing.

- [ ] **Step 3: Implement the single accepted-frame path**

Remove `pending_motion` and the fixed-window `ScrollMotionTracker` gate from `run_capture`. On `Observation::StableFrame`, call the pure helper against `accepted_tail` and `candidate`:

```rust
match append_stable_candidate(&mut stitcher, &accepted_tail, candidate.clone())? {
    Some(added_height) => {
        session.forward_matched(added_height)
            .map_err(|_| "invalid forward-match transition")?;
        accepted_tail = candidate;
        preview_png = encode_png(&stitcher.preview()
            .map_err(|error| format!("preview failed: {error:?}"))?)?;
        observer.mark_appended(started.elapsed());
    }
    None => session.unmatched().map_err(|_| "invalid unmatched transition")?,
}
```

The helper uses `match_vertical_scroll`, retains fixed header/footer filtering, and returns `Some(candidate.height - overlap_rows)` only after a successful append. Reverse and unmatched results return `None` without changing the stitcher.

- [ ] **Step 4: Verify focused and full Rust tests**

Run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test --manifest-path apps/desktop/src-tauri/Cargo.toml accepted_candidate_grows_preview
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: the pipeline test and the complete Rust suite pass.

- [ ] **Step 5: Commit the integration**

```bash
git add apps/desktop/src-tauri/src/long_capture.rs
git commit -m "fix: append stable frames to long capture output"
```

### Task 3: Replace border windows with monitor mask windows

**Files:**
- Modify: `apps/desktop/src-tauri/src/preview_windows.rs`
- Modify: `apps/desktop/src-tauri/src/long_capture.rs:350-700`
- Modify: `apps/desktop/src/App.tsx:37-99`
- Modify: `apps/desktop/src/styles.css:8-26`
- Test: `apps/desktop/src-tauri/src/preview_windows.rs`
- Test: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Produces: `mask_window_layouts(selection: ScreenRect, monitor: ScreenRect) -> Vec<MaskLayout>` and `open_capture_mask_windows(...)`.
- Each `MaskLayout` contains a stable label, non-empty rectangle, inward edge, edge offset, and edge length.

- [ ] **Step 1: Write failing layout tests**

Replace the one-pixel border expectation with exact monitor-minus-selection coverage:

```rust
#[test]
fn mask_windows_cover_monitor_without_entering_selection() {
    let monitor = ScreenRect { x: 0, y: 0, width: 1920, height: 1080 };
    let selection = ScreenRect { x: 500, y: 300, width: 1000, height: 700 };
    let masks = mask_window_layouts(selection, monitor);

    assert_eq!(masks.iter().map(|m| m.rect).collect::<Vec<_>>(), vec![
        ScreenRect { x: 0, y: 0, width: 1920, height: 300 },
        ScreenRect { x: 1500, y: 300, width: 420, height: 700 },
        ScreenRect { x: 0, y: 1000, width: 1920, height: 80 },
        ScreenRect { x: 0, y: 300, width: 500, height: 700 },
    ]);
    assert!(masks.iter().all(|mask| !intersects(selection, mask.rect)));
    assert_eq!(masks.iter().map(|m| area(m.rect)).sum::<i64>(),
        area(monitor) - area(selection));
}
```

Add a boundary test proving zero-sized masks are omitted when the selection touches a monitor edge.

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test --manifest-path apps/desktop/src-tauri/Cargo.toml mask_windows
```

Expected: compilation fails because `mask_window_layouts` does not exist.

- [ ] **Step 3: Implement layouts and native mask windows**

Create top/right/bottom/left layouts around the selection and retain only positive-width, positive-height rectangles. Build transparent, always-on-top, non-focusable WebView windows using URLs like:

```rust
WebviewUrl::App(format!(
    "index.html?window=scroll-mask&edge={}&edgeStart={}&edgeLength={}",
    layout.edge.as_str(), layout.edge_start, layout.edge_length,
).into())
```

Do not call `set_ignore_cursor_events(true)`: mask windows must consume pointer and wheel input. Continue excluding every mask from capture.

- [ ] **Step 4: Render the exact mask and inner green edge**

In `App.tsx`, recognize `window=scroll-mask` and render:

```tsx
<div className="scroll-capture-mask" aria-hidden="true">
  <span className="scroll-capture-mask__edge" data-edge={edge}
    style={{ '--edge-start': `${edgeStart}px`, '--edge-length': `${edgeLength}px` } as React.CSSProperties} />
</div>
```

In CSS, set the mask background to exact opacity and position the edge on the side facing the selection:

```css
.scroll-capture-mask { width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.3); }
.scroll-capture-mask__edge { position: absolute; background: #07c160; }
```

Use horizontal dimensions for top/bottom edges and vertical dimensions for left/right edges.

- [ ] **Step 5: Create masks before the sidecar and update cleanup**

Change preparation order to `open masks → open preview → hide overlay`, ensuring the later-created preview remains above masks. Close `scroll-mask-top/right/bottom/left` in all cleanup paths and remove old `scroll-border-*` references.

- [ ] **Step 6: Run mask and App tests**

Run:

```bash
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test --manifest-path apps/desktop/src-tauri/Cargo.toml preview_windows
cmd.exe /d /c pnpm --filter @screenshot/desktop exec vitest --run src/App.test.tsx
```

Expected: layouts, boundary handling, query rendering, and cleanup-order tests pass.

- [ ] **Step 7: Commit the mask behavior**

```bash
git add apps/desktop/src-tauri/src/preview_windows.rs apps/desktop/src-tauri/src/long_capture.rs apps/desktop/src/App.tsx apps/desktop/src/styles.css apps/desktop/src/App.test.tsx
git commit -m "fix: block input outside long capture selection"
```

### Task 4: Update icons and remove privacy entry

**Files:**
- Modify: `apps/desktop/src/components/WechatToolbar.tsx`
- Modify: `apps/desktop/src/components/WechatToolbar.test.tsx`
- Modify: `apps/desktop/src/components/ServiceResult.tsx`
- Modify: `apps/desktop/src/components/ServiceResult.test.tsx`
- Modify: `apps/desktop/src/components/ScreenshotEditor.tsx`
- Test: the two component test files above and `ScreenshotEditor.test.tsx`

**Interfaces:**
- Toolbar uses Lucide `Blocks`, `GalleryVerticalEnd`, and `Languages` at 20px/1.8.
- Service translation button exposes the same `Languages` icon.
- `WechatToolbarAction` no longer contains `privacy`.

- [ ] **Step 1: Write failing toolbar and translation icon tests**

Update expected toolbar labels to omit `隐私工具`. Assert icon classes:

```tsx
expect(screen.queryByRole('button', { name: '隐私工具' })).not.toBeInTheDocument();
expect(screen.getByRole('button', { name: '马赛克' }).querySelector('svg'))
  .toHaveClass('lucide-blocks');
expect(screen.getByRole('button', { name: '文字识别' }).querySelector('svg'))
  .toHaveClass('lucide-languages');
expect(screen.getByRole('button', { name: '滚动截图' }).querySelector('svg'))
  .toHaveClass('lucide-gallery-vertical-end');
expect(screen.getByRole('button', { name: '翻译为中文' }).querySelector('svg'))
  .toHaveClass('lucide-languages');
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cmd.exe /d /c pnpm --filter @screenshot/desktop exec vitest --run src/components/WechatToolbar.test.tsx src/components/ServiceResult.test.tsx
```

Expected: failures show the old icons and privacy entry.

- [ ] **Step 3: Apply the icon and action changes**

Import `Blocks`, `GalleryVerticalEnd`, and `Languages`. Remove `privacy` from the action union and action list. Add `<Languages size={20} strokeWidth={1.8} aria-hidden="true" />` before the translation button text. Remove `runPrivacyRedaction` and the `privacy` branch from `ScreenshotEditor` while leaving the underlying Coze service API unchanged.

- [ ] **Step 4: Run component and editor tests and verify GREEN**

Run:

```bash
cmd.exe /d /c pnpm --filter @screenshot/desktop exec vitest --run src/components/WechatToolbar.test.tsx src/components/ServiceResult.test.tsx src/components/ScreenshotEditor.test.tsx
```

Expected: all focused frontend tests pass.

- [ ] **Step 5: Commit the UI update**

```bash
git add apps/desktop/src/components/WechatToolbar.tsx apps/desktop/src/components/WechatToolbar.test.tsx apps/desktop/src/components/ServiceResult.tsx apps/desktop/src/components/ServiceResult.test.tsx apps/desktop/src/components/ScreenshotEditor.tsx
git commit -m "feat: refresh capture service icons"
```

### Task 5: Full verification and Windows acceptance

**Files:**
- Verify only; modify tests or implementation only if a failure exposes a requirement gap.

**Interfaces:**
- The packaged desktop app is the final integration boundary.

- [ ] **Step 1: Run all automated verification**

Run:

```bash
cmd.exe /d /c pnpm --filter @screenshot/desktop exec vitest --run
cmd.exe /d /c pnpm --filter @screenshot/desktop typecheck
cmd.exe /d /c pnpm --filter @screenshot/desktop build
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe test --manifest-path apps/desktop/src-tauri/Cargo.toml
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
/mnt/c/Users/Administrator/.cargo/bin/cargo.exe clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: every command exits 0 with no failed tests or warnings.

- [ ] **Step 2: Build the Windows desktop executable**

Stop only `screenshot-tool.exe`, then run:

```bash
cmd.exe /d /c pnpm --filter @screenshot/desktop tauri build --debug --no-bundle
```

Expected: `apps/desktop/src-tauri/target/debug/screenshot-tool.exe` is rebuilt successfully.

- [ ] **Step 3: Run real desktop acceptance**

Use a 1000×700 selection on a scrollable target. Verify after at least three wheel steps:

- selected target remains the foreground process;
- `frameCount > 1`;
- `stitchedHeight > 700`;
- preview PNG height equals the reported stitched height;
- an outside-mask point resolves to `screenshot-tool`, while a selection-center point resolves to the target app;
- wheel input outside the selection does not change the target-region hash;
- edit result natural height and saved/finished PNG height equal the accumulated output height;
- Esc closes all four masks and the sidecar, and reopening starts with no selection.

- [ ] **Step 4: Restart one clean instance and confirm repository state**

Start exactly one newly built process, then run:

```bash
git status --short
```

Expected: one running `screenshot-tool.exe` and an empty git status.

