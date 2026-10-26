# Carbon editor ergonomics

Post-release feature branch from `dev`. No format migration or release gate. The existing product-identity documentation is unchanged.

## CodeMirror 6 assessment

Use CodeMirror 6 for the editor foundation. Its Markdown commands, transaction history, multiple selections and composition handling replace a growing set of custom textarea behaviors. Carbon contributes a small adapter, task/format commands and a wiki-link completion source. No framework or runtime service is introduced.

The pinned runtime packages are in `package.json`/`package-lock.json`: state 6.7.6, view 6.43.15, commands 6.11.1, language 6.13.1, lang-markdown 6.5.2, autocomplete 6.20.4, search 6.7.2 and Lezer highlight 1.2.5. The adapter uses the GFM Markdown language without embedded language bundles or `basicSetup`. No runtime fonts or dependencies are downloaded.

Measured against `dev` at `4845f8411cec6e566445115f0affac13d4706c9a`: baseline HTML 428,533 bytes (140,769 gzip); current integration 834,062 bytes (265,774 gzip, Node zlib default level). The two daily-writing corrections add 2,410 raw bytes / 865 gzip bytes over reviewed head `c21cb272b9fd2f3854793392232d65ea6c2956d2`. Total growth is about 406 KB raw / 125 KB gzip, roughly doubling the original file. Gzip figures are transfer comparisons; the actual offline artifact is plain HTML. A 900,000-byte raw budget in the build test makes further growth explicit. The build targets remain Chrome 120, Firefox 120 and Safari 17; target syntax is not a browser-support certification.

This cost is accepted for avoiding homegrown selection/history/IME machinery. Physical Android acceptance remains outstanding after the authorized dev integration. If it reveals serious input defects, assess a focused editor repair or the minimal textarea fallback before any future release promotion. Do not keep two editors synchronized as a runtime fallback.

## Ownership and lifecycle

- CodeMirror owns typing, selections, composition, pairing and per-Entry undo/redo.
- Carbon still owns draft strings, IndexedDB, validated Stack changes and revision History. Every document edit passes through `sourceFor` (and, for Stacks, `editorSource`), retaining original YAML comments, the BOM and uniform LF/CRLF/lone-CR line endings; mixed endings are saved only after an explicit LF choice (see `docs/text-files.md`). Files that are not Markdown open in a plain Text editor mode without the Markdown language, keys or completion.
- Saving, switching preview and ordinary rerenders keep the editor state. Navigation caches up to 20 Entry editor states for this session; reopening an evicted Entry still recovers its text, but not session undo history. Reload recovers draft text, not editor undo history.
- Discard or an external replacement with different text resets that Entry's undo history so stale edits cannot be resurrected. Stack identity changes clear all cached editor states. Read-only and editable compartments enforce the existing busy guard.
- Preview rendering still uses the existing sanitized Markdown path. Return acceptance, persistence transaction ordering, revisions, archive handling and Dispatch permissions are unchanged.

## Editing behavior

| Action | Pattern |
| --- | --- |
| Continue list | Enter; ordered items increment, nested markers retain depth, task continuations are unchecked |
| Exit empty list item | Enter removes one level; no automatic loose-list conversion |
| Indent / outdent | Tab nests list items beneath a preceding sibling; Shift+Tab moves them up one level. Handles bullets, numbered lists, tasks and selected item ranges, with attached child content. Outside a movable list, Tab inserts an indent unit (two spaces) at each cursor or indents every selected line, and Shift+Tab removes one |
| Toggle tasks | Alt+C or **Toggle task**; all checked → all unchecked; all unchecked or mixed → all checked. Only existing task checkboxes on selected lines change, each once; a selection ending at the next line's column zero excludes that line |
| Pair / surround | Built-in quote/bracket pairing; typing quotes/brackets around a selection wraps it; `*`, `_`, `~` wrap selected text |
| Bold / italic | Ctrl/Cmd+B or I; **Bold** touch control; one undoable transaction across selections |
| Multiple selections | Alt+click, rectangular selection, or **Select next** (repeat to add matches); native CodeMirror selections |
| Optional select-next key | Opt in under **Editor keys** to use Ctrl/Cmd+D inside the editor for this session; off by default |
| Undo / redo | Ctrl/Cmd+Z; Ctrl/Cmd+Shift+Z; platform Ctrl+Y where applicable |
| Save | Existing Ctrl/Cmd+S and **Save Entry** |
| Preview | Alt+P or **Toggle preview**, plus the existing view selector; focus moves to the visible pane |
| Focus navigation | Tab never leaves the editor by itself. Press Escape then Tab / Shift+Tab within two seconds to leave, or Ctrl+M (Mac: Alt+Shift+M) to toggle persistent Tab focus navigation. Read-only or composing input lets Tab through to the browser |

List indentation uses Markdown marker widths, including multi-digit numbers, instead of inserting a fixed two spaces. A selected parent carries its children and continuation lines; selecting those children as well never moves them twice. Selection direction, multiple cursors and the main selection are retained; each command is one undoable transaction. A range ending at column zero excludes that line. Indenting requires an unselected preceding sibling; outdenting requires a parent list item. If any selected nonblank line is outside a supported list or cannot move, the entire command falls through to focus navigation. This includes ordinary prose, YAML frontmatter, code, root-level outdent, and quoted lists. Large documents whose syntax is not available within the parsing budget also fall through. Browser find, location, back/forward and bookmarks remain available by default.

Task normalization excludes fenced/indented code and YAML frontmatter (including unfinished frontmatter). Already-checked `X` markers retain their spelling when a mixed selection is checked; unchecking accepts either `x` or `X`. No new task syntax is inserted.

Alt shortcuts can be intercepted by an OS or keyboard layout. All custom actions have visible controls or conventional alternatives. Composition events are left to CodeMirror; custom formatting does not intercept active composition. This work does not redefine Carbon's existing global Dispatch shortcut.

Wiki completion starts after `[[`, uses committed Entry IDs and paths, and checks every proposed target with Carbon's `resolveEntry` (including stable-ID precedence). Ambiguous aliases are omitted. It skips fenced/inline code and YAML frontmatter, including unfinished frontmatter. Completing a link consumes any already-paired closing brackets. Options are recomputed while typing and validated again when applied; up to 200 matches are shown. Unsaved metadata does not redefine the committed resolver index.

## Mobile and accessibility

At widths up to 600px the initial view is Editor; users can choose preview or split view. Text wraps, touch action targets are at least 44px high, the editor uses 16px system monospace text, and the existing Files overlay and Dispatch drawer remain available. No fixed-height keyboard assumptions or manual `beforeinput` replacement logic are introduced. The editable surface is labeled and announces read-only state; actions have text labels, visible focus and keyboard help. Colors use existing light/dark theme variables.

Automated mobile coverage uses a 393×852 touch viewport, Android user-agent, Chromium composition events via CDP, and the actual CodeMirror input surface. Mobile fixtures use public editor transactions because Playwright’s direct contenteditable `fill()` races Android’s deferred DOM selection after completion taps; the behavior checks still use actual keys, touch controls and composition events. This exercises the Android code path but is not proof of Gboard/Samsung keyboard, autocorrect, selection handles, voice input or a physical Chrome Android device. **Physical Android Chrome acceptance remains unverified.** Before merging, manually verify those input methods on a real device, keyboard show/hide and orientation changes, selected-range task normalization through the touch control, and external-keyboard Tab/Shift+Tab, both focus escapes, Alt+C and undo/redo. Firefox/Safari, non-US keyboard layouts and screen readers remain manual checks.

## Lightweight CSV and JSON assets

Opening `.csv` or `.json` shows a read-only preview alongside the existing Download Asset action. UTF-8 input is limited to 256 KiB for preview. Larger or malformed files remain downloadable. No parser output is written back to the Stack.

CSV supports comma delimiters, quoted commas/newlines, doubled quotes and CRLF/LF. Malformed quoting is rejected. The view keeps at most 200 rows × 50 columns, reports truncation, and shows the first row as data rather than assuming a schema. Ragged rows remain visible. All cells use text nodes; formulas are displayed without evaluation. Semicolon CSV, encodings other than UTF-8, spreadsheets, filtering and editing are follow-ups.

JSON is validated and displayed as exact decoded source. This deliberately preserves large numeric literals, duplicate keys and whitespace; `JSON.parse`/`stringify` is not used to regenerate it. A lossless formatted/tree view can follow separately. Asset support in Carbon does not establish what an external AI can read: Dispatch packaging and destination capabilities still apply.

## Reproducible build and verification

`npm ci && npm test && npm run build && npm run test:browser` is the normal path. Build notices now traverse pinned runtime dependencies, including transitive CodeMirror/Lezer packages. All notices are embedded and written to `dist/THIRD-PARTY-LICENSES.txt`. The single script's SHA-256 CSP is regenerated from exact escaped bundle bytes; network/script policies are not relaxed. CodeMirror's generated styles fit the existing inline-style policy.

Focused unit tests cover structural list indentation (including multi-digit markers and nested child content), selected ranges/multiple cursors, task normalization and selection boundaries, pairing, undo/redo, resolver collisions, excluded syntax, CRLF preservation, bounded CSV and lossless JSON inspection. Offline browser scenarios exercise actual Tab/Shift+Tab, both focus escapes, repeated Alt+C and the task touch control, completion, multiple cursors, optional shortcuts, undo across save/preview/navigation/discard, composition, and inert asset rendering. The existing offline archive/draft/sanitization/Dispatch/Return/theme suite also runs. Browser helpers use CodeMirror's public view lookup in a test-only bundle; the shipped app exposes no test hooks.

Local verification uses Node 24.19.0 and Chromium 153.0.8010.0. CI uses the Playwright-pinned Chromium and uploads browser evidence. See the draft PR for exact-head CI and Codex review results.

Primary references: [CodeMirror reference](https://codemirror.net/docs/ref/) (live documentation; no version date stated), pinned package source for Markdown/history/completion behavior, and [esbuild build API](https://esbuild.github.io/api/) (live documentation; no version date stated).
