# Carbon developer guide

How the Carbon notebook and the Envoy Cast Kit fit together in this repository: what each module owns, how data flows from an imported Stack to an accepted Return, which bytes are authoritative, and how to build and test the single offline file. Read `README.md`, `docs/format-v0.2.md` and `docs/architecture-v0.2-draft.md` first for the format and rationale; this guide is about the code.

The [product overview](product-overview.md) defines the current description and vocabulary; the [Carbon user guide](carbon-v1.md) covers notebook and Dispatch/Return use.

**Naming.** *Carbon* is the product: the offline notebook distributed as `dist/carbon.html`. *Envoy* names the compatible protocols and the AI workers that speak them (`envoy.stack/v0.2`, `envoy.handoff/v0.2`, `envoy.cast/v0.1`, `envoy.return/v0.1`, `envoy.dispatch/v0.1`). Identifiers, file names and format strings are unchanged; the rename is in prose only. (Browser storage moved to the new `carbon-vfs` database with PR-A1; see `docs/virtual-workspace.md`.)

## Repository tree and ownership

```
src/
  core/                 Pure Stack model and protocols. No DOM, no I/O.
    validate.js         LIMITS, encode/decode (strict UTF-8), assert, id/path/validatePaths, equal
    entries.js          bounded YAML 1.2 parsing, Entry frontmatter, exact-range scalar patches, stableEntry
    stack.js            Stack (immutable, validated), change(), newStack, sameStack, History, restoreRevision/Snapshot, directoryDiff
    handoff.js          envoy.handoff/v0.2 exact-v1: dispatch(), parseHandoff(), registerDispatch(), propose(), diffLines()
    naming.js           local-date names, suggestPath/suggestStackName, assertNewPath (case-insensitive collisions)
  archives/
    tar.js              readTar (fail-closed POSIX ustar + PAX reader), writeTar (deterministic), archiveRoot
    gzip.js             native CompressionStream/DecompressionStream with output and ratio bounds
  carbon/
    app.js              composition root ONLY: creates state, deps, controllers; mounts views; start()
    shell.html          the DOM skeleton (every id the views and tests rely on) + __CSP__/__CSS__/__JS__ slots
    style.css           all styling, both themes, reduced motion, compact desktop breakpoints
    types.js            JSDoc @typedefs only: WorkspaceState, Deps, DispatchRecord, ReviewModel, Check ...
    state.js            createState (Scratch), blankState, serialize/restore, mountRecord, persist(), commit() (atomic)
    vfs.js              carbon-vfs IndexedDB store: revision-checked atomic transactions, MemoryVfs
    mounts.js           independent workspaces: park/activate, remove, switcher rows
    fs.js               file/folder readers, remembered-folder store helpers, download(), native folder save
    markdown.js         marked + DOMPurify + highlight.js; wiki-link scanning and the per-revision link index
    theme.js            theme preference (localStorage), system preference listener
    templates.json      generated from templates/*.md by the build
    castkit-assets.json generated from cast-kit/ by the build: {playbooks, sources, contract, bootstrap}
    ui/                 Views. Render state, call controllers through deps, never import Cast Kit.
      dom.js            $(id), el(tag, text, cls)
      dialogs.js        the one shared <dialog>: modal(), ask(), confirm()
      status.js         notify() with up to two actions, renderStatus(), footer persistence text
      sidebar.js        tree, search, selection checkboxes, Assets list, Dispatches cards, statusChip()
      editor.js         textarea drafts, preview, inert external links (CB-1), Save/Rename/Delete, Dispatch this
      history.js        History dialog: download or restore a retained snapshot (CB-2)
      stack-io.js       import files/folders/archives (CB-6 preview), export TAR/TAR.GZ, native folders, New Stack
      workspaces.js     Scratch notes and the Workspaces… switcher (switch, download, remove)
      needlecast-legacy.js  export handoff, register original, review a v0.2 Return (unchanged route)
      toolbar.js        Import ▾ / Export Stack ▾ menus, ⇩ Import Return…, ↗ Dispatch…, ☰ Files, Ctrl/Cmd+Shift+D
      dispatch-wizard.js docked drawer: five steps for a draft, status body for every later state
      return-review.js  full-width review mode: file list, diff, checks, decision footer
      diff-view.js      pure (before, after) -> DOM tables; whole-file, rename and metadata views
    controller/         Domain logic. DOM-free; side effects only through injected deps.
      dispatch.js       draft -> Cast -> export; redispatch/continueFrom; owns DispatchRecord mutations
      return.js         route -> stage -> review model -> accept (atomic) / reject / saveReceipt
cast-kit/
  src/kit.mjs           parseCast, parseReturn, encodeReturn, registerStack/registerHandoff, stageReturn, acceptInCarbon
  src/dispatch.mjs      composeDispatch (text packet or selected package), dispatchTar
  src/validation.mjs    bounded YAML and portable-path validators shared with the kit
  src/loop.mjs          bounded adapter driver (host code only; unused by Carbon)
  src/workbench.mjs     the separate offline lab UI, built to cast-kit/dist/cast-kit.html
  playbooks/*.md, operating-contract-v0.1.md, bootstrap.md   text embedded into every Cast
  tests/                kit unit tests, fixtures (harbor Stack, planning fixture), Carbon integration (CARBON_ROOT)
scripts/build.mjs       deterministic esbuild bundle -> dist/carbon.html (+ the two generated JSON inputs)
tests/                  node --test unit tests (*.test.js) and Playwright acceptance (browser.mjs and its passes)
dist/carbon.html        the only runtime artifact; committed and reproducible
```

Import conventions that keep the layers honest:

- `src/core` and `src/archives` import nothing from `src/carbon` or `cast-kit`.
- Views (`ui/*`) import `dom.js`, `core` helpers for rendering (`entries`, `naming`, `validate`, `diffLines`) and nothing from `cast-kit/`. They never mutate `state.dispatches`; they call `deps.dispatch.*` / `deps.returns.*` and then `deps.render()`.
- Controllers import Cast Kit directly (`../../../cast-kit/src/kit.mjs`, `dispatch.mjs`) and core helpers. They never touch the DOM: clipboard, downloads, timestamps and UUIDs are injected (`deps.download`, `deps.clipboard`, `deps.now`, `deps.uuid`), so unit tests capture every side effect.
- `app.js` is the only module that imports everything. It builds one `deps` object (typed `Deps` in `types.js`) and hands it to every `mount*()`; modules reach each other only through `deps`.

## Architecture and data flow

```
                 user                                   external AI (any chat, text or files)
                  │                                                  ▲            │
   files / TAR    ▼                                dispatch.md / TAR │            │ Return text
  ┌───────────────────────────────────────────────────────────────────┴────────────┴───────────────┐
  │ Carbon (dist/carbon.html, file://, offline)                                                     │
  │                                                                                                 │
  │  ui/toolbar  ui/sidebar  ui/editor  ui/stack-io  ui/history  ui/needlecast-legacy               │
  │  ui/dispatch-wizard ──► controller/dispatch ──► cast-kit composeDispatch ──► download/clipboard │
  │  ui/return-review   ──► controller/return   ──► cast-kit registerStack/stageReturn/acceptInCarbon│
  │         │                       │                                                               │
  │         ▼                       ▼                                                               │
  │   deps.render()          state.js: WorkspaceState ── persist()/commit() ──► IndexedDB cache     │
  │                                 │                                                               │
  │                          core/stack.js Stack (immutable) + History;  archives/tar.js, gzip.js   │
  └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Rendering is one-way: views read `state`, controllers and core mutate it (controllers for Dispatch records, `deps.replace()` / `commit()` for Stack revisions), and `deps.render()` redraws. There is no event bus.

## Source versus built artifacts

| Source | Generated by `npm run build` | Checked in |
| --- | --- | --- |
| `src/carbon/**`, `src/core/**`, `src/archives/**`, `cast-kit/src/**` | `dist/carbon.html` (one `<script>` with a sha256 CSP hash, inline CSS, embedded licenses) | yes, must be byte-identical across builds |
| `templates/*.md` | `src/carbon/templates.json` | yes |
| `cast-kit/playbooks/*.md`, `cast-kit/operating-contract-v0.1.md`, `cast-kit/bootstrap.md` | `src/carbon/castkit-assets.json` | yes |
| `node_modules/{yaml,marked,dompurify,highlight.js}` licenses | `dist/THIRD-PARTY-LICENSES.txt` | yes |

CI runs `git diff --exit-code` on these outputs after a build, so a source change that forgets to rebuild fails. The bundle has no runtime `import()`; the CSP is `default-src 'none'; script-src 'sha256-…'; style-src 'unsafe-inline'; img-src blob:; connect-src 'none'; …`, which permits validated local raster assets through short-lived blob URLs while remote image and network loading remain blocked. See [workspace and images](workspace-images.md) for the validation and rendering boundary. `scripts/build.mjs` resolves every `yaml` import from the root `node_modules` (`yamlAlias` plugin) so Cast Kit's sources bundle the same pinned copy as Carbon whether or not `cast-kit/node_modules` exists; `tests/build.test.js` proves the bundle is identical either way and that `yaml` appears once.

## State ownership and lifecycle

`state.js` creates the single `WorkspaceState` and owns its persistence:

| Field | Owner of mutations | Persisted |
| --- | --- | --- |
| `stack`, `history` | `deps.replace()` (app.js) for local edits; `controller/return.accept()` through `commit()` for Returns | yes (packed) |
| `current`, `drafts` | `ui/editor.js` | yes |
| `selected` | `ui/sidebar.js` checkboxes | no (session only) |
| `trusted` (legacy v0.2 dispatch) | `ui/needlecast-legacy.js` | yes |
| `unexported`, `copyState`, `lastArchiveRevision` | `ui/stack-io.js`, `deps.replace()` | yes |
| `dispatches` (`DispatchRecord[]`) | `controller/dispatch.js` (draft/exported/abandoned), `controller/return.js` (staged/accepted/rejected/checkpoint) | yes |

Each workspace is one record in the `carbon-vfs` database (store `mounts`, keyed by its id; `meta/active` and `meta/index` beside it; `folders` holds remembered per-folder linked-folder consent, see `docs/linked-folders.md`). The record is `mountRecord(state)`: `serialize(state)` plus `id`, `kind`, `title`, `updatedAt`; the store adds `rev` and refuses a write whose expected revision is stale (another tab). `persist()` queues a write of the live state and never rejects in Carbon (`app.js` reports quota and conflicts as recoverable states and retries on the next change; other failures switch the window to memory only). Switching workspaces (`mounts.js activate`) runs in the same write queue and parks the open workspace and activates the target in one transaction. See `docs/virtual-workspace.md`. `commit(candidate)` is the atomic path: it serializes `{...state, ...candidate}`, writes it FIRST and assigns into `state` only after the write resolved; on failure the promise rejects and `state` is untouched. Older cache records without `dispatches` or `lastArchiveRevision` restore with defaults.

A `DispatchRecord` moves `draft → exported → staged → accepted | rejected | checkpoint`, or `→ abandoned` from any pending state. While a record is exported, staged or rejected it holds `exported.base`, the packed Stack the Cast was built against; at most eight records may hold a base at once, and terminal states drop it.

## Build, reproducibility and CSP constraints

- Vanilla ES modules, no framework, no runtime CDN, no new runtime dependency. The pinned runtime libraries are `yaml`, `marked`, `dompurify`, `highlight.js`.
- Every string that reaches the DOM is set with `textContent` / `el()` or goes through `renderMarkdown` (DOMPurify) followed by `neutralizeLinks`. No `innerHTML` with untrusted text.
- The build is deterministic: same inputs, same bytes. Do not edit `dist/` by hand.
- Browser tests run from `file://` with `offline: true` and record every http(s) request and page error; both must be empty.

## Lifecycle walk: Stack to accepted Return

1. **Import a Stack.** `ui/stack-io.js` reads the archive (`readTar` → `Stack`) or folder, shows the CB-6 preview (changed files, missing files, empty folders), then `deps.replace(next, "Before importing full Stack")` pushes the old Stack to History and swaps the new one in.
2. **Edit and save.** `ui/editor.js` keeps unsaved text in `state.drafts`; Save Entry calls `stack.change({writes})`, which patches `revision` in the manifest by exact source range and validates the result; `replace()` commits it as one revision.
3. **Dispatch (draft → export).** `↗ Dispatch…` calls `dispatch.startDraft()` (seeded from the sidebar selection or the open Entry; presets pre-fill Playbooks and permissions). The drawer edits the draft through `updateDraft()`; `issues()` lists blockers per step; `preview()` composes the Cast without side effects. `export(id, via)` composes `handoff` (`core/handoff.dispatch`) + Cast (`dump`) + Return template, validates them through Cast Kit (`registerStack`, `composeDispatch`), writes the clipboard or file FIRST, and only then records `exported` (with the packed base) and persists. Exported ≠ delivered: Carbon never sends anything.
4. **External AI.** The user pastes `dispatch.md` (or the files / TAR package) into any chat and brings back the Return text.
5. **Import Return → stage → review.** `⇩ Import Return…` routes by header only (`returns.route`): `# Envoy Cast Return` → `returns.stage()`; `# Envoy Handoff` → the legacy modal; anything else → inline error. `stage()` parses strictly (`parseReturn`), finds the record by `assignment_id`, rebuilds the base Stack from the record, runs the seven checks (framing, cast, base, permissions, ids, omitted, drafts), records `staged` and persists. `ui/return-review.js` renders the `ReviewModel`; the view never decides validity.
6. **Accept one revision.** `returns.accept()` re-registers the current Stack against the Cast (stale → refused), calls `acceptInCarbon` for the new Stack, builds a candidate `{stack, history, dispatches, …}` and commits it atomically. On commit failure nothing changes, the Return stays staged and the notice offers Retry or "Download proposed archive". When no draft cache is available at all, `ui/return-review.js` first requests a `<stack-id>-before-return-r<N>.stack.tar` of the current revision (`deps.downloadSnapshot`), as the legacy route does, because History would otherwise exist only in memory.
7. **Persist / export.** The new revision is in the browser cache only until the user exports TAR/TAR.GZ (`lastArchiveRevision`, "Download requested" → "Confirm archive saved").
8. **Reopen and continue.** On reload `restore()` rebuilds the state, the Dispatches cards keep their status, a staged Return reopens in review from its persisted text, and "New Dispatch from rev N" (`continueFrom`) seeds the next draft from the prior context plus the files the accepted Return created.

## Trust boundary

- **Everything imported is hostile**: Markdown, YAML, archives, Returns, Playbook files, cache records. Core validators are fail-closed with user-facing messages; `readTar` rejects traversal, links, devices, collisions, bad checksums, oversized members and trailing data before any Stack is built.
- **The Cast is the authority.** Permissions come from the Cast Carbon exported (`exported.castSource`), never from the Return. A Return cannot widen its scope: every create/replace/delete/rename and every metadata key is checked against the Cast lists, and Cast Kit re-checks at acceptance.
- **Metadata preservation.** Entry IDs cannot change; frontmatter changes are limited to permitted scalar keys patched by exact range (`patchScalarFrontmatter`); unknown keys, comments, the manifest comment and unknown manifest fields survive (`tests/dispatch-browser.mjs` scenario 2 and 3 assert this byte-for-byte).
- **Omitted files are untouchable.** The handoff carries only `stack.yaml` plus selected Entries; omitted Entries and Assets stay in the full Stack and a Return naming them fails the `omitted` check. New Entry IDs are checked against the FULL current Stack, including omitted Entries.
- **Byte and revision checks.** The base check compares the current Stack to the retained base with `sameStack` (bytes and directories), not only revision numbers; a Stack that moved is stale and the review offers Re-dispatch.
- **Atomic commit, explicit failure.** `commit()` writes before assigning. Storage failure during accept leaves the Stack unchanged and the Return staged, with a notice that says so and a Retry.
- **No network, ever.** CSP `connect-src 'none'`; the browser suites assert zero http(s) requests.

## The two applications

| | Carbon (`dist/carbon.html`) | Cast Kit lab (`cast-kit/dist/cast-kit.html`) |
| --- | --- | --- |
| Purpose | Notebook, Stack editor, integrated Dispatch/Return workflow | Protocol workbench: load an original handoff, author a Cast, validate a Return |
| Mutates a Stack | yes, one revision per accepted Return or local edit | no, staging only |
| Shared code | imports `cast-kit/src/{kit,dispatch}.mjs` and embeds `castkit-assets.json` | imports `src/core` validators through its own tests only (`CARBON_ROOT`) |

Integration points: `registerStack(stack, castSource, handoff)` (registers the base for a Cast), `stageReturn(handle, text)` (review model inputs), `acceptInCarbon(stack, handle, text, {approved: true})` (the new Stack plus acceptance metadata), `composeDispatch` / `dispatchTar` (packets and selected packages), and the `envoy.dispatch/v0.1` manifest whose `complete_stack: false` is why `readTar` refuses a selected package as a Stack.

## Development and test commands

```sh
npm ci && npm --prefix cast-kit ci
npm test                                   # node --test tests/*.test.js
npm run build                              # must leave git clean (dist + generated JSON)
CARBON_BROWSER_PATH=/path/to/chromium npm run test:browser
npm --prefix cast-kit test
npm --prefix cast-kit run build
CAST_BROWSER_PATH=/path/to/chromium npm --prefix cast-kit run test:browser
CARBON_ROOT=$PWD npm --prefix cast-kit run test:carbon
```

The pinned Playwright cannot download a browser in every environment; `CARBON_BROWSER_PATH` / `CAST_BROWSER_PATH` point the suites at an installed Chromium (the suites add `--no-sandbox` and software GL flags when the variable is set). Browser reports land in `test-results/browser.json` with screenshots beside it; `tests/browser.mjs` runs the original workflow, then `refinements-browser.mjs` (themes, naming, layout, the Dispatch UI smoke pass) and `dispatch-browser.mjs` (the integrated Dispatch/Return scenarios).

## Guided code-reading path

1. `src/core/stack.js` — what a Stack is, how `change()` produces the next revision, `History`.
2. `src/core/handoff.js` — the v0.2 packet: `dispatch()` builds it, `parseHandoff()`/`propose()` validate a legacy Return.
3. `cast-kit/src/kit.mjs` — the Cast and Return formats, `registerStack`, `stageReturn`, `acceptInCarbon`.
4. `src/carbon/controller/dispatch.js` then `controller/return.js` — how Carbon composes a Cast and applies a Return.
5. `src/carbon/app.js` — how everything is wired, then the view you are changing under `ui/`.
6. `tests/dispatch.test.js`, `tests/return.test.js` and `tests/dispatch-browser.mjs` — executable examples of every state transition.

## Known limits and follow-ons

- One Carbon window per workspace; the cache is not multi-tab safe.
- Wizard fields saved on `change` (`#draft-create`, `#draft-criteria`, rename targets) commit on blur; `close()` blurs the focused drawer field before clearing the open record, so Esc keeps a value still being typed (regression scenario in `tests/dispatch-browser.mjs`).
- "Import original Cast…" (recovering a Dispatch on another machine from the Cast file) is not implemented; the dialog says so. Export a fresh Dispatch from the Stack instead.
- Only text Returns are imported; a file-capable destination's attachment must be opened and pasted (or chosen with the dialog's file picker).
- Metadata permission covers existing scalar frontmatter keys only; nested or new keys are rejected.
- The review's J/K shortcuts respond to lowercase `j`/`k` only.
- No provider adapter is included; `cast-kit/src/loop.mjs` is host-side code with no Carbon UI.
- History is bounded (10 snapshots / 64 MiB); restore numbering only knows retained snapshots (see CB-2 note in `docs/carbon-v1.md`).
- Folder saves are non-atomic snapshots; gzip needs native streams.

## Ordinary local copies

`src/carbon/local-files.js` provides the bounded `LocalFolder` document model alongside the unchanged strict `Stack`. The existing `state.stack` slot accepts either immutable model; the name is retained to avoid rewriting the editor/workspace controllers. `kind: "folder"` and its synthetic identity/revision are only IndexedDB/cache metadata, never exported files. `packStack` / `unpackStack` retain the discriminator for recovery and History. Protocol bases still require real Stacks.

The folder pickers read raw inventories before deciding between strict Stack import and explicit ordinary-copy opening. Ordinary open/save, and every `replace()` transition into or out of an ordinary copy (History restore, New Stack), use the existing atomic cache-first `commit` path, so a failed cache write keeps the prior workspace. Dispatch / Return stay Stack-only: committing into a copy closes the Dispatch drawer and any open Return review, and the Dispatch controller refuses record actions while a copy is active. Markdown display/search uses `entryFor`, which ignores foreign IDs and tolerates malformed frontmatter only in ordinary mode; core Entry and Stack validation are unchanged. `readTarFiles` / `writeTarFiles` share bounded portable archive handling with the strict `readTar` / `writeTar` adapters. Conversion to Envoy is a separate validated operation, never a side effect of opening files.

Focused regressions are `tests/local-files.test.js` and `tests/local-files-browser.mjs` (included in the full offline browser suite). Native picker tests use explicit read-only adapters; physical native permissions and Android Chrome acceptance are not claimed. No dependency, license or CSP allowlist additions are needed for this feature.
