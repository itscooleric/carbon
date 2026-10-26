# Linked folders

Implementation: `src/carbon/source.js` (source records and the per-path state table, DOM-free), `src/carbon/linked.js` (Refresh, Take folder version, Sync pipeline, status), `src/carbon/ui/source.js` (dialogs and explorer sections).

A **linked folder** is a folder opened with the native directory picker (**Open / Import → Open folder (linked)…**, Chromium desktop). Carbon reads it once into **its own copy** in the browser's `carbon-vfs` store and keeps the folder as the copy's **source** and optional **sync target**:

- **Carbon's copy is the working copy.** Save (Ctrl/Cmd+S), New file, New folder, Rename, Delete, Insert image, templates and History restore change Carbon's copy in this browser and **never touch the folder**. They work with the folder disconnected, permission refused, or the folder gone. A file may stay only in Carbon forever.
- **The folder is read only by Refresh from folder.** Refresh is an observation: it records what the folder holds and shows what differs, and never adds, removes or replaces a file in Carbon's copy. Reconnect never refreshes by itself.
- **The folder is written only by Sync file to folder….** One file at a time, from the Document menu or the palette, never bound to Ctrl/Cmd+S: consent, write permission, a check that the folder still holds what Carbon last read, a backup into `.carbon-history/`, the write, and a read-back verification. Nothing is ever deleted in the folder.
- **Every change to Carbon's copy made from the folder is explicit, previewed and recoverable:** Take folder version, Import, Accept move, Keep both and Restore push the previous revision to History first.

## Two workspace modes

| | **Linked folder** | **Independent copy** |
| --- | --- | --- |
| How it opens | **Open folder (linked)…** (`#open-folder`) in a browser with `showDirectoryPicker` | **Import folder as local copy…**, **Open files as local copy…**, archives, and `#open-folder` where there is no directory picker |
| Dialog | "Open linked folder?" | "Open local folder copy?" |
| On open | Files are read into Carbon's copy; **nothing is written**; read access only; every file becomes the *baseline* (what the folder held) and the read is the first observation | Files are read from the upload; the source is never reachable |
| Save (button or Ctrl/Cmd+S) | **Save in Carbon**: Carbon's copy only | **Save in copy**: Carbon's copy only |
| Folder read again | **Refresh from folder** (↻ in the explorer header, palette, or the action after Reconnect) | never |
| Folder written | **Sync file to folder…** (Document menu, palette), one file, after consent | never |
| `state.link` | `{ handle, consent, status, op, lastSync, lastError, historyOk, baseline, observed }` | `null` (also `null` for Envoy Stacks) |
| Becomes an Envoy Stack | Only through the explicit **Create Envoy Stack from copy…** action (a separate workspace; the link is not carried) | Same |
| Dispatch / Return | Unavailable until converted | Unavailable until converted |

Opening never converts anything: a linked workspace is an ordinary folder (`LocalFolder`) with no synthesized manifest. A native-picker folder that contains a **valid** `stack.yaml` still opens as an Envoy Stack copy (strict validation, no link). Picking a folder that is already stored as a linked workspace (`isSameEntry`) switches to that workspace rather than opening a second copy.

A root-level directory named `.carbon-history` is skipped when a folder is read or refreshed, so Carbon's own history never appears in the tree, in observations, in search or in exports. The match is the exact, case-sensitive name; look-alikes such as `.carbon-history-notes.md` and nested directories of that name are ordinary content.

**What opening refuses.** The whole folder is read into memory under Carbon's existing limits: "Folder count limit exceeded" above 2,000 entries, "Folder size limit exceeded" for a file over 8 MiB or more than 32 MiB in total. A `.git` directory is refused by path validation ("Unsafe path"). Open a narrower subfolder instead.

## Source records (`source.js`)

Beside the handle and consent, `state.link` carries two records; both are persisted in the workspace's `carbon-vfs` body (`packLink` / `validLink`) and validated on restore (a damaged member is dropped, never the workspace):

- **`baseline`**: `Map<path, {shadow?}>`. A key exists iff the path was imported from or synced to the folder (and not forgotten since). `baselineBytes(p)` is what the folder held then: the virtual bytes while Carbon's copy still matches, otherwise the **shadow** that `trackBaseline` stores at the first virtual divergence (the hook in `deps.commit`, `app.js`). An edit back to exactly the baseline bytes drops the shadow. A key with a shadow and no virtual file is *deleted in Carbon*. Shadows are never replaced by a virtual change; only Take folder version, Keep mine, Import, Accept move and Sync re-baseline a path.
- **`observed`**: the last Refresh: `{ at, directories, entries: Map<path, {size, modified, same, captured, bytes?}> }`. `same` says whether the disk bytes equal the baseline; `bytes` holds the disk version only where it differs, captured while shadows plus captures stay within 8 MiB per workspace (`CAPTURE_LIMIT`, rev 2 D8); beyond that an entry is recorded with `captured: false` (size and time only) and Compare is unavailable until the next Refresh fits. Replaced wholesale by each Refresh; never consulted to change `files`. Captured bytes and shadows count towards the workspace size in Workspaces….

The **state of a path** is a pure function of `files`, `baseline` and `observed` (`sourceState`; every row is a unit case in `tests/source.test.js`). It is shown as text and a glyph, never colour alone: in the explorer tag, in `#save-state` (click it for the file's actions), in the editor status word and in the Folder changes dialog.

| `files` | `baseline` | `observed` (last Refresh) | State | Shown as | Actions |
| --- | --- | --- | --- | --- | --- |
| present | absent | absent | `virtual` | ◌ Only in Carbon | Sync file to folder… (disk must be absent) |
| present | absent | present, same bytes | `matched` | ✓ Same as folder, not recorded as synced | Sync (records, writes nothing) |
| present | absent | present, other bytes | `conflict` | ⚠ Changed in folder and in Carbon (a collision) | Compare, Open folder's version, Keep mine, Keep both, Take folder version… |
| = baseline | present | same | `synced` | ✓ Same as folder | — |
| ≠ baseline (shadow) | present | same | `modified` | ● Edited in Carbon, not synced | Sync file to folder… |
| = baseline | present | differs | `externalChange` | ⇣ Changed in folder | Compare, Open folder's version, Take folder version… |
| ≠ baseline | present | differs, = Carbon's bytes | `matched` | ✓ Same as folder, not recorded as synced | Sync (records, writes nothing) |
| ≠ baseline | present | differs | `conflict` | ⚠ Changed in folder and in Carbon | Compare, Open folder's version, Keep mine, Keep both, Take folder version… |
| present | present | absent | `missing` | ∅ Missing from folder (`moved in folder to <path>` when an incoming file holds exactly the baseline bytes) | Accept move, Sync file to folder… (Recreate) |
| absent | shadow | any | `deletedInCarbon` | ⌫ Deleted in Carbon (explorer section) | Restore in Carbon, Forget |
| absent | absent | present | `incoming` | + New in folder (explorer section) | Open folder's version, Import, Import all |

Without any observation (the record was damaged) only `virtual`, `synced`, `modified` and `deletedInCarbon` can occur and no folder-derived action is offered; a lost baseline reads as `virtual`, which is non-destructive because Sync then requires the disk to be absent.

## Refresh from folder (observation)

`refreshFolder` needs read access only (permission problems are reported with **Reconnect folder…** and change nothing). It reads the folder (`readDirectoryFiles`, `.carbon-history` skipped), builds `observed` against the baseline, checks that the workspace did not change while the folder was being read, and commits `{ link }`: not a byte, draft, tab, revision or History entry of Carbon's copy changes (`tests/linked.test.js` asserts byte equality of every file and draft before and after; the browser suite asserts the tree, revision and draft). The notice counts new, changed, conflicting and missing files and differing folders, says "Nothing in Carbon was changed", and offers **Folder changes…**. The explorer shows **New in folder (N)** with Import / Import all and **Deleted in Carbon (N)** with Restore / Forget; each tree row carries its state tag. A Refresh clears a previous sync refusal or failure status for the files it re-read.

## Acting on the folder's version

All of these run inside one `deps.commit` with the previous revision pushed to History first, and refuse when the folder was refreshed meanwhile ("look at the changes again"):

- **Compare** (`diffTable`) and **Open folder's version** (inert text / asset preview with Download) are read-only dialogs over the captured bytes; nothing changes by looking.
- **Take folder version…** (`takeDiskVersion`, confirmed; a changed revision marks the workspace export-pending like any other revision): the folder is read again and must still hold exactly the bytes the decision was made on, otherwise "Refresh from folder and look again"; a Save, Sync or Refresh in this window during that read refuses it too. When the last Refresh did not capture the folder's version (over the capture budget), size and modified time are never accepted as its identity (same-length edits can keep or restore the time): the dialog reads the current version first and shows its size and SHA-256, and the Take is bound to exactly those bytes (`readFolderVersion`, then `takeDiskVersion(path, {expected})`); without a confirmed preview it fails closed. The adopted bytes become the baseline. An unsaved draft is kept (unless it equals the adopted bytes), and bytes the Editor cannot open (NUL, invalid UTF-8, over 1 MiB) are never adopted while a draft exists, so the draft keeps its tab. History: "Before taking <path> from the folder".
- **Keep mine**: Carbon's bytes stay; the folder's observed version becomes the baseline (`modified` from then on). A later change in the folder makes Sync refuse again: an acknowledged version never authorizes overwriting a newer one.
- **Keep both**: the folder's version is saved as `<name>.folder.<ext>` beside Carbon's (`virtual`), then Keep mine applies.
- **Import / Import all**: incoming files become virtual files with a fresh baseline; parent folders are created; a name that collides case-insensitively, or a file where Carbon has a folder of that name, is refused with both names ("rename one of them first").
- **Accept move** (D25): offered only when an incoming file holds exactly the missing path's baseline bytes; renames Carbon's file (tabs and editor session follow) and moves the baseline key, keeping a virtual edit under the new name. Refused while the file has a draft (as Rename), so a draft is never left behind at the old path.
- **Restore in Carbon** (deleted in Carbon): the shadow comes back as a virtual file at its baseline. **Forget** drops the shadow from the list. When no History snapshot holds exactly that version (after Keep mine it is the folder's version, which Carbon never held), Forget asks for confirmation that it discards Carbon's only copy. A shadow can be the only copy of that version: after Keep mine it is the folder's version, History may never have held it, the folder may since have lost it, and exports (`.folder.tar`) do not include shadows. Use **Restore in Carbon** (or download it from Folder changes…) before exporting and clearing browser storage if you may need it. If the folder still held that version at the last Refresh, the path then reads *New in folder* with the shadow as its observed bytes, so Import works without another Refresh. Sync never deletes in the folder (D26).

## Sync file to folder… (`syncFile`)

The only path that writes the folder (D17). Nothing is written before step 5. Any refusal or failure leaves Carbon's copy and its state untouched.

0. **Preconditions.** A connected link; a committed file outside `.carbon-history/` (reserved for local file history in the folder; refused before consent or any folder access); **no draft for that file** ("Save or discard the draft first: Sync writes the saved copy, never a draft"), so what reached the disk is always a revision Carbon holds. Every Sync, and every action that adds or re-sizes a baseline entry (Import, Take folder version, Keep mine / Keep both), must keep the folder, as Carbon knows it, within the folder limits: 2,000 entries counting files and directories as the folder reader does, and 32 MiB. "As Carbon knows it" is every baseline path (files deleted only in Carbon included), every file and directory the last Refresh saw, and the parents a Sync would create, each path at the larger of its observed and baseline size (`knownFolder`); otherwise nothing is written and Forget / export is suggested, so the kept folder versions stay bounded and the folder stays readable by Carbon.
1. **First-sync consent** ("Sync to the original folder?"): Carbon will modify the original files in the folder *and create the files you sync there*; local history on disk (`.carbon-history/`, default on); **Remember for this folder**. Cancel modifies nothing and asks the browser for nothing. Consent is recorded cache-first; remembered consent lives in the `folders` store (matched with `isSameEntry`) and never implies permission.
2. **Permission.** `queryPermission({mode: "readwrite"})` every time; `prompt` becomes `requestPermission` on the user's click. Denied: status `permission`, "nothing was written. Your copy is kept in Carbon.", **Reconnect folder…** offered; editing continues meanwhile.
3. **Stale-decision checks.** `deps.checkRevision` confirms this window still holds the stored revision of the workspace (another tab's newer copy is refused *before* the disk is touched; the check reads the switcher index, never the body, so a stale window cannot adopt the newer revision and overwrite it later). Then the file is read: it must equal the **baseline bytes**, or be absent for a `virtual` path. Otherwise nothing is written and the notice offers **Refresh from folder**: a file that already exists but was never imported ("Refresh, then Import it or keep both"), a file that changed in the folder ("Refresh to compare and choose"), or a baseline file that is gone ("Recreate in folder" is offered explicitly). For a file the folder does not hold yet, every path component is also checked against the folder's actual entries: a name that differs only by case (possible on a case-sensitive filesystem, which Carbon's own path rule would refuse on the next open) refuses the sync. This walk is repeated with the final re-read after the last revision probe. A disk file over 8 MiB is refused without being read.
4. **Backup.** When the folder holds a different version and history is on, the current disk bytes are preserved through `deps.diskHistory(handle).preserve(path, bytes, {modified})` first; any failure stops the sync ("The original file is unchanged") and offers one confirmed **Sync without history…**. The file is **read again immediately before the write**; a change meanwhile is refused. `deps.checkRevision` runs again after the backup and before that final re-read, so the re-read is the last await before the write; the step-6 commit is the final store check, since the folder write cannot join a store transaction. Residual risk: the folder can still change between that last read and the write's commit. Carbon stages the new bytes, reads the target once more before `close()` and aborts if it changed, but a write by another program during `close()` itself is overwritten, and the backup holds the version Carbon checked, not that newer one. The same applies to the cleanup after a failed write of a new file: the empty file Carbon created is removed only if still empty when checked, and a write by another program between that check and the removal is lost. Avoid syncing a file another program is saving at the same moment.
5. **Write and verify.** `createWritable`, write, close (abort on error; the file is re-read to say whether the original is unchanged). The file is read back and compared; a mismatch is "Sync could not be verified", not a sync.
6. **Record.** `baseline[p] := bytes` (shadow dropped), `observed[p]` marked same, `lastSync`, one `deps.commit({ link })`. The virtual bytes do not change and no revision is made. Carbon's copy is read again at this point: if this window saved, deleted or moved the file while the Sync awaited the folder (a permission prompt or a backup), the written bytes are kept as the shadow, so the newer version reads *Edited in Carbon, not synced* (or *Deleted in Carbon*) rather than synced, and the notice says so. If the store refuses that commit after the verified write, this window adopts the baseline in memory (otherwise it would report a false difference) and the notice says **both** things: "Synced … (written and read back)." and "Browser storage did not record the sync: <storage full / changed in another tab>", with **Download recovery copy** (and **Reload** for a conflict). After a reload the stored record still has the old baseline and observation: the file reads `modified` ("Edited in Carbon, not synced") until the next Refresh shows `matched` ("same as folder, not recorded as synced"); in both states a Sync re-reads the folder, finds these exact bytes, and records them without writing. Storage is never disabled for a quota or conflict.

Identical bytes already on disk (`matched`) are recorded as synced with no write and no backup.

## Failure policy

| Situation | Result |
| --- | --- |
| Save, New, Rename, Delete, image, template, History restore | Carbon's copy only; zero folder access (`tests/linked.test.js` counts every `getFileHandle`/`getDirectoryHandle` with `create` and every `createWritable`) |
| Refresh with access denied or the folder unreachable | refused with Reconnect; nothing observed or changed |
| Refresh while the workspace changed | refused ("refresh again"); nothing changed |
| Refresh, store write fails | the previous observation stays |
| Take folder version after the folder changed again | refused; Refresh and look again |
| Take folder version of unreadable bytes with a draft | refused; draft and tab kept |
| Sync with a draft | refused before any permission check |
| Sync consent cancelled | nothing modified, no permission prompt |
| Sync permission denied or folder unreachable | nothing written; Reconnect offered; editing continues |
| Sync of a path inside `.carbon-history/` | refused before consent or folder access |
| Sync of a new file whose name (or a parent's) differs from a folder entry only by case | refused; nothing written |
| Sync of a new file past the folder limits as Carbon knows it | refused; Forget / export suggested |
| Sync: another tab stored a newer revision | refused before the folder is read, and again right before the write |
| Sync: this window saved, deleted or moved the file meanwhile | the written bytes become the baseline shadow; the newer version stays *not synced* |
| Sync: disk ≠ baseline / exists for a virtual path / baseline file missing | nothing written; Refresh (or Recreate) offered; `#save-state` reads "Sync refused" until the next Refresh or Sync |
| Backup cannot be written | sync stopped, original unchanged; one confirmed Sync without history |
| File changed during the backup | refused; nothing written |
| Write or close error | writable aborted; the notice says whether the original is unchanged; for a file that did not exist before, the empty file the attempt created is removed if it is still empty when checked, so a retry is not refused (an empty file another program created there meanwhile is removed too; a write landing between that check and the removal is lost, the same unclosable window as `close()`) |
| Read-back mismatch | "Sync could not be verified"; baseline unchanged, so the next Refresh shows the conflict |
| Store fails after the verified write | two-part notice; baseline adopted in memory; recovery copy; after a reload `modified` (then `matched` after Refresh), and a Sync records it without writing |
| Another program writes the file after Sync's last read | the target is read once more after the data is staged and before `close()`; a change aborts the writable ("changed outside Carbon while it was being written", nothing committed). A write landing during `close()` itself is overwritten without a backup: the File System Access API has no compare-and-swap, so this window is narrowed, not closed |

## Status

`linkedStatus(state, path)` returns `{ kind, label, glyph, tooltip }`: `imported` for a local copy, `permission` (Reconnect needed / Folder unavailable), `saving` (Syncing…), `conflict` (Sync refused), `syncFailed`, the workspace summary (`linked`: "N files not synced … folder read HH:MM") for `path == null`, or the file's source state. `renderLinkedStatus` fills `#link-status` (connection), `#save-state` (the open file's state; a button that opens the per-file dialog), `#stack-id` / `#stack-status` (how many files are not synced, how many folder changes to look at, when the folder was last read), relabels Save as **Save in Carbon**, and shows `#refresh-folder`, `#sync-file`, `#source-changes`, `#reconnect-folder` and `#forget-folder` for a linked workspace. Nothing is disabled: every editing action is virtual.

## Reload and recovery

The directory handle, consent, last sync, baseline and observation are stored in the linked folder's own workspace record; Chromium stores `FileSystemDirectoryHandle` objects in IndexedDB. After a reload the link is restored with status `permission` and then verified with `queryPermission({mode: "read"})`; **Reconnect folder…** requests access on a click and reads nothing. Unknown or malformed cached link shapes are discarded (`link: null`), damaged source records degrade as described above, and a link on a Stack is never honoured. Your files stay editable throughout.

Exports (`.folder.tar`) carry Carbon's files only: not the baseline, shadows or observation; a reimport is an independent copy with a new identity. Deleted-in-Carbon shadows are not exported, and neither History nor the folder is guaranteed to hold them (after Keep mine the shadow is the folder's version, which History never held, and the folder may since have lost it): **Restore in Carbon** before exporting if you may need one.

## Disk history

`deps.diskHistory(handle, options)` resolves a `DiskHistory` from `src/carbon/history/disk.js`. Sync uses the default (`create: true`), which creates `.carbon-history/` on the first backup. Carbon writes only into a history directory it created: an existing `.carbon-history/` without `carbon-history.json` is initialised only when it is empty or holds nothing but Carbon's own README (an interrupted initialisation), and a root entry whose name differs only by case (`.CARBON-HISTORY`, possibly the same directory on a case-insensitive filesystem) is refused. Either refusal stops the Sync before any write ("The original file is unchanged"); its contents are untouched. **Local file history…** and **Export local history…** pass `{ create: false }` and need no consent. **Restore** from local history puts the chosen version into Carbon's copy as a new revision (History: "Before restoring <path> from local history") and refuses while the file has a draft (`restoreSnapshot`); a snapshot that is not text (for example an unreadable `.md` backed up after Keep mine) is restored read-only, like a folder open. The folder is written only by a later Sync, which then backs up the current disk version as usual (D21).

## Browser support

- **Chromium desktop** (Chrome, Edge, Brave and similar): `showDirectoryPicker`, `createWritable` and IndexedDB-storable handles are available. Enterprise policy can still block them.
- **Firefox and Safari** do not offer the directory picker; **Android Chrome** does not offer `showDirectoryPicker` either. **Open folder (linked)…** then says so and falls back to the directory-upload route, so the result is an independent copy.
- Physical Android Chrome acceptance for the copy route remains outstanding; linked mode is not available there. Tests use an in-memory fake of the directory handle API (`tests/linked-fake-fs.js`); they do not establish real File System Access behaviour.

## Tests

`tests/source.test.js` (state table, `trackBaseline`, observation and capture budget, every explicit action, persistence and damaged records), `tests/linked.test.js` (zero-write Save and structure, the Sync pipeline and its failures, Refresh as observation, Take folder version, status, consent memory), `tests/linked-history.test.js` (real `history/disk.js` under Sync and the virtual Restore), `tests/text-files.test.js` (conventions through Save and Sync) and `tests/linked-browser.mjs` (`linkedFlows`, run by `npm run test:browser`: the #31 exit condition on an empty folder, Refresh as observation with every state, Compare / Keep mine / Take / Accept move / Recreate / delete + Restore, consent, permission, backup failure, storage failure after a verified write, a stale window, remembered consent).
