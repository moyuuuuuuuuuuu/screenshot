# Screenshot Tool Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue the existing Windows-first screenshot tool on any development machine through native capture, complete annotation interaction, automatic scrolling screenshots, cloud OCR/translation through Coze, and a verified Windows installer.

**Architecture:** Preserve the current React/TypeScript editor and the `DesktopBridge` boundary. Add Windows-specific behavior behind typed Tauri commands in Rust, then add a separate TypeScript cloud API whose provider interface isolates Coze from the desktop client. Deliver each phase as an independently testable commit series.

**Tech Stack:** Node.js 22, pnpm 10, TypeScript 5.8+, React 19, Vite 7, Vitest 3, Tauri 2, Rust stable MSVC, Windows APIs, Canvas 2D, Coze Workflow API

## Global Constraints

- Windows 10/11 is the first supported runtime; macOS/Linux implementations remain behind platform interfaces.
- The toolbar remains icon-only: 20×20 SVG, 1.8px stroke, round caps/joins, 36×36 hit targets.
- Local capture, annotation, copy, and save never require network access.
- Screenshots upload only after the user explicitly selects OCR or translation.
- Coze tokens and workflow IDs exist only in the cloud service environment.
- Production TypeScript uses strict mode and no `any`.
- Every behavior change follows red-green-refactor and ends with a focused commit.

---

## 1. Repository Resume Point

Remote repository:

```text
https://github.com/moyuuuuuuuuuuu/screenshot.git
```

Verified baseline commit:

```text
963dfb4 build: add Tauri-ready desktop configuration
```

Completed work:

- Vite + React + TypeScript desktop webview workspace.
- Selection geometry with reverse-drag and bounds tests.
- Five annotation domain types and immutable undo/redo history.
- Canvas renderers for rectangle, arrow, pen, text, and source-based mosaic.
- Browser `DesktopBridge` for copy, save, and close.
- Icon-only toolbar and selection overlay.
- Tauri 2 hidden, transparent, fullscreen, always-on-top overlay configuration.
- 20 automated tests, strict typecheck, and Vite production build passing at the baseline.

Not yet implemented:

- Interactive drawing from pointer gestures into annotation history.
- Selection move/resize using the eight handles.
- Windows screen capture, DPI mapping, global shortcut, tray, native clipboard, and save dialog.
- Cloud API, anonymous quotas, Coze workflow, OCR/translation result panel.
- Windows packaging and installer validation.

Authoritative documents:

- Product spec: `docs/superpowers/specs/2026-07-21-cross-platform-screenshot-tool-design.md`
- Scrolling screenshot spec: `docs/superpowers/specs/2026-07-21-scrolling-screenshot-design.md`
- Completed phase plan: `docs/superpowers/plans/2026-07-21-desktop-editor-foundation.md`
- Continuation roadmap: this file.

---

## 2. New Machine Bootstrap

- [ ] **Step 1: Clone and confirm the expected history**

```powershell
git clone https://github.com/moyuuuuuuuuuuu/screenshot.git
cd screenshot
git log -1 --oneline
git status --short --branch
```

Expected: HEAD is at or after `963dfb4`; working tree is clean.

- [ ] **Step 2: Install required runtimes**

Install:

```text
Node.js 22.x
pnpm 10.x
Rust stable-x86_64-pc-windows-msvc
Visual Studio Build Tools with Desktop development with C++
Microsoft Edge WebView2 Runtime
```

Verify:

```powershell
node --version
pnpm --version
rustc --version
cargo --version
```

Expected: all commands exit 0; Node major is 22; pnpm major is 10; Rust host contains `x86_64-pc-windows-msvc`.

- [ ] **Step 3: Restore dependencies and verify the baseline**

```powershell
pnpm install --frozen-lockfile
pnpm test -- --run
pnpm typecheck
pnpm --filter @screenshot/desktop build
pnpm --filter @screenshot/desktop tauri info
```

Expected: 20 or more tests pass, typecheck exits 0, Vite build produces `apps/desktop/dist/index.html`, and Tauri reports the installed Rust/Windows toolchain.

- [ ] **Step 4: Start from a feature branch**

```powershell
git switch -c codex/windows-native-capture
```

Expected: `git branch --show-current` prints `codex/windows-native-capture`.

---

## 3. Phase A — Complete Editor Interaction

### Task A1: Pointer-to-Annotation Controller

**Files:**
- Create: `apps/desktop/src/domain/drawing-session.ts`
- Test: `apps/desktop/src/domain/drawing-session.test.ts`
- Modify: `apps/desktop/src/components/ScreenshotEditor.tsx`
- Test: `apps/desktop/src/components/ScreenshotEditor.test.tsx`

**Interfaces:**

```ts
export type DrawingSession = Readonly<{
  tool: Tool;
  start: Point;
  points: readonly Point[];
}>;

export function startDrawing(tool: Tool, point: Point): DrawingSession;
export function continueDrawing(session: DrawingSession, point: Point): DrawingSession;
export function finishDrawing(session: DrawingSession, id: string): Annotation | null;
```

- [x] Write failing tests proving rectangle bounds normalize, arrows retain direction, pen/mosaic retain ordered points, and zero-length gestures return `null`.
- [x] Run `pnpm --dir apps/desktop exec vitest run src/domain/drawing-session.test.ts`; confirmed missing-module failure.
- [x] Implement the three functions with immutable values and add completed annotations through `addAnnotation`.
- [x] Connect pointer down/move/up on the annotation canvas only after a selection exists; clamp points to the current selection.
- [x] Run focused tests, `pnpm test -- --run`, and `pnpm typecheck`; all green.
- [x] Commit with `git commit -m "feat: add pointer-driven annotations"`.

### Task A2: Text Entry and Selection Handles

**Files:**
- Create: `apps/desktop/src/components/TextEditor.tsx`
- Test: `apps/desktop/src/components/TextEditor.test.tsx`
- Create: `apps/desktop/src/domain/resize-selection.ts`
- Test: `apps/desktop/src/domain/resize-selection.test.ts`
- Modify: `apps/desktop/src/components/SelectionOverlay.tsx`

**Interfaces:**

```ts
export function resizeSelection(rect: Rect, handle: ResizeHandle, delta: Point, bounds: Rect): Rect;

export type TextEditorProps = Readonly<{
  position: Point;
  onCommit(text: string): void;
  onCancel(): void;
}>;
```

- [x] Test every resize handle, negative virtual-desktop coordinates, minimum 8×8 size, Enter commit, and Escape cancel.
- [x] Implement `resizeSelection` as a pure function using `normalizeRect` and `clampRect`.
- [x] Implement an inline transparent text input; never use `window.prompt`.
- [x] Connect handle dragging and selection dragging without starting a new selection.
- [x] Verify with `pnpm test -- --run && pnpm typecheck && pnpm --filter @screenshot/desktop build`.
- [x] Commit with `git commit -m "feat: add text editing and selection resizing"`.

Phase A acceptance:

- All five tools create visible annotations.
- Undo/redo updates the canvas.
- Selection can be created, moved, and resized.
- Text is committed inline.
- Copy/save output contains source pixels plus annotations.

---

## 4. Phase B — Windows Native Capture and Output

### Task B1: Platform Contract and Virtual Desktop Geometry

**Files:**
- Create: `apps/desktop/src-tauri/src/platform/mod.rs`
- Create: `apps/desktop/src-tauri/src/platform/windows.rs`
- Create: `apps/desktop/src-tauri/src/capture.rs`
- Test: `apps/desktop/src-tauri/src/capture_tests.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs`

**Interfaces:**

```rust
#[derive(Clone, serde::Serialize)]
pub struct MonitorFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub png_base64: String,
}

#[tauri::command]
async fn capture_desktop() -> Result<Vec<MonitorFrame>, String>;
```

- [x] Add Rust unit tests for monitors left/above the primary display, mixed DPI scale factors, and virtual-desktop bounding rectangles.
- [x] Run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`; the first available Rust run passed after the toolchain was installed.
- [x] Implement Windows monitor enumeration and capture behind `platform::windows`; do not expose Windows types to Tauri commands.
- [x] Register `capture_desktop` in `generate_handler!`.
- [x] Run Rust tests and `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`.
- [x] Commit with `git commit -m "feat: capture the Windows virtual desktop"`.

### Task B2: Tauri Desktop Bridge

**Files:**
- Create: `apps/desktop/src/bridge/tauri-desktop-bridge.ts`
- Test: `apps/desktop/src/bridge/tauri-desktop-bridge.test.ts`
- Create: `apps/desktop/src-tauri/src/output.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**

```ts
export function createTauriDesktopBridge(invoke: TauriInvoke): DesktopBridge;
```

```rust
#[tauri::command]
fn copy_png(png_bytes: Vec<u8>) -> Result<(), String>;

#[tauri::command]
async fn save_png(window: tauri::Window, png_bytes: Vec<u8>, suggested_name: String)
    -> Result<Option<String>, String>;
```

- [x] Test exact Tauri command names and payload keys before implementation.
- [x] Implement Windows CF_DIB/PNG clipboard output and native save dialog behind Rust commands.
- [x] Select the Tauri bridge when `window.__TAURI_INTERNALS__` exists; keep the browser bridge for Vite development.
- [ ] Verify clipboard output in Paint and saved PNG dimensions on Windows (requires Windows runtime validation).
- [x] Commit with `git commit -m "feat: connect native clipboard and save output"`.

### Task B3: Global Shortcut, Tray, and Overlay Lifecycle

**Files:**
- Create: `apps/desktop/src-tauri/src/app_state.rs`
- Create: `apps/desktop/src-tauri/src/tray.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Test: `apps/desktop/src/App.test.tsx`

**Behavior:**

```text
Alt+Shift+A -> capture desktop -> send capture-ready event -> show/focus overlay
Escape      -> hide overlay and clear current session
Tray click  -> start capture
Tray menu   -> Capture / Settings / Quit
```

- [x] Add an app-state test proving a second shortcut press cannot start a concurrent capture.
- [x] Add Tauri global-shortcut, tray, dialog, clipboard, and required Windows dependencies with the smallest feature sets.
- [x] Implement capture events and overlay show/hide ordering so the overlay is never present in its own screenshot.
- [ ] Verify shortcut conflicts return a visible startup error rather than silently failing (requires Windows runtime validation; the error dialog path is implemented).
- [x] Run JS tests, Rust tests, clippy, and `pnpm --filter @screenshot/desktop tauri:build --debug --bundles app`.
- [x] Commit with `git commit -m "feat: add screenshot shortcut and tray lifecycle"`.

Phase B acceptance matrix:

```text
Windows 10 / Windows 11
Single monitor / dual monitor / secondary left of primary
100% / 125% / 150% / mixed DPI
Clipboard open / clipboard temporarily busy
Writable save path / denied save path
Shortcut available / shortcut already registered
```

---

## 5. Phase C — Scrolling Screenshot Engine

### Task C1: Long-Capture Session and Frame Stability

- [x] Define and test the long-capture state machine, stop semantics and partial-result recovery.
- [x] Add Windows target-window tracking and typed wheel-input commands behind the platform boundary.
- [x] Implement frame stability sampling instead of fixed-delay capture.
- [x] Enforce the 200-frame, 60,000-pixel and 120-second limits.
- [x] Commit with `git commit -m "feat: add scrolling capture session"`.

### Task C2: Visual Overlap Matcher and Stitcher

- [x] Build synthetic failing fixtures for normal content, low-texture content and variable scroll steps.
- [x] Implement downscaled grayscale overlap search and confidence scoring as platform-independent pure functions.
- [x] Retry one failed match with a smaller scroll step, then return a partial result.
- [x] Compose original-resolution pixels using the selected seam without repeatedly copying the full output.
- [x] Commit with `git commit -m "feat: stitch scrolling screenshot frames"`.

### Task C3: Static Elements, Bottom Detection, and Editor Integration

- [x] Test fixed headers, fixed footers, floating controls and consecutive unchanged frames.
- [x] Remove repeated static regions when confidence is sufficient and preserve ambiguous content for manual cropping.
- [x] Detect the bottom only after two consecutive no-new-content observations.
- [x] Add the icon-only long-capture action, progress/stop UI, cleanup paths and final-image handoff to the editor.
- [ ] Verify Edge/Chrome, File Explorer, Windows Settings and one Electron application.
- [x] Commit with `git commit -m "feat: integrate automatic scrolling screenshots"`.

Phase C acceptance:

- Selecting a scrollable region starts automatic capture and can be stopped at any time.
- Common browser and desktop content produces a usable long image without obvious duplicate seams.
- Fixed elements are removed when reliable; ambiguous cases preserve content and allow cropping.
- Failures preserve completed frames and always restore the overlay and input state.

---

## 6. Phase D — Cloud API and Coze

### Task D1: Cloud Service and Provider Contract

**Files:**
- Create: `apps/cloud/package.json`
- Create: `apps/cloud/tsconfig.json`
- Create: `apps/cloud/src/domain/result.ts`
- Create: `apps/cloud/src/providers/provider.ts`
- Create: `apps/cloud/src/providers/mock-provider.ts`
- Create: `apps/cloud/src/server.ts`
- Test: `apps/cloud/src/server.test.ts`

**Interfaces:**

```ts
export type RecognitionMode = 'ocr' | 'translate';
export type RecognitionResult = Readonly<{
  sourceLanguage: 'zh' | 'en';
  originalText: string;
  translatedText: string | null;
  blocks: readonly TextBlock[];
}>;

export interface OcrTranslationProvider {
  recognize(mode: RecognitionMode, image: Uint8Array, requestId: string): Promise<RecognitionResult>;
}
```

- [ ] Scaffold a strict TypeScript Fastify service with Vitest and workspace scripts.
- [ ] Test `/v1/ocr`, `/v1/translate`, invalid MIME, images over 8MB, and stable error envelopes.
- [ ] Implement only the Mock provider first and validate responses against Zod schemas.
- [ ] Run `pnpm --filter @screenshot/cloud test -- --run` and root typecheck.
- [ ] Commit with `git commit -m "feat: add mock OCR and translation API"`.

### Task D2: Anonymous Quota and Rate Limiting

**Files:**
- Create: `apps/cloud/src/quota/quota-store.ts`
- Create: `apps/cloud/src/quota/memory-quota-store.ts`
- Create: `apps/cloud/src/security/request-signature.ts`
- Test: `apps/cloud/src/quota/quota-store.test.ts`
- Modify: `apps/cloud/src/server.ts`

**Rules:**

```text
OCR: 20 requests per device per UTC+8 calendar day
Translation: 10 requests per device per UTC+8 calendar day
Maximum image: 8MB and 4096px on the longest edge
Reject timestamps older than 5 minutes
Never log image bytes, recognized text, translated text, tokens, or signatures
```

- [ ] Test exact quota boundaries, reset time, replayed timestamps, per-IP bursts, and log redaction.
- [ ] Implement an in-memory store for development and an interface ready for Redis in production.
- [ ] Return `QUOTA_EXCEEDED`, `RATE_LIMITED`, and `INVALID_IMAGE` without provider calls.
- [ ] Commit with `git commit -m "feat: enforce anonymous cloud quotas"`.

### Task D3: Coze Provider and Workflow Contract

**Files:**
- Create: `apps/cloud/src/providers/coze-provider.ts`
- Test: `apps/cloud/src/providers/coze-provider.test.ts`
- Create: `docs/coze-workflow-setup.md`
- Create: `apps/cloud/.env.example`

**Environment:**

```dotenv
CLOUD_PROVIDER=coze
COZE_API_BASE_URL=https://api.coze.cn
COZE_API_TOKEN=
COZE_WORKFLOW_ID=
```

**Workflow output:**

```json
{
  "source_language": "zh",
  "original_text": "识别文本",
  "translated_text": "recognized text",
  "blocks": [
    {
      "text": "识别文本",
      "confidence": 0.98,
      "box": { "x": 0.1, "y": 0.2, "width": 0.4, "height": 0.1 }
    }
  ]
}
```

- [ ] Test file upload, `POST /v1/workflow/run`, 20-second timeout, invalid JSON, missing fields, unsupported language, and token redaction.
- [ ] Implement file upload followed by the published workflow call; normalize snake_case Coze output into `RecognitionResult`.
- [ ] Refuse production startup when provider is `coze` and any required variable is empty.
- [ ] Document exact Coze start-node inputs, output-node JSON, publishing, token creation, and a curl smoke test.
- [ ] Commit with `git commit -m "feat: integrate Coze OCR translation workflow"`.

### Task D4: Desktop Cloud Client and Result Panel

**Files:**
- Create: `apps/desktop/src/cloud/cloud-client.ts`
- Test: `apps/desktop/src/cloud/cloud-client.test.ts`
- Create: `apps/desktop/src/components/RecognitionPanel.tsx`
- Test: `apps/desktop/src/components/RecognitionPanel.test.tsx`
- Modify: `apps/desktop/src/components/ScreenshotEditor.tsx`

**Interfaces:**

```ts
export interface CloudClient {
  recognize(mode: 'ocr' | 'translate', image: Blob, signal: AbortSignal): Promise<RecognitionResult>;
  quota(): Promise<QuotaResult>;
}
```

- [ ] Test loading, success, retry, abort, quota exhaustion, provider timeout, and malformed response states.
- [ ] Show OCR text blocks with hover-to-highlight; show translation as original/translated pairs.
- [ ] Preserve selection and annotation history for every cloud error.
- [ ] Show the third-party upload privacy notice before the first cloud request and persist only the acknowledgement.
- [ ] Commit with `git commit -m "feat: add OCR and translation result panel"`.

---

## 7. Phase E — Release Verification

### Task E1: CI and Windows Installer

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/windows-release.yml`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `docs/release-checklist.md`

- [ ] CI on pull requests runs `pnpm install --frozen-lockfile`, tests, typecheck, Vite build, Rust tests, and clippy.
- [ ] Windows release workflow builds signed artifacts only when repository secrets are present; unsigned debug builds remain available for internal testing.
- [ ] Add application icons for every size required by Tauri and Windows.
- [ ] Build MSI/NSIS artifacts and install/uninstall them on a clean Windows test account.
- [ ] Commit with `git commit -m "ci: build and verify Windows releases"`.

### Task E2: Final Acceptance

- [ ] Execute every row in the Windows acceptance matrix and record results in `docs/release-checklist.md`.
- [ ] Confirm no screenshot or OCR text appears in application/server logs.
- [ ] Confirm OCR/translation is disabled gracefully when the cloud service is unreachable.
- [ ] Confirm startup, idle memory use, shortcut capture latency, installer upgrade, and uninstall behavior.
- [ ] Run the complete verification suite:

```powershell
pnpm install --frozen-lockfile
pnpm test -- --run
pnpm typecheck
pnpm build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
pnpm --filter @screenshot/desktop tauri:build --debug
git status --short
```

Expected: all commands exit 0 and Git reports a clean working tree.

---

## 8. Cross-Device Handoff Protocol

At the end of every development session:

- [ ] Run the tests relevant to changed files plus the full root test/typecheck commands.
- [ ] Commit only one coherent task per commit.
- [ ] Push the current branch to `origin`.
- [ ] Update the checkbox for the completed task in this file.
- [ ] Add a dated entry below with branch, HEAD, passed checks, and the exact next step.

Handoff entry format:

```markdown
### YYYY-MM-DD HH:mm — <device name>

- Branch: `codex/example`
- HEAD: `<sha> <subject>`
- Verified: `pnpm test -- --run`, `pnpm typecheck`
- Blockers: none
- Next action: Task A1, write the failing rectangle gesture test
```

## 9. Copyable Resume Prompt

Use this prompt on the next device:

```text
继续开发当前截图工具。先阅读：
1. docs/superpowers/specs/2026-07-21-cross-platform-screenshot-tool-design.md
2. docs/superpowers/plans/2026-07-21-project-continuation-roadmap.md
3. README.md

然后执行 git status、git log -5、pnpm install --frozen-lockfile、pnpm test -- --run、pnpm typecheck。
从 continuation roadmap 中第一个未勾选的任务继续，严格使用 TDD：先写失败测试并确认失败，再写最小实现，验证全量测试后提交并 push 当前分支。不要跳过 Windows 多显示器/DPI、隐私和扣子适配器边界。
```

## 10. Handoff Log

### 2026-07-21 — initial device

- Branch: `main`
- HEAD: `963dfb4 build: add Tauri-ready desktop configuration`
- Verified: 20 tests, TypeScript typecheck, Vite production build.
- Blockers: Rust stable MSVC toolchain was not installed on the initial device; native Tauri compilation was not executed there.
- Next action: bootstrap the new Windows machine, then start Task A1 on `codex/windows-native-capture`.

### 2026-07-21 — pointer annotation session

- Branch: `main`
- HEAD: `5087929 feat: add pointer-driven annotations`
- Verified: 30 tests, TypeScript typecheck, Vite production build.
- Blockers: none.
- Next action: Task A2, write failing tests for `resizeSelection` and inline text commit/cancel.
