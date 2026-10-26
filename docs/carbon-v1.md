# Carbon v1 — local notebook and portable Stacks

Carbon is a Markdown-first notebook for notes, revisions, and AI work, distributed as **one file: [`dist/carbon.html`](../dist/carbon.html)**. It runs from `file://` without a server, account, runtime package installation, CDN, or network connection. Its source and pinned development dependencies are in this repository.

Start with the [README quick start](../README.md#get-started), the [format specification](format-v0.2.md), or the [developer guide](developer-guide.md) for implementation details. Carbon names the application; Envoy names its interoperability protocols and compatible AI workers. Existing `envoy.*` identifiers remain unchanged.

## Open Carbon

1. Download `dist/carbon.html` from this repository (GitHub's **Download raw file** action). Save it with the `.html` extension.
2. Open it in a desktop Chromium-based browser. Carbon opens Scratch with a note ready to edit. No installation or terminal command is needed.
3. To work with existing files, choose **Open / Import → Import folder as local copy…**, or **Open files as local copy…** for individual files. A normal folder needs no manifest. Review the inventory, select **Open copy**, then select a Markdown file in the tree.
4. Edit with CodeMirror, switch Editor tabs, or use **View** beside reference files to keep them in independent Viewer tabs. **Save in copy** (Ctrl/Cmd+S) updates Carbon's copy, not the source folder.
5. Use **Download file** for the current Markdown (including its current draft), or save drafts then use **Export files → Export TAR / TAR.GZ** for all files. Verify the download. **Save new folder copy…** writes a new child directory where the browser supports native folder access; it never overwrites the original directory.

**Toolbar.** **Open / Import** also retains **Import files / archive** for adding files to the active workspace or opening an archive, a native folder picker, and explicit **Create Envoy Stack from copy…**. **Export Stack** is labelled **Export files** for ordinary copies. Menus open with Enter or a click, move with arrow keys, and close with Escape or an outside click. The right group holds **Import Return…** and **Dispatch…** (Ctrl/Cmd+Shift+D), which require an Envoy Stack. Below 860 px, **Files** shows or hides the sidebar.

### Ordinary files and folders

- **Import folder as local copy…** (directory upload) reads a **copy** and leaves the source directory untouched. **Open folder (linked)…** opens a **linked folder** in browsers with the directory picker: it reads with read access only into Carbon's own copy, writes nothing on open or on Save, and **Sync file to folder…** writes one file to the original folder after an explicit first-sync confirmation (see [Linked folders](linked-folders.md)). Where the picker is missing it falls back to the copy route after a notice. Folder upload cannot report empty directories; the native reader and TAR archives retain them.
- Filenames, relative paths and original bytes are retained. No manifest, stable IDs, frontmatter or `entries/` reorganization is added by opening or exporting. **Import files / archive** adds loose files at their names in an ordinary copy; its existing Stack behavior still puts Markdown under `entries/` and other files under `assets/`.
- UTF-8 `.md` files up to 1 MiB without NUL bytes open in the Editor. Generic, malformed or unrelated frontmatter does not block editing. Valid metadata titles may be displayed; foreign `id` values are not treated as Envoy identities. Use unambiguous paths/basenames for links. Text that cannot be edited stays in the tree and remains downloadable.
- Viewer supports Markdown, bounded `.txt`, `.log`, CSV and JSON source inspection, validated PNG/JPEG/WebP, and **any text-like file**, decided from bytes (valid UTF-8, a BOM is fine, no NUL in the first 8 KiB) as well as extension: `.py`, `.toml`, `.sh`, `.ts`, `.css`, `.sql` and extension-less files open read-only with a line-number gutter. Known languages are highlighted with the bundled highlight.js (Python, JavaScript, shell, YAML, TypeScript, HTML/XML/SVG, CSS, INI/TOML/cfg/conf, SQL); other text renders unhighlighted. Highlighted markup is sanitized to `span.class` and source is never executed or rendered as HTML. Plain-text/CSV/JSON inspection is limited to 256 KiB; code files show the first 1 MiB with a truncated hint and a Download button (highlighting is skipped above 256 KiB, measured in bytes). Unsupported binary files are downloadable. HTML is inert, remote images are blocked, and existing local path-resolution and image validation rules apply.
- Drafts, independent tabs and local History survive reload when IndexedDB is available. Selection and undo survive switching open Editor tabs within the session; undo/selection after reload remain follow-up work. Ordinary save/open commits leave the prior workspace or draft intact if the cache write fails. Downloads remain the durable fallback.
- Ordinary archives use `.folder.tar` / `.folder.tar.gz`, contain one `documents/` root, and include only your files. Reopen through **Import files / archive**, retaining the `.folder.tar` / `.folder.tar.gz` filename so even unrelated `stack.yaml` files remain ordinary documents. Carbon's portable path/resource rules still apply: up to 2,000 files/directories, 8 MiB per file and 32 MiB total; no traversal, path collisions, symlinks, Windows device names or `.git` components. Carbon refuses incompatible input without silently omitting files. This is not an unrestricted filesystem browser.
- A valid root `stack.yaml` is recognized as a Stack and retains strict import validation. An invalid manifest in a selected folder offers an explicitly labelled ordinary-copy confirmation. `.stack.tar`, `.dispatch.tar`, or unlabelled archives bearing `stack.yaml` / `dispatch.yaml` retain strict Stack validation and cannot silently become replacement ordinary folders.
- **Create Envoy Stack from copy…** validates a new, separate Stack and asks for confirmation. Original files are retained, and a manifest is added only to the new workspace. The new Stack exists only in Carbon until you export it, so it shows **Export needed** and closing the page asks for confirmation. Existing `stack.yaml` names are never overwritten. Incompatible metadata must be corrected deliberately before conversion; it can still be viewed/edited as ordinary Markdown. Dispatch, Return and Stack template commands remain unavailable until conversion or a real Stack is opened.

**Refresh from folder** (the ↻ button in the explorer header, or the command palette) reads a linked folder again and shows what differs (new, changed, conflicting and missing files) without changing Carbon's copy; every adoption is an explicit, recoverable action; see [Refresh from folder](linked-folders.md#refresh-from-folder-observation).

Linked folder syncs with a baseline check, an on-disk backup before each overwrite, read-back verification and permission recovery are described in [Linked folders](linked-folders.md) ; Android Chrome has no directory picker, so it uses the copy route. Physical Android Chrome file-picker, software-keyboard/IME, selection and save/download acceptance remain outstanding. Simulated narrow-screen and native API adapter tests do not establish real-device support.

No other file from this repository is required at runtime. Third-party license notices are embedded in the HTML and also supplied in `dist/THIRD-PARTY-LICENSES.txt`.

The **Theme** menu offers **System**, **Dark**, and **Light**. First use follows the system preference; selecting Dark keeps the Tokyo Night–inspired purple/cyan palette regardless of system changes. Selecting Light uses a coordinated light palette. The preference is saved locally, separately from Stack contents. If browser policy blocks preference storage, the choice still applies to the current window and a message explains that it cannot be retained. Moving the HTML or clearing browser storage can reset the preference.

Both themes cover the editor, preview, dialogs, native form controls, hover and keyboard-focus states. Return diffs use blue additions and orange removals with explicit `+` / `-` markers. Reduced-motion preferences disable motion. At smaller desktop sizes, Split view stacks the editor above the preview; each pane and the sidebar scroll independently. Choose Editor or Preview for more working space.

## Notebook operations

- **+ Entry** offers note, research, requirement, Mission, meeting, and transcript templates. It suggests a name such as `entries/note-20261019-001.md`, using your local calendar date. Changing the template updates an untouched suggestion; a custom path stays intact. The initial Entry title/heading follows the filename. New managed Entries in Stacks receive random stable IDs independently of paths and titles. New Markdown in ordinary copies uses the template body without adding managed frontmatter.
- **+ Folder** suggests `entries/folder-20261019-001` and creates an empty virtual folder. Nested paths in new Entry names also create folders. Entry and folder counters skip occupied names, including case-insensitive file/directory collisions. Invalid or duplicate names keep the dialog open with an explanation; existing files are never overwritten by creation.
- **New Stack** suggests `stack-20261019-a7f2c819`: local date plus eight random hexadecimal characters, checked against the active Stack and retained History titles. You can edit the suggestion before creation. Carbon cannot inspect names in archives you have not opened. A fresh stable UUID identifies the Stack separately from its display title. **Stable ID** in the sidebar reveals that identity; archive filenames use the stable ID and revision.
- **Rename / move** accepts a relative path such as `entries/research/new-name.md`. Entry IDs remain unchanged; the manifest entrypoint follows a move.
- **Delete** explicitly removes the selected Entry after confirmation. History retains a prior snapshot. Deleting the manifest entrypoint also removes that optional manifest field, preserving its surrounding comments.
- Search matches Entry paths and text, including current drafts. Assets appear in the tree and can be downloaded; importing ordinary files adds Markdown under `entries/` and other files under `assets/`.
- `[[Entry-ID]]`, unambiguous `[[basename]]`, and `[[relative/path.md]]` support navigation and backlinks. Stable-ID links survive moves. Carbon does not automatically rewrite ordinary path-based links.
- Fenced code highlighting covers JavaScript, Python, YAML, JSON, and Bash in the preview. The editor uses locally bundled CodeMirror 6.
- Ordinary Markdown beginning with a `---` thematic break and no closing `---` is preserved as plain Markdown. In an Envoy Stack, a closed leading block is treated as YAML and must validate. Ordinary copies preserve unsupported frontmatter as editable text.
- Raw HTML is displayed as text. Validated local PNG/JPEG/WebP images render inline; remote and unsupported images remain labels. External links are inert: the preview contains no external `href`, so clicking, middle-clicking, Ctrl/Cmd-clicking or pressing Enter opens no window and makes no request. Activating one shows a **Link destination** dialog with the address for copying. Links that resolve to an Entry navigate inside Carbon.

## Drafts, revisions, and persistence

An Entry draft is distinct from a saved Stack revision. Exports, replacements, moves, deletions, and Return acceptance are blocked while any Entry draft remains unsaved. Navigate back to each draft and save or discard it. In an Envoy Stack, invalid YAML and attempted managed-ID changes cannot be committed; ordinary copies have no managed-ID requirement.

Every accepted mutation increments `revision` once. Export does not increment it. History preserves up to ten prior full snapshots with a 64 MiB aggregate budget; a single previous snapshot always fits the 32 MiB Stack limit. Restore creates a fresh revision; download older snapshots before they age out. Restore picks a revision above the active Stack, the restored snapshot and every snapshot still retained in History for that Stack ID; revisions already evicted from History (or present only in downloaded archives) are unknown to Carbon, so a restore may reuse a number that an older export carries.

IndexedDB caches the active Stack, Entry drafts, History, the legacy Needlecast dispatch, and every Dispatch record with its Cast, retained base Stack and staged Return. On reload each cached Dispatch record is validated; a damaged one is skipped with a visible notice so the rest of the workspace still recovers. Carbon reports failures and remains usable in memory with explicit archive download. Browser cache can be cleared, denied, isolated per file origin, or lost when the HTML moves. It is not a substitute for user-owned archives. If caching is unavailable, accepting a Return also requests a prior-revision TAR download. Check that this download succeeded. Exports contain the current Stack, not Carbon's browser-only History.

Closing with drafts or an unexported revision requests the browser's unsaved-change warning. Browsers control whether that warning appears. A download request cannot prove the user saved the file. Carbon keeps **Download requested** and the unsaved-export warning until you select **Confirm archive saved** after checking your files. The resulting status explicitly says it was confirmed by you. New edits reset that confirmation. Complete imports and successful folder writes have separate status messages. Saving an Entry commits to the workspace; it does not create a user-owned archive.

Use one Carbon window per active Stack. Browser draft caching is a single-workspace convenience cache; simultaneous tabs can overwrite that cache. No multi-user or multi-tab coordination is implemented.

## Explicit filesystem access

**Open folder (linked)…** (linked folder) uses `showDirectoryPicker` when the browser exposes it and grants permission. **Save folder snapshot…** writes a new child folder in a destination you select, with `stack.yaml` written last. It refuses existing destinations. This avoids destructive in-place synchronization and makes deletions visible in the next complete snapshot.

Native folder saving is not atomic. If interrupted, an incomplete child directory may remain; an absent manifest indicates incompletion. Retain the original and select a fresh destination on retry. Do not use that incomplete directory as a verified Stack.

**Import folder** uses a directory file input and **Export TAR/TAR.GZ** uses downloads. These work independently of direct directory permission. Directory uploads cannot report empty folders; TAR and direct directory handles preserve them. Capability detection is not proof that enterprise policy permits an operation.

## Dispatch an assignment

A Dispatch packages one assignment for an external AI: your objective, the Entries you choose, optional Playbooks, exact file permissions, the Envoy operating contract and an empty Return template. Carbon composes it as an `envoy.cast/v0.1` Cast with Cast Kit and never sends it anywhere: you copy or download it and paste it into the AI yourself.

1. **Assignment.** Choose **↗ Dispatch…**, **↗ Dispatch this** (open Entry as context) or **+ New** under Dispatches. Pick what kind of work: **Ask a question** (answer in the Return, no file changes, Research Playbook), **Update a plan** (replace the plan Entry, Planning Playbook), **Write a report** (new `entries/report.md` plus a replace permission for the open Entry, Research + Report generation Playbooks) or **Custom**. Presets only pre-fill; every choice stays editable. Write the objective; it is the primary instruction and outranks Playbooks. A Mission (an Entry with `kind: mission`) is optional and must be in the context. Completion criteria are optional; Carbon supplies a default.
2. **Context.** Checked sidebar Entries (or the open Entry) are the starting selection. Check or uncheck Entries and optional binary Assets. The Included / Omitted inventory is exactly what the AI will and will not see; omitted files stay in your Stack untouched. An Entry with unsaved edits is flagged: save it or send the saved version; drafts are never sent silently. *Advanced* offers the complete Stack instead; it exports only as the TAR (`.stack.tar` + `dispatch.md`), so the Text and Files targets are disabled while it is selected.
3. **Playbooks.** Optional Markdown method documents, embedded completely and in order (at most eight, 16 KiB each). Add built-ins (Research, Planning, Investigation, Report generation, Critical review, Entity reconciliation), import a Markdown file, or **Use a Stack Entry as Playbook** (recorded as `stack: <path>`). ↑ / ↓ set the processing order, which is the order in the Cast. Playbooks grant no paths, tools or permissions, and later edits do not change an exported Dispatch.
4. **Deliverables.** The answer always comes back in the Return summary. Choose a new Entry path to create (the exact path is shown and checked for collisions) and which context Entries may have their body replaced. *Advanced permissions* allow named existing scalar frontmatter fields (for example `status`) to change on a replaced Entry, deletions and renames; all are off by default. Tools, network and execution are never available: Carbon has no tool runtime and the Cast's `permissions` block is always `network: false, execute: false, write_files: false, transmit_to: []`.
5. **Review & export.** Choose what the destination can actually accept: **Text only** (one `dispatch.md` to paste or attach; cannot carry Assets, so selected Assets block export with a visible reason), **Files / attachments** (`dispatch.md` plus each selected Asset under its own file name, matching the Asset paths the Cast lists; two selected Assets with the same file name must use the TAR instead) or **TAR-capable** (a selected `.dispatch.tar` package or, for the complete-Stack scope, the actual complete `<stack-id>-r<revision>.stack.tar` of the Dispatch base plus `dispatch.md`, which carries the Cast). Inspect the Cast if you like, then tick **I approve sharing this context with an external AI**; the export buttons stay disabled until you do. **Skip to review ⇥** jumps here from the first three steps with the defaults filled in.

Export writes the clipboard or the download first and only then records the Dispatch as **Exported · awaiting Return**, with the original Cast and a copy of the base Stack kept in this browser so the Return can be checked against them. If the clipboard is unavailable the Dispatch stays a draft and Carbon asks you to download instead. **Exported is not delivered**: Carbon cannot see whether the packet reached an AI. From the Dispatch card you can copy or download the same bytes again through the actions its destination supports (a complete-Stack Dispatch only re-downloads its TAR; a Dispatch with Assets is never copied as text), download the original Cast, or **Abandon** it. At most eight Dispatches can await a Return at once.

A selected `.dispatch.tar` is an assignment package, not a Stack: it contains `envoy-dispatch/dispatch.yaml` with `complete_stack: false`, the Cast, contract, bootstrap, original handoff, Return template and the selected Assets renamed `assets/0001.bin`… It has no `stack.yaml`, so importing it as a Stack is refused and your Stack is unchanged.

## Import and review a Return

Choose **⇩ Import Return…** (or **Import Return…** on a Dispatch card or notice), paste the AI's reply or choose a `.md` / `.txt` file, and optionally say which Dispatch it answers (by default Carbon reads `assignment_id` from the packet). Carbon routes by the first line only:

- `# Envoy Cast Return` (`envoy.return/v0.1`) is staged against the original Cast for review.
- `# Envoy Handoff` (legacy `envoy.handoff/v0.2`) opens the existing Needlecast review, unchanged.
- Anything else is refused inline. A Cast Return whose `assignment_id` this browser never exported is refused with **Original Cast not found**; importing a Cast file on another machine is not available in this version.

Nothing is applied on import. The full-width review shows the Dispatch, the AI's self-reported status (labelled *self-reported*), the proposed file list with **NEW / EDIT / DELETE / RENAME** badges and line counts, a unified diff with `+` / `−` gutters and line numbers (long unchanged runs fold), a metadata box for permitted scalar frontmatter changes, and the receipt: summary, blockers, evidence, unresolved questions, operations the AI says it performed, decisions and verification. All imported text is shown as text. **J** / **K** move between files.

Carbon runs seven checks and shows each one:

1. Framing and format `envoy.return/v0.1` (strict: no missing, reordered, truncated or extra frames).
2. Matches the registered Cast (`assignment_id`, `dispatch_id`, `stack_id`, objective).
3. Base revision matches the current Stack byte-for-byte. Fails with *Return claims base X; Cast base is N* or *Stack is now revision M; Cast base is N*.
4. Every change is within the Cast permissions (paths and metadata keys), else *`<path>`: reason*; the file is marked ✕.
5. New Entry IDs are unique across the full Stack, including omitted Entries.
6. Omitted Entries and Assets are untouched.
7. No unsaved editor changes in affected Entries (**Open unsaved Entry** takes you there).

Checks confirm scope and integrity; they do not confirm the content is correct. Acceptance is all-or-nothing: **Accept N changes…** is enabled only when every check passes, and the confirmation names the revision it creates. Carbon re-checks the Stack, applies every change as **one** new revision, keeps the previous revision in History as *Before accepting Return N* and saves the receipt with the Dispatch. A Return reported *blocked* or *partial* can still be accepted when its checks pass; the self-reported status is information, not a check.

Other decisions:

- **Save receipt** (zero-operation Returns, such as an answered question): records a checkpoint; the Stack is unchanged. It is available only when every check passes, because a checkpoint becomes part of the Dispatch record and releases its retained base; reject a failing Return or re-dispatch instead. **Save answer as Entry…** (same condition) saves the receipt, then creates a note Entry from the summary and evidence as your own edit.
- **Reject…** keeps the Stack unchanged and the Return in the Dispatch's history; you can import another Return for the same Dispatch.
- **Keep pending & close** leaves the Return staged. It survives a reload and reopens from its card with the same checks.
- **Stale base:** if the Stack changed after export (for example you saved an Entry), the base check fails, Accept stays disabled and **↗ Re-dispatch from revision N** copies the assignment into a new draft at the current revision.
- **Continue:** after acceptance, **New Dispatch from rev N** starts a draft whose context is the prior context plus the files the Return created.

"Revision N saved in this browser" means the accepted revision is in the local draft cache only. It is not an exported archive until you choose **Export TAR.GZ** and confirm the file reached your downloads. If saving to the cache fails during acceptance, the notice says **Not saved**, the Stack is unchanged and the Return is still staged; **Retry** tries again and **Download proposed archive** downloads the Stack that accepting would produce. When no draft cache is available at all, Carbon first requests a `-before-return-` TAR of the current revision, then accepts in memory.

## Legacy manual Needlecast

The original v0.2 route is unchanged and lives under **Export Stack ▾ → Legacy Needlecast (envoy.handoff/v0.2)**. Prefer **Dispatch** for new work: it can create Entries, carries Playbooks and permissions, and tracks several assignments.

1. Save all Entry drafts. Select Entry checkboxes, or leave all unchecked to include every Markdown Entry.
2. Choose **Export Stack ▾ → Needlecast export**. Review the included and omitted inventory, then download the `.handoff.md`. Carbon retains the exact base Stack and selected scope locally.
3. Attach that file to an external AI chat yourself. Use `prompts/bootstrap.md`; ask the model to change only the selected Entry bodies, retain all frames, and preserve the Entry frontmatter, packet metadata and manifest byte-for-byte. Carbon rejects changes to any frontmatter field, comment, or formatting, and rejects adding or removing frontmatter in Returns. Edit metadata directly in the notebook when needed.
4. Import the resulting `.handoff.md` using **Open / Import ▾ → Import files / archive**, or paste it into **⇩ Import Return…**. Carbon checks Stack ID, base revision, dispatch identity, exact local base state, selected paths, frame completeness, and stable Entry IDs.
5. Inspect the `-` removed / `+` added diff. Separate changes appear as distinct hunks with context and labeled unchanged gaps. If a change exceeds the bounded diff budget, Carbon explicitly shows the complete original and proposed text instead. **Cancel** rejects the proposal. **Accept changes** preserves the prior revision and commits all validated changes as one revision.
6. Export a fresh complete Stack archive. Omitted Assets and Entries remain byte-identical.

An edited packet cannot introduce new files, delete files, move Entries, modify the manifest, or broaden its scope in v1. Use notebook controls, or a Dispatch with explicit permissions, for these actions. Any local Stack mutation invalidates the pending legacy dispatch; export a fresh one. Only one legacy dispatch is retained (Dispatch records are independent of it).

To move a dispatch between computers, first import the matching complete Stack, then select **Register original handoff** with the unedited original packet. Registration requires exact included text and a complete matching inventory. Import the proposed Return afterward. A partial handoff alone cannot reconstruct omitted Assets, so Carbon refuses to use it as a replacement workspace.

The framing extension is documented in `docs/format-v0.2.md`. Legacy illustrative handoffs must be regenerated. The updated example in this branch is machine-readable.

## Resource and security limits

| Resource | Carbon v1 limit |
| --- | --- |
| Files plus explicit/implied directories | 2,000 |
| Per file | 8 MiB |
| Markdown Entry | 1 MiB |
| Stack file bytes | 32 MiB |
| TAR or compressed input/output buffer | 40 MiB |
| YAML mapping or PAX extension | 64 KiB |
| Handoff packet | 4 MiB |
| Path depth / UTF-8 path bytes | 32 / 1,024 (255 per component) |
| YAML depth / nodes | 32 / 10,000 |
| Decompressed gzip bytes | At most max(1 MiB, compressed bytes × 200), also bounded by 40 MiB |

TAR import stages all bytes and validates before opening anything. It rejects unsafe paths, links/devices/sparse files, unsupported types, collisions, invalid checksums, malformed PAX, truncated archives and trailing nonzero data. Native gzip streaming enforces output/ratio limits while collecting chunks and checks gzip integrity. Very compressible legitimate files can exceed the ratio policy; export uncompressed TAR in that case.

Exported archives use the root `<stack-id>.stack/`, or `envoy-<stack-id>.stack/` when the Stack ID is a Windows reserved device name such as `con` or `com1`; import strips the root, so the Stack ID is unaffected.

Imports are bounded and processed in memory on the UI thread. This is a notebook-scale implementation, not a streaming media archiver. Existing checksum files are preserved as ordinary Assets and are not verified or regenerated; remove or regenerate such external inventories with their authoring tool after edits.

## Build and test

Development only: Node.js 22+ and npm. Python 3 and GNU tar are used by independent interoperability tests. Playwright needs a locally installed browser for browser tests.

```sh
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

To test with an existing Chromium executable:

```sh
CARBON_BROWSER_PATH=/absolute/path/to/chromium npm run test:browser
```

The build bundles source, CSS, templates and licenses, generates a SHA-256 Content Security Policy for its single script, and writes `dist/carbon.html`. There are no runtime module imports. Repeated builds with the lockfile and unchanged inputs must produce identical bytes.

The Carbon CI workflow checks unit tests, a reproducible build, bundled licenses, and Chromium browser scenarios. This does not establish physical mobile-device or all-browser compatibility. Module ownership and trust boundaries are described in the [developer guide](developer-guide.md).

## Dependencies and deferred work

| Dependency | Pinned version | Purpose / license |
| --- | --- | --- |
| yaml | 2.9.1 | YAML 1.2 AST and source ranges / ISC |
| marked | 18.1.1 | Markdown parsing / MIT |
| DOMPurify | 3.4.17 | Preview sanitization / Apache-2.0 or MPL-2.0 |
| highlight.js | 11.12.0 | Five bundled code grammars / BSD-3-Clause |
| esbuild | 0.28.2 | Development-only single-file build / MIT |
| Playwright | 1.64.1 | Development-only browser acceptance / Apache-2.0 |

Documentation dates for these package versions are not stated in their package metadata. Exact installed versions are locked in `package-lock.json`.
