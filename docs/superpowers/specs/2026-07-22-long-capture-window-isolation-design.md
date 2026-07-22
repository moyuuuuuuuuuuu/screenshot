# Long Capture Window Isolation and First-Edition Icons

## Context and evidence

The supplied 23.7-second Windows recording shows the screenshot selection, annotations, green border, and long-capture controls remaining inside the captured region after long capture starts. The preview window is positioned over the selection and the GDI desktop capture records both screenshot-tool windows. Each new frame therefore contains the tool itself instead of only the target application.

The recording and state flow also confirm a separate Escape-key mismatch. During long capture, Escape calls `request_stop`, which preserves a partial image. Cleanup then restores and focuses the screenshot overlay. The user expects Escape to abandon long capture and exit the screenshot tool.

The first-edition toolbar used Lucide icons at 20 px with a 1.8 px stroke. The current toolbar replaced these with hand-authored 18 px SVG icons at a 1.6 px stroke.

## Approved behavior

### Capture isolation

On Windows, both the main screenshot overlay and the long-capture preview window must be excluded from screen capture before the first long-capture frame is sampled. They remain visible and interactive to the user, but their pixels must not appear in GDI captures. Window exclusion is released or becomes irrelevant when the windows close; unsupported Windows versions return a clear error instead of silently capturing the tool recursively.

The exclusion operation belongs to the Windows platform boundary. Long-capture orchestration requests exclusion after creating the preview window and before the existing settling interval and first frame. The platform-neutral fallback keeps compilation explicit and reports that capture exclusion is unsupported.

### Escape semantics

Escape during long capture means cancel, not stop:

1. Set the runtime cancellation request.
2. Discard all accumulated long-capture output.
3. Close the long-capture preview window.
4. Hide the main screenshot overlay rather than restoring and focusing it.
5. Clear the active capture session so the configured shortcut can start a new screenshot immediately.

The four visible preview actions keep their existing meanings. In particular, Edit and Finish still preserve the result; only Escape and the cancel icon discard it and exit.

### First-edition icon style

Replace the custom screenshot toolbar SVG set with Lucide components. Existing first-edition actions reuse their original icons. New actions select the closest Lucide equivalents while preserving the current action order and icon-only labels:

- rectangle / ellipse / emoji / arrow / pen / mosaic / text
- privacy / OCR / scrolling capture
- undo / save / pin / share / cancel / complete

Every toolbar icon renders at 20 px with a 1.8 px stroke, round caps, and round joins. Button geometry and the approved WeChat toolbar layout remain unchanged; this change restores icon language, not the discarded dark first-edition toolbar container.

## Component boundaries

- `platform/windows`: resolve the native HWND and apply Windows capture exclusion.
- `platform`: expose a typed capture-exclusion operation with a non-Windows fallback.
- `preview_windows` and `long_capture`: identify both window targets, apply exclusion before capture, and restore or hide according to the termination reason.
- global shortcut handler: route Escape to cancel-and-exit while long capture is active.
- screenshot editor: treat native cancellation as a silent exit path and avoid restoring editor state.
- toolbar/icons: map actions to Lucide components with one shared size and stroke contract.

## Error handling

- Failure to exclude either screenshot-tool window aborts long capture before sampling any frame.
- Cleanup always closes the preview window and unregisters Escape.
- Normal failures restore the editor so an error can be shown.
- Explicit Escape/cancel hides the editor and discards output.
- A failed cancellation cleanup must not leave the long-capture runtime marked active.

## Testing

Testing follows red-green-refactor:

1. Rust tests prove the window-isolation request happens before the first frame and that cancel cleanup hides rather than restores the overlay.
2. Runtime tests prove Escape selects cancellation and discards accumulated frames.
3. React bridge/editor tests prove Escape calls cancel, closes the overlay, and does not load a partial image.
4. Toolbar tests prove all actions render Lucide-compatible 20 px icons with a 1.8 px stroke.
5. Full frontend, Rust, Clippy, formatting, production, and Tauri debug builds run before commit.
6. Windows acceptance repeats the supplied sequence on scrollable content and confirms that no overlay, selection border, annotation, preview, or controls appear in the stitched image.

## Scope limits

This change fixes recursive self-capture and Escape behavior visible in the supplied recording. It does not alter overlap matching thresholds unless a clean, tool-free capture reproduces a separate stitching defect. Coze workflows and ordinary annotation behavior remain unchanged.
