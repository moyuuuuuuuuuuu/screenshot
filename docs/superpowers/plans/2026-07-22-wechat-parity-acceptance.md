# WeChat 4.1.11 Parity Acceptance Record

## Deterministic visual metrics

| State | Measurement | Result |
| --- | --- | --- |
| Ordinary toolbar | 28 px buttons, 20 px Lucide icons, 1.8 stroke, 2 px gap, 8 px radius | Pass (automated, 2026-07-22) |
| Selection | `#07c160` border/accent, 6 px handles | Pass (automated) |
| Scroll initial | No empty image placeholders and no frame/pixel counter | Pass (automated) |
| Scroll grown | 172 px desired / 120 px minimum outside sidecar, 6 px gap, 34 px actions, 4 px action gap, 6 px edge anchor | Pass (automated, 2026-07-22) |
| Screenshot mask | One outside-only black layer at alpha `0.3`; selected pixels unmasked | Pass (automated, 2026-07-22) |

The golden file stores measurements only. Local WeChat reference pixels are excluded from source control.

## 2026-07-22 long-capture isolation checks

| Check | Status | Evidence |
| --- | --- | --- |
| First-edition icon metrics | Pass | `pnpm --filter @screenshot/desktop test -- --run`: 90 tests passed, including toolbar, preview, and visual parity tests |
| Self-capture isolation boundary | Pass automated / Pending physical pixel pass | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` is tested for both overlay and preview ordering before the first long-capture frame; real Chrome/Edge pixel capture still needs a Windows manual pass |
| Manual wheel growth | Pending physical runtime pass | Requires user/manual Windows scroll sequence against a scrollable target |
| Escape exits long capture | Pass automated / Pending physical runtime pass | React test verifies Esc calls cancel, closes overlay, and ignores later partial output; Rust tests verify cancel cleanup hides overlay |
| Cancel discards output | Pass automated / Pending physical runtime pass | Existing Rust termination tests preserve the cancel-vs-stop distinction |
| Finish preserves output | Pass automated / Pending physical runtime pass | Existing Rust termination/action tests preserve Finish as result-preserving |

Automated verification completed on 2026-07-22:

- `pnpm --filter @screenshot/desktop test -- --run`: 21 files, 90 tests passed.
- `pnpm --filter @screenshot/desktop typecheck`: passed.
- `pnpm --filter @screenshot/desktop build`: passed.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`: passed.
- `cargo clippy -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`: passed.
- `cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml`: 58 tests passed.
- `pnpm --filter @screenshot/desktop tauri:build --debug --no-bundle`: built `apps/desktop/src-tauri/target/debug/screenshot-tool.exe`.

## 2026-07-22 sidecar and session-reset verification

| Check | Status | Evidence |
| --- | --- | --- |
| Sidecar never intersects selection | Pass automated / Pending Windows physical-pixel check | Four Rust layout tests cover right, left, 120–172 px constrained space, and insufficient-space rejection |
| Manual wheel reaches target application | Pending Windows runtime check | Overlay is native mouse-transparent and the interactive sidecar is outside the selected rectangle; requires physical wheel confirmation |
| Escape closes sidecar before overlay and discards output | Pass automated / Pending Windows flicker check | Rust cleanup-order test and React double-Escape test pass |
| Next shortcut starts without the old selection | Pass automated / Pending Windows runtime check | Reducer, editor, and App reset-event tests clear the selection and rebuild a `selecting` session |
| Ordinary mask is one `0.3` layer | Pass automated / Pending visual check | Selection component and golden visual metric tests pass; selected pixels use a transparent surface |
| Stitching thresholds unchanged | Pass | Diff review contains no changes to motion detection, overlap matching, or stitcher thresholds |

Fresh automated verification for this change:

- `pnpm --filter @screenshot/desktop test -- --run`: 21 files, 92 tests passed.
- `pnpm --filter @screenshot/desktop typecheck`: passed.
- `pnpm --filter @screenshot/desktop build`: passed.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`: passed.
- `cargo clippy -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`: passed.
- `cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml`: 60 tests passed.
- `pnpm --filter @screenshot/desktop tauri:build --debug --no-bundle`: built `apps/desktop/src-tauri/target/debug/screenshot-tool.exe`.

## Windows runtime matrix

| Target/input | Status |
| --- | --- |
| Chrome / Edge | Pending physical runtime pass |
| WeChat 4.1.11 | Pending physical runtime pass |
| File Explorer / Windows Settings / Electron | Pending physical runtime pass |
| Mouse wheel / touchpad / scrollbar / Page Down | Pending physical input pass |
| Reverse recovery / fixed bars | Pending physical content pass |
| Shortcut conflict / pin / share | Pending physical runtime pass |
| Coze OCR / translation / privacy | Pending configured credentials |

Do not label the release as full WeChat parity until every pending row is exercised on Windows and changed to Pass or an accepted limitation.
