# Carbon editor-first shell

Carbon's application shell is a compact, keyboard-first Markdown editor. The design came from the supplied "editor-first shell" package and was integrated on top of `dev` (PR #16, ordinary folders). Document persistence, filesystem semantics, `local-files.js`, `fs.js`, the workspace model, `state.js`, the controllers, `stack-io.js`, the CodeMirror adapter, Cast Kit, the CSP and the build script are unchanged. Every existing control id is kept.

## Layout

```
header (38px): explorer toggle · carbon / Stack · [search / commands] · Open ▾ · Export ▾ · Dispatch · More ⋯
explorer │ pane bar: tabs … split · Viewer · Save Entry · Document ⋯
         │ editor | preview     (optional Viewer pane with its own tabs)
status (26px): EDITOR VIEWER · path · save state · [link status] … persistence · theme
```

- One header row replaces the former toolbar, workspace-tools, editor-toolbar and notice rows. `#notice` floats above the status line; routine info/ok messages without actions fade after 6 s, errors and messages with actions stay until dismissed.
- Each pane has one bar: compact tabs (a `●` marks an unsaved draft; the accessible name still says "unsaved draft") and that pane's tools. The Viewer is hidden until opened (`#show-viewer`, the palette, Open in Viewer, or a tree row's View button) and keeps independent documents and tabs.
- `#view` (visually hidden) remains the single source of truth for edit / split / preview. Default stays Split on desktop; phones start in Edit.
- Infrequent actions live in native `<details>` menus: Open (`#menu-import`), Export (`#menu-export`), More (`#menu-more`: Import Return, New Stack, History, Capabilities, Keyboard shortcuts) and Document (`#menu-doc`: task, bold, select next, preview, layout, insert image, Open in Viewer, Dispatch this, Rename, Download, Delete, Text details, Inspect characters, the Show invisibles and Ctrl/Cmd+D options). Every button keeps its id and handler.

## Split view

`ui/split.js` is mounted from `app.js` after `mountEditor` (it drives `#view.onchange`).

- `#toggle-split` is a pressed-state toggle between edit and split. Alt+P still toggles edit and full preview.
- `#preview-splitter` resizes by pointer or touch; arrow keys move 2%, Home or double-click resets to 50%. The range is 20-80%.
- "Preview below / on the right" (`#toggle-layout`, Document menu or palette) flips the split. Ratio and orientation are remembered in `localStorage` (`envoy.carbon.split`; storage failures are ignored). Editors narrower than 560px stack automatically.

## Keyboard model

| Keys | Action |
| --- | --- |
| Ctrl/Cmd+Shift+P | Palette (commands, Entries, entities, content) |
| Ctrl/Cmd+\ | Show or hide the explorer (remembered on desktop) |
| Ctrl/Cmd+Shift+D | New Dispatch |
| Ctrl/Cmd+S, Alt+P, Alt+C, Ctrl/Cmd+B/I, Alt+click | Unchanged editor shortcuts |
| Tab / Shift+Tab | Nest or un-nest list items; elsewhere indent or outdent (Escape then Tab leaves the editor; Ctrl+M toggles focus mode) |
| F1 | Keyboard shortcuts dialog (also More → Keyboard shortcuts) |
| Enter / Space, ↑ ↓, Esc | Menus: open, move, close and return focus to the summary |

The palette lists every shell action by forwarding to the real control, so guards and enablement stay with the owning module. A control that is disabled, or hidden (itself or through a hidden ancestor), is omitted. View and Theme commands are also listed.

## Responsive breakpoints

- Below 1180px the split stacks editor over preview and the Stack crumb hides; below 1040px the launcher becomes an icon.
- Below 860px the explorer is an overlay (`.side-open`), one document pane shows at a time (switched from the status line) and swap is hidden.
- At 600px and below (Android): 48px header, 44px targets everywhere (header, pane bar, status line, accessory row, menu items), menus open as full-width sheets, the palette is full-screen, and a formatting row (`.accessory`, buttons with `data-proxy`) forwards to the real controls and mirrors their disabled state. The viewport meta has `interactive-widget=resizes-content`. When the viewport is shorter than 520px (soft keyboard) the status line hides. Editor text is 16px.

## Hooks for other modules

Hidden by default and without behaviour here: `#disk-history` (Document menu), `#reconnect-folder` (More menu), `#export-history` (Export menu), `#link-status` (status line, `.status-link`) and `#save-state` (pane bar, `.save-state`). Both text spans accept the modifier classes `.is-dirty`, `.is-saving`, `.is-saved` (muted), `.is-conflict` (amber) and `.is-error` (error colour; the shell has no separate red, so it matches the notice error colour, bold).

## Deviations from the design package

- `mountSplit()` is called from `app.js` (a two-line change) instead of `mountToolbar`; at toolbar mount time `#view.onchange` does not exist yet, so the phone Edit default would have thrown.
- The palette close button precedes the search input in DOM order (placed last visually with CSS `order`). The package put it after the input, so Shift+Tab left the modal dialog and the existing palette focus test failed.
- The palette skips controls inside a hidden ancestor, not only hidden controls; shell command descriptions show the shortcut or the control id.
- Phone targets are 44px as specified in the README, not the 40px the package's CSS used for pane tools; the status line is 45px on phones (44px targets plus the border), and the notice sits above the formatting row. `#editor-status` shrinks only while it holds the Discard button so the status line never overflows at 360-393px.
- The package's refinements test asserted `aria-expanded` immediately after a viewport change; the test now waits for it because the media-query event can land a frame after layout.
- `tests/build.test.js`: the offline HTML budget moves from 900,000 to 940,000 bytes. The shell CSS and markup add about 22 KB (888,798 to about 911,400 bytes).
- Added link/save hooks and split-persistence, range and hook assertions to `tests/shell-browser.mjs`; routed the `localTransitionFlows` clicks of `#history`, `#new-stack` and `#import-return` through `menuClick`.

## Verification

`npm run check` (unit tests, build, offline Playwright suite). `tests/shell-browser.mjs` runs at 1440×900, 1024×700, 412×915 and 360×740 and records the editor-surface share per viewport. Physical Android Chrome (Gboard, rotation, screen readers) is not claimed.
