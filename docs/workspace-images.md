# Carbon workspace and local images

This increment builds on the command palette (PR #12) and editor ergonomics (PR #11). Owner-authorized consolidation integrates the three increments into `dev` in dependency order, using merge commits to preserve ancestry. Promotion from `dev` to `main` remains a separate owner decision. PR #10 was already merged before consolidation began; any later promotion requires fresh validation and review.

## Working with references

Open a Markdown Entry from the file tree or command palette to open or focus its Editor tab. Carbon uses one CodeMirror editor at a time. Switching tabs retains each open Entry's draft, selections, scroll position and undo history during the session. Opening the same Entry again focuses its existing tab. The same Entry can also be open independently in Viewer.

Choose **View** beside a file in the tree (accessible name: “Open [path] in Viewer”), or **Open in Viewer** above the Editor, to open a reference. Viewer supports Markdown, bounded CSV tables, exact-source JSON inspection, validated PNG/JPEG/WebP images, and any other text file (valid UTF-8, no NUL in the first 8 KiB) as read-only source with line numbers and syntax highlighting; binary files stay download-only. Internal Entry links in Viewer stay in Viewer, including stable-ID wiki links. Relative links to supported assets also stay there. External destinations remain inert text dialogs; Carbon does not navigate to them.

A useful starting workflow:

1. Open the working Markdown note in Editor.
2. Open research Markdown, an inventory CSV and a requirements JSON file with their tree **View** buttons.
3. Switch Viewer tabs while writing and saving the note.
4. Open another Editor Entry and return to the note; its unsaved work and editing state remain intact.
5. Use the command palette for another Entry or a highlighted full-text passage. It targets Editor and retains Viewer tabs.

Desktop panes start at 50/50. Drag the divider, or focus it and use Left/Right to resize; Home resets to 50/50. Width is bounded to 25–75% for Editor. **Swap panes** changes their visual order. **Hide Viewer** retains its tabs and scroll positions. On narrow screens, **Editor** and **Viewer** select one pane at a time. Tab strips scroll horizontally.

There are at most 20 tabs per pane. Opening or creating another document at the limit asks you to close a tab; it never evicts an existing tab, including when saving a Return answer as a new Entry. Close buttons work by mouse or touch. Within a tab strip, Left/Right and Home/End select tabs; Delete closes the focused tab. Normal Tab moves to controls outside the strip. Editor's existing list indentation and focus escape remain: Escape followed by Tab leaves CodeMirror; Ctrl+M (macOS Shift+Alt+M) toggles its Tab focus mode. Closing an Editor tab keeps its draft in the file tree; reopening restores it. Unsaved labels and active-tab borders do not rely on color alone.

The local workspace cache stores tab paths, active documents, Viewer scroll positions, pane visibility, mobile pane choice, arrangement and width. Accepted Return renames update both tab sets, active paths and Viewer scroll keys atomically; failed acceptance leaves them unchanged. Markdown Viewer links refresh against each new Stack, and scroll restoration waits for local image decoding/layout. Invalid/missing paths are removed on recovery. Importing a different Stack clears document tabs but retains the layout preference. Tabs never enter the portable Stack format. Editor selection/scroll/undo are session-only; they are not restored after a browser reload. Existing IndexedDB draft recovery and archive export rules still apply. Use one Carbon window per workspace.

## Inserting and viewing screenshots

With a Markdown Entry open, paste image clipboard files, drop images on the text position, or choose **Insert Image**. The picker also supports touch. PNG, JPEG and static WebP are supported. Carbon validates bytes independently of filename or claimed MIME type, checks bounded dimensions and complete container structure (including every PNG chunk CRC, JPEG scans and a terminal end marker), then requires successful browser decoding. SVG, animated PNG/WebP, external URLs, and unsupported codecs are not rendered.

The main selection is replaced by one or more Markdown image references; a drop inserts at the drop position. Up to eight images can be inserted together. Each original image becomes a uniquely named `assets/image-<UUID>.<extension>` Stack asset without a naming dialog. Existing `Assets` capitalization is respected; when a file occupies `assets`, images use the Stack root. References are explicit relative paths with URL-escaped components, so nested Entries and paths with spaces or punctuation resolve safely. Moving an Entry does not rewrite relative asset references; check/rewrite those references after a move, as with other relative links.

Before changing the editor, Carbon validates the complete proposed draft and Stack, then commits assets, draft references and prior-revision history together through the existing atomic IndexedDB commit. Invalid data, a changed Entry while the picker was open, or a failed cache write leaves the existing draft and Stack unchanged. After an image cache-write failure, Carbon disables recovery caching and explicitly asks you to retry; the failed attempt inserts nothing. A retry with the cache unavailable uses an in-memory transaction and warns you to export before closing. It does not claim durable browser recovery. Save the Entry before exporting. Undo removes the inserted reference, while retaining the original asset for redo and other references. Unreferenced assets are not automatically deleted.

Preview and Viewer fit local images to document width. Activate an image to inspect its original resolution in a modal with Fit, 100%, zoom, pan, Download original, Close and Escape controls. Focus returns to the originating image when available. Original metadata and bytes are preserved, including in TAR and TAR.GZ; no transcoding or metadata stripping occurs.

Limits: 8 MiB per asset, 8192 pixels per side, 16 × 1024 × 1024 decoded pixels per image, plus existing Stack limits. One Markdown preview renders at most 12 images / 32 × 1024 × 1024 pixels inline; additional images have an explicit Open image button. These bounds reduce decode and DOM pressure; this is not an unbounded media browser. Native codec support can still reject an otherwise recognized raster.

## Security and implementation boundaries

`images/assets.js` owns pure bounded header checks, fail-closed local path resolution and transaction planning. `ui/images.js` validates with the browser decoder and manages short-lived blob URLs. `ui/entry-preview.js` is the shared sanitized Markdown/link pipeline for Preview and Viewer; the Viewer passes its own origin Entry and navigation callback.

DOMPurify still excludes `img`, SVG and active HTML from rendered Markdown. The renderer emits escaped image placeholders; only validated local asset bytes are turned into DOM image nodes. CSP changes narrowly from `img-src 'none'` to `img-src blob:`. HTTP(S), data URLs and file URLs are not allowed image sources; `connect-src 'none'`, hashed scripts and the remaining restrictions stay in place. Blob URLs are revoked when their rendering is replaced, detached or the inspector closes. No runtime dependency or external service is added. Rebuilding updates the single-file script hash; existing local license notices remain complete.

The existing CodeMirror adapter receives only a file-input event bridge, tab-session pinning and rename handling. Search ranking, entity resolution, template command registration, Dispatch and Return logic remain with their existing owners. Workspace navigation wraps the existing Entry route, preserving palette exact-occurrence selection/highlighting.

## Validation and remaining acceptance

Automated coverage includes delayed-persistence/atomic-commit ordering on success and failure, accepted rename session/tab recovery, refreshed stable-ID links, delayed/cancelled image hydration and scroll recovery, truncated JPEG and corrupt PNG CRC refusal, cross-Stack reset with overlapping paths, full-tab Save answer refusal, explicit in-memory image retry/export after cache failure, tab/draft/state recovery, three reference types, independent Viewer links, Editor selection/undo/redo, palette jumps, tab focus, narrow layouts, image picker/paste/drop positions, invalid batches, corrupt decoding, failed persistence, stale picker state, image inspector focus, local-only CSP, original-byte archive round trips and fresh offline import. Browser runs use `file://` with networking disabled and assert no HTTP(S) requests or page errors. The main runner includes these alongside existing import/export and Dispatch/Return regressions. Reproducible build tests verify the generated artifact and CSP hash.

**Physical Chrome on Android has not been tested.** Required device acceptance remains: software-keyboard typing, IME composition and selection across Editor tab switches; viewport/keyboard resizing and scrolling; touch selection and Insert Image from the Android picker; actual screenshot clipboard formats; touch scrolling/zoom/pan in image inspection; draft recovery after backgrounding/reloading; TalkBack labels/focus and Escape/back behavior where available. Synthetic desktop clipboard/drop and mobile viewport tests do not establish those results.

Deferred: advanced tab management/reordering, persisted Editor undo/selections across reload, reference rewriting on Entry moves, image garbage collection and image-aware AI Dispatch. The accepted Dispatch follow-up must detect/preselect local images referenced by selected Entries, retain explicit sharing approval and individual deselection, default text-only export to excluding image bytes while keeping Markdown references unchanged, offer an optional **Encode selected images as Base64** checkbox with size warnings, and retain approved original assets in Files/TAR exports. No automatic sharing is added here.

Out of scope: simultaneous editable panes, multiple Stacks, XLSX/PDF rendering, cross-device synchronization, external image loading and release promotion.

## Dependency integration

Starting heads were #11 `2f02a6b0d91beff10e1d64fc7c33f390e96610f7`, #12 `e8b56ea7998572a1d14bf6d952613368d61a7a6c`, and #13 `42e3d43f255af415bf4efaa4bd5b34a60a45f5db`. The palette repairs through `c089ab906e48c450e365149404b817678c224c42` are merged into this branch without rewriting the earlier implementation commits. The generated HTML is rebuilt from the combined source rather than text-merging the artifact.

All four inherited palette review findings are repaired with focused unit/offline browser regressions: literal query boundary whitespace, Markdown-aware title extraction and template H1 replacement, and visibly disambiguated template commands, plus literal generated heading titles and cancellable cold resolver construction. The workspace review repairs cover complete JPEG validation, Markdown resolution invalidation, queued persistence ordering, image-dependent scroll restoration, accepted Return rename mapping, one sequential focus stop per tab strip, PNG CRC validation, cross-Stack tab reset, non-evicting tab limits and explicit image cache-failure recovery. These are resolved implementation defects, not deferred UX requests. Exact-head CI/review and final integrated validation evidence are recorded on the PRs and canonical follow-up issue.
