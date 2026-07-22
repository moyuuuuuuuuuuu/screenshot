# WeChat 4.1.11 Parity Acceptance Record

## Deterministic visual metrics

| State | Measurement | Result |
| --- | --- | --- |
| Ordinary toolbar | 28 px buttons, 20 px Lucide icons, 1.8 stroke, 2 px gap, 8 px radius | Pass (automated, 2026-07-22) |
| Selection | `#07c160` border/accent, 6 px handles | Pass (automated) |
| Scroll initial | No empty image placeholders and no frame/pixel counter | Pass (automated) |
| Scroll grown | 148 px rail, 12 px gap, 36 px actions, 6 px action gap, 8 px edge anchor | Pass (automated) |

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
