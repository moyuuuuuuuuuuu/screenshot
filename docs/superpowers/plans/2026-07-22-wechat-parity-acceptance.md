# WeChat 4.1.11 Parity Acceptance Record

## Deterministic visual metrics

| State | Measurement | Result |
| --- | --- | --- |
| Ordinary toolbar | 28 px buttons, 18 px icons, 1.6 stroke, 2 px gap, 8 px radius | Pass (automated) |
| Selection | `#07c160` border/accent, 6 px handles | Pass (automated) |
| Scroll initial | No empty image placeholders and no frame/pixel counter | Pass (automated) |
| Scroll grown | 148 px rail, 12 px gap, 36 px actions, 6 px action gap, 8 px edge anchor | Pass (automated) |

The golden file stores measurements only. Local WeChat reference pixels are excluded from source control.

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
