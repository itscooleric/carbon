# Local file history (`carbon-history/1`)

When Carbon is linked to a folder on disk and the user explicitly syncs a file to it (**Sync file to folder…**, never Ctrl/Cmd+S, see [linked-folders.md](linked-folders.md)), the previous on-disk version is first copied into `.carbon-history/` inside that folder. This document is the format and behaviour contract. Carbon never writes into a `.carbon-history/` it did not create: without `carbon-history.json` the directory is initialised only when empty (or holding only Carbon's own README from an interrupted initialisation), and a root entry named like it apart from case is refused. Implementation: `src/carbon/history/disk.js`; dialog: `src/carbon/ui/disk-history.js`.

The format needs no IndexedDB, no Carbon and no index: it is plain files that a person can browse and copy back by hand. It contains only copies of the user's own files, plus the manifest and README below.

## Layout

```
<linked folder>/
  notes/plan.md                       <- the user's real file
  .carbon-history/
    README.txt                        <- plain-language explanation and hand-restore steps
    carbon-history.json               <- versioned manifest
    versions/
      notes/
        plan.20260315T142530123Z.a1b2c3.m20260315T142525123Z.md
        plan.20260316T091500007Z.9f8e7d.md
```

### Manifest `carbon-history.json`

```json
{
  "format": "carbon-history/1",
  "created": "2026-03-15T14:25:30.123Z",
  "retention": { "days": 30, "maxBytes": 104857600 }
}
```

`format` must equal `carbon-history/1`; any other value makes `openDiskHistory` throw rather than guess. `retention` records the settings at creation for humans; the values actually applied are the options passed to `openDiskHistory` (`null` means unlimited). Unknown extra keys are preserved by readers (Carbon never rewrites an existing manifest).

### Snapshot names

A snapshot is a complete copy of the file, stored at

```
.carbon-history/versions/<original dir>/<base>.<savedAt>.<hash>[.m<modified>][<ext>]
```

- `<base>` and `<ext>` split the original file name at its last dot, unless that dot is the first character (`.env` has no extension; `app.tar.gz` has base `app.tar`, ext `.gz`; `Makefile` has none).
- `<savedAt>`: UTC time the snapshot was saved, `YYYYMMDDTHHMMSSmmmZ` (millisecond precision, fixed width, so names sort chronologically). Strictly increasing per linked-folder handle within a page session (a clock rollback or two saves in the same millisecond still yield increasing times, even though each save opens a fresh instance), and bumped by 1 ms if the name already exists, so two backups never collide.
- `<hash>`: first 6 hex digits of the SHA-256 of the file content. `read()` verifies it, so a corrupted or truncated snapshot is reported instead of restored.
- `.m<modified>` (optional): the source file's last-modified time in the same format, when the caller supplied it.

Full regular expression for the file name:
`^(.+)\.(\d{8}T\d{9}Z)\.([0-9a-f]{6})(?:\.m(\d{8}T\d{9}Z))?(\.[^.]+)?$` (the original name is group 1 + group 5).

Directory structure under `versions/` mirrors the original relative path. Original paths pass the same `path()` validation as every Carbon path (no traversal, no absolute paths, NFC, depth <= 32 and 255 bytes per component including the added suffix of about 30 bytes). Paths beginning with `.carbon-history` are rejected, as are names that already end in a `.m<timestamp>` extension. Snapshots larger than 8 MiB (`LIMITS.file`) are rejected.

There are no deltas and no index. The directory is the source of truth, so `list()` walks it: an interrupted write can never hide a valid snapshot. A zero-byte file whose name does not carry the empty-content hash (`e3b0c4`) is an interrupted write; `list()` hides it and `prune()` deletes it.

## Read-only access

`openDiskHistory(handle, { create: false })` never writes. When `.carbon-history/` does not exist it returns an empty history (`list()` is `[]`, `exportArchive()` throws "No local history yet") and creates nothing, not even the README or manifest; when it exists, listing, reading and exporting work with read-only permission. The Local file history dialog and Export local history use this mode and need no write consent (existing backups stay reachable after reopening a folder, after Forget, or with future backups off); only `preserve()` (a consented save) uses the default `create: true`.

## Retention

Defaults: **30 days** and **100 MB per folder** (`openDiskHistory(handle, { retentionDays, maxBytes })`; `Infinity` disables a limit). `prune()` runs best-effort after every `preserve()` and removes (1) snapshots older than the retention period by `savedAt`, then (2) the oldest snapshots first until the total is within `maxBytes`. The newest snapshot of every path is never deleted, and neither is the snapshot a `preserve()` has just verified. "Newest" means newest *verified*: `prune()` re-reads the newest candidate of each path and checks its content against the hash in its name; a mismatch (for example a truncated leftover whose cleanup failed) is treated as corrupt and deleted like an empty leftover, and protection passes to the next newest snapshot, so the total may exceed `maxBytes` when the newest versions alone are larger. Files in `versions/` that do not match the snapshot name pattern are never touched. Emptied directories are removed.

## Failure policy

**If the backup cannot be created, the sync is stopped.** `preserve()` resolves only after the snapshot has been written, closed, re-read and compared byte for byte (size and content). Any error (permission, quota, I/O, short write, verification mismatch) rejects with `Local history backup failed: ...`, and the caller (the linked-folder sync pipeline) must not overwrite the original. On failure the partial file is removed; if removal also fails, an empty or truncated file may remain, which `list()` hides when empty and `read()` rejects when its hash does not match. Pruning failures never fail a preserve whose snapshot is already verified.

## What is and is not transactional

Browser filesystem APIs offer no multi-file transaction. In Chromium, `createWritable()` writes to a hidden swap file and replaces the target when `close()` resolves, so a single file is replaced atomically on close, but `getFileHandle(name, { create: true })` creates an empty file immediately. Neither `move()` nor rename is universally available, so Carbon writes snapshots under their final name rather than via a temporary name. The ordering guarantees are:

1. Snapshot is written and verified.
2. Only then may the original be overwritten.

A crash, power loss or tab close between steps 1 and 2 leaves an extra snapshot identical to the unchanged original: never a lost original. A crash during step 1 leaves at most an empty or truncated snapshot with the unmodified original intact. A crash during step 2 is governed by the platform's swap-on-close behaviour; the verified snapshot of the previous content already exists.

## Recovering by hand

1. Open `.carbon-history/versions/` in your file manager and navigate to the file's folder.
2. Pick the version by the `savedAt` timestamp in its name (newest has the largest number).
3. Copy it next to the original and rename it to the original name (delete the `.<timestamp>.<hash>` part and any `.m<timestamp>`). Copy rather than move to keep the history.

Carbon's "Local file history (on disk)" dialog does the same: Download saves the snapshot as a normal file; Restore puts the snapshot into Carbon's copy of the file as a new revision (the current version goes to History) and refuses while the file has a draft. The folder is not written by a restore: a later **Sync file to folder…** writes it, preserving the current disk version first when local history is on.

## Exports and sharing

- Ordinary TAR / TAR.GZ exports of the workspace exclude `.carbon-history`; history is local recovery data, not part of the user's documents. (Folder import must skip it too so it is never loaded as workspace files.)
- "Export local history" (`exportArchive()`) produces a TAR with root `carbon-history/` containing `README.txt`, `carbon-history.json` and `versions/...`, newest first. TAR limits (32 MiB total, 2000 members) can be smaller than the history; if so the archive contains `EXPORT-INCOMPLETE.txt` listing each omitted snapshot, which stays on disk. History holds complete earlier copies of files, so treat the export with the same care as the originals; exporting data outside the workplace requires the same authorization as the files themselves.
- Version control: add `.carbon-history/` to the ignore file if you do not want snapshots committed.
