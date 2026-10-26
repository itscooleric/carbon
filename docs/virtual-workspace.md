# Virtual workspace: Scratch and independent workspaces (carbon-vfs)

Status: PR-A1 of the [default virtual workspace RFC](https://github.com/itscooleric/envoy/pull/25) (revision 3). This page describes what is implemented now. Editing any bounded text file (A2) is described in [text-files.md](text-files.md); virtual-first linked folders with Refresh-as-observation and single-file Sync (A3) in [linked-folders.md](linked-folders.md).

## What you see

- **Opening Carbon lands in Scratch.** A fresh browser profile opens a workspace called *Scratch* with one empty Markdown note named after today (`YYYY-MM-DD.md`), with the cursor in it. You do not have to create a Stack, import anything, or give folder permission first. Unsaved text is kept as a draft in this browser and survives a reload. **Save note** (Ctrl/Cmd+S) commits it as a new Scratch revision; History keeps the previous one.
- **Every workspace is independent.** Scratch, each local copy (Open files / Import folder as local copy), each linked folder and each Envoy Stack is its own workspace with its own files, drafts, Editor/Viewer tabs, History and Dispatches. Opening another source no longer replaces the current workspace or pushes it into History: the current one, including unsaved drafts, is parked in this browser.
- **Switching.** **Open → Scratch notes** (also the *Back to Scratch notes* link under the workspace title, and the command palette) returns to Scratch. **Open → Workspaces…** lists every stored workspace with its kind, file count, unsaved drafts and size; it can switch, download a parked workspace's committed files as a TAR (files only: not its drafts, History or Dispatches; refused while it has unsaved drafts), or remove one (never the open one, never Scratch). A reload opens the workspace you last switched to. Carbon keeps up to 9 workspaces (Scratch plus 8; RFC D8).
- **Same identity, same workspace.** A Stack whose `id` is already stored opens in that workspace: the preview compares the snapshot with that stored Stack, the snapshot becomes its next revision and the previous one goes to that workspace's History (refused while it has unsaved drafts, or if that workspace changed in another tab after the preview). Picking a folder that is already stored as a linked workspace (same folder by `isSameEntry`) switches to it instead of creating a second copy. Local copies always get a new identity.
- **Dispatch / Return stay Envoy Stack only.** Scratch and local copies do not offer Dispatch or Import Return. A Return is staged, reviewed or accepted only while its own Stack is the open workspace; with Scratch, a copy, a linked folder or another Stack open it is refused and nothing changes.

## Persistence status (footer)

| State | Footer text | Meaning |
| --- | --- | --- |
| saved | Saved in this browser | The open workspace, drafts included, is in `carbon-vfs`. Browser storage is not a backup: export what you want to keep. |
| saving | Saving in this browser… | A write is in progress. |
| quota | Browser storage is full — latest changes are only in this window; export | The write was refused (`QuotaExceededError`). The previously stored copy is intact. **Download recovery copy** saves the open workspace with its unsaved drafts without using browser storage. Carbon retries on your next change. |
| conflict | Changed in another tab — this window is not saving; reload or export | Another tab or window saved this workspace after this window loaded it. Nothing was overwritten. Reload continues with the newer copy (this window's unsaved changes are not kept); export first if you need them. |
| error | Last save to browser storage failed — earlier copy kept; retrying on your next change | An explicit action (Save, switch…) could not be stored; it was not applied. |
| memory | Memory only — browser storage unavailable; export before closing | IndexedDB is unavailable (for example a private window). Workspaces and switching work within this window only. |
| failed | Browser storage unavailable — export before closing | Storage failed during the session; Carbon continues in memory. |

The status element carries the state in `data-state` for tests and assistive tooling.

## Storage layout

New IndexedDB database **`carbon-vfs`**, version 1:

| Store | Key | Value |
| --- | --- | --- |
| `mounts` | workspace id (`local-scratch`, `local-<uuid>`, `stk-…`) | the full workspace record: packed files, History, current Entry, tabs, drafts, Dispatches, legacy dispatch, copy state, link (handle, consent, last save), `kind`, `title`, `rev`, `updatedAt` |
| `meta` | `active` | `{ mountId, at }`: the workspace opened on the next load (absent until the first switch: Scratch) |
| `meta` | `index` | `{ [id]: { kind, title, rev, bytes, files, drafts, unexported, updatedAt, handle? } }` for the switcher, written in the same transaction as the bodies |
| `folders` | auto | remembered linked-folder consent (unchanged shape, see linked-folders.md) |

Rules (`src/carbon/vfs.js`, `src/carbon/mounts.js`):

- **Atomic.** Every change is one `readwrite` transaction over `mounts` + `meta`. A switch parks the open workspace, writes the target when it is new or changed, updates the index and the active pointer together. If any request fails the transaction aborts and every key keeps its previous value; the window state is assigned only after the transaction completed.
- **Revision-checked.** Each record has `rev`. A write states the revision this window last read or wrote (0 for "must not exist"); a mismatch aborts with "changed in another Carbon tab" instead of overwriting. A stored record without a valid `rev` is never overwritten.
- **Failure reporting.** Failures are taken from the transaction's `abort` event, so an asynchronous `QuotaExceededError` is reported as such rather than as an empty error.
- **Damaged records are left alone.** If the workspace to open cannot be validated, Carbon opens Scratch and says so; the damaged record stays untouched and can be removed from Workspaces…. If Scratch itself cannot be validated, the window runs memory-only rather than overwrite it.
- **Bounded.** Each workspace keeps the existing limits (32 MiB of files, History of 10 snapshots / 64 MiB). Workspaces above 16 MiB are marked *large* in the switcher.
- The workspace cap is checked against the index inside the transaction, so two tabs cannot exceed it together. A missing or incomplete index is rebuilt from the stored bodies.
- In a memory-only window, closing also warns while a parked workspace holds unsaved drafts or unexported work.
- `onversionchange` closes the connection and stops saving with a notice, so a future version is never blocked by an open tab.

## Moving from earlier private-beta builds

Carbon is unreleased, and this build deliberately starts a **new** database. It never opens, writes, upgrades or deletes the earlier `envoy-carbon-v1` database, and it does not migrate it. When Carbon detects that the earlier database exists (by name only), the first-start notice says so.

To keep work from an earlier build:

1. Open the earlier `carbon.html` build in the same browser.
2. Export each workspace: **Export → Export TAR / TAR.GZ** (a Stack exports as `*.stack.tar`, a local copy as `*.folder.tar`). For a linked folder of an earlier build, the files on disk are already yours.
3. Open this build and import the files with **Open → Import files / archive**. Each import becomes its own workspace.

You can also simply start with a clean Scratch. The earlier database stays in the browser until you clear the site's data yourself.

## Limitations in this increment

- Any bounded UTF-8 text file opens in the Editor (A2, see [text-files.md](text-files.md)); Envoy Stacks keep Markdown-only Entry editing.
- A linked folder is Carbon's own copy with the folder as its source: Refresh observes, Sync writes one file at a time. Batch Sync, deleting in the folder and remote sources are later work (P2 and #24).
- Cross-workspace search, a full explorer switcher and per-workspace export bundles are later work (P1).
- Two tabs on the same workspace are detected, not merged: the stale tab stops saving and asks you to reload or export.
- Browser storage is per address (`file://` vs `https://…`) and per browser profile, and can be evicted by the browser. Export what you want to keep.
