/**
 * Linked source folders (RFC #25 rev 3, A3): a folder opened with the native directory picker is
 * an explicitly chosen SOURCE and optional SYNC TARGET of a virtual workspace. Carbon's copy
 * (`state.stack`, in the browser's `carbon-vfs` store) is the working copy: Save, New, Rename,
 * Delete, image insertion and History restore change it and never touch the folder. The folder
 * is read by an explicit **Refresh from folder** (observation only) and written by an explicit
 * single-file **Sync file to folder…** (consent, permission, conflict check, backup, write,
 * read-back verification), see docs/linked-folders.md.
 *
 * `state.link` carries the handle, consent and the source records of source.js (`baseline`,
 * `observed`). Pure logic and the pipelines live here; the only DOM use is the consent dialog
 * body and `renderLinkedStatus`, both reached through `deps`/`$` lazily so the pipelines run
 * under Node with fake handles. Nothing in this module runs for an imported copy or a Stack.
 */
import { assert, equal, LIMITS } from "../core/validate.js";
import { History } from "../core/stack.js";
import { canEdit, isLocalFolder, isScratch, textIssue } from "./local-files.js";
import { HISTORY_DIR_NAME, foldersDelete, foldersRead, foldersWrite } from "./fs.js";
import { $, el } from "./ui/dom.js";
import { isConflict, isQuota } from "./vfs.js";
import {
  SOURCE_STATES, baselineBytes, describeFolder, importedBaseline, observe, packSource, sourceState, sourceSummary,
  assertCapacity, syncedBaseline, takeDisk, validSource, withBytes,
} from "./source.js";

/** @typedef {import("./types.js").LinkState} LinkState */
/** @typedef {import("./types.js").LinkConsent} LinkConsent */

export const LINK_STATUSES = ["linked", "permission", "unavailable"];
export const DISK_HISTORY_DIR = HISTORY_DIR_NAME;

const msg = (e) => (e && e.message) || String(e);
const isMissing = (e) => e && (e.name === "NotFoundError" || e.name === "TypeMismatchError");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- shape, persistence ------------------------------------------------------------

/** True for something that behaves like a FileSystemDirectoryHandle (a structured clone keeps the prototype in Chromium). */
export function isDirectoryHandle(h) {
  return (
    isObject(h) &&
    h.kind === "directory" &&
    ["getFileHandle", "getDirectoryHandle", "queryPermission", "requestPermission", "entries"].every(
      (m) => typeof h[m] === "function",
    )
  );
}
/** Normalise untrusted consent to exactly three booleans, or null. */
export function validConsent(c) {
  if (!isObject(c)) return null;
  const { granted, remember, history } = c;
  if (![granted, remember, history].every((x) => typeof x === "boolean")) return null;
  return { granted, remember, history };
}
/**
 * A fresh link for a just-opened folder: every imported file is the baseline, and the read the
 * folder was imported from is its first observation. `memory` is a remembered per-folder record
 * (or null): it can pre-grant consent, never permission.
 * @param {FileSystemDirectoryHandle} handle
 * @param {object|null} memory
 * @param {import("./types.js").Documents} stack the imported workspace
 * @param {{files: [string, Uint8Array][], directories: string[], modified?: Map<string, number>}|null} [read] the import read
 * @returns {LinkState}
 */
export function newLink(handle, memory = null, stack = null, read = null) {
  const remembered = validConsent(memory?.consent);
  const consent =
    remembered && remembered.granted
      ? { granted: true, remember: true, history: typeof memory.history === "boolean" ? memory.history : remembered.history }
      : { granted: false, remember: false, history: true };
  const baseline = stack ? importedBaseline(stack) : new Map();
  const observed = stack && read ? describeFolder(read, { baseline }, stack) : null;
  return { handle, consent, status: "linked", op: null, lastSync: null, lastError: null, historyOk: null, baseline, observed };
}
/** The part of a link that is persisted in the mount record. */
export function packLink(link) {
  return link ? { handle: link.handle, consent: { ...link.consent }, lastSync: link.lastSync, ...packSource(link) } : null;
}
/**
 * Validate an untrusted cached link against the restored workspace. Unknown shapes, a missing or
 * non-directory handle, or a non-folder workspace (Stacks are never linked) yield null; damaged
 * source records degrade per `validSource`. Status is provisionally "permission" until
 * `verifyLink` has asked the browser.
 * @returns {LinkState|null}
 */
export function validLink(raw, stack) {
  if (!raw || !isLocalFolder(stack) || !isObject(raw)) return null;
  const consent = validConsent(raw.consent);
  if (!consent || !isDirectoryHandle(raw.handle)) return null;
  const last = raw.lastSync;
  const lastSync = isObject(last) && typeof last.path === "string" && typeof last.at === "string" ? { path: last.path, at: last.at } : null;
  return { handle: raw.handle, consent, status: "permission", op: null, lastSync, lastError: null, historyOk: null, ...validSource(raw, stack) };
}

/** Transient (never persisted) link fields change in place so every holder sees them. */
function patch(state, fields) {
  if (state.link) Object.assign(state.link, fields);
}

// ---- permission -----------------------------------------------------------------------

/** Ask the browser whether a recovered handle can still be read. Never prompts. */
export async function verifyLink(state) {
  const link = state.link;
  if (!link) return;
  try {
    const p = await link.handle.queryPermission({ mode: "read" });
    link.status = p === "granted" ? "linked" : "permission";
    link.lastError = null;
  } catch (e) {
    link.status = "unavailable";
    link.lastError = msg(e);
  }
}
/**
 * User-initiated reconnect (must run on a click). Requests read+write once; if write is refused
 * but read is still granted the folder is reconnected read-only and Sync will ask again. Nothing
 * is read or written: Refresh from folder is offered, never run.
 * @returns {Promise<LinkState["status"]>}
 */
export async function reconnectLink(deps) {
  const { state } = deps;
  const link = state.link;
  assert(link, "No linked folder to reconnect.");
  try {
    let p = await link.handle.requestPermission({ mode: "readwrite" });
    if (p !== "granted") p = await link.handle.queryPermission({ mode: "read" });
    link.status = p === "granted" ? "linked" : "permission";
    link.lastError = null;
  } catch (e) {
    link.status = "unavailable";
    link.lastError = msg(e);
  }
  deps.notify(
    link.status === "linked"
      ? `Reconnected ${folderName(state)}. Nothing was read or written; Refresh from folder compares it with Carbon's copy when you choose.`
      : link.status === "permission"
        ? "Folder access was not granted. Carbon's copy stays editable; try Reconnect again or export a copy."
        : `The folder cannot be reached (${link.lastError}). Carbon's copy stays editable; export a copy to keep it.`,
    link.status === "linked" ? "ok" : "error",
    link.status === "linked" ? [refreshAction(deps)] : [],
  );
  deps.render?.();
  return link.status;
}
/** "Refresh from folder" as a notice action; the click is also the user gesture a permission prompt needs. */
const refreshAction = (deps) => ({ label: "Refresh from folder", onClick: () => (deps.run ?? ((fn) => fn()))(() => refreshFolder(deps)) });
async function ensureWritable(state) {
  const link = state.link;
  try {
    let p = await link.handle.queryPermission({ mode: "readwrite" });
    if (p === "prompt") p = await link.handle.requestPermission({ mode: "readwrite" });
    if (p !== "granted") {
      link.status = "permission";
      throw new Error("Folder write permission denied; nothing was written. Your copy is kept in Carbon.");
    }
    link.status = "linked";
  } catch (e) {
    if (link.status !== "permission") {
      link.status = "unavailable";
      link.lastError = msg(e);
      throw new Error(`The folder cannot be reached (${msg(e)}); nothing was written. Your copy is kept in Carbon.`);
    }
    throw e;
  }
}
async function ensureReadable(state) {
  const link = state.link;
  let p = await link.handle.queryPermission({ mode: "read" });
  if (p === "prompt") p = await link.handle.requestPermission({ mode: "read" });
  assert(p === "granted", "Folder read permission denied; Carbon's copy is unchanged.");
}

// ---- disk access --------------------------------------------------------------------

async function walk(root, parts, create) {
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, create ? { create: true } : undefined);
  return dir;
}
/** Current bytes of `path` in the folder, or null when it does not exist. Throws for real read errors. */
export async function readDisk(root, path) {
  const parts = path.split("/"),
    name = parts.pop();
  let file;
  try {
    const dir = await walk(root, parts, false);
    file = await (await dir.getFileHandle(name)).getFile();
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
  // An external replacement larger than Carbon's file limit is never read into memory.
  if (file.size > LIMITS.file) throw new Error(`${path} in the folder is larger than Carbon's ${LIMITS.file / 1024 ** 2} MiB file limit`);
  return { bytes: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified };
}
/**
 * A folder entry whose name equals a component of `path` only case-insensitively (Carbon's own path
 * rule, `validatePaths`). On a case-sensitive filesystem the exact-name read above misses it, a write
 * would create both names, and Carbon could not reopen the folder. Returns that entry's path or null.
 */
async function caseCollision(root, path) {
  const parts = path.split("/");
  let dir = root,
    at = "";
  for (let i = 0; i < parts.length; i++) {
    const want = parts[i],
      key = want.toUpperCase();
    let exact = null,
      other = null;
    for await (const [name, handle] of dir.entries()) {
      if (name === want) exact = handle;
      else if (name.toUpperCase() === key) other = name;
    }
    if (other !== null) return at + other;
    if (!exact || exact.kind !== "directory" || i === parts.length - 1) return null;
    dir = exact;
    at += `${want}/`;
  }
  return null;
}
/**
 * After a failed write of a file that did not exist before: remove the empty file `getFileHandle(create)` made,
 * so a retry does not meet a stranger "already exists". Only a file still empty when checked is removed; best
 * effort, and the parent directories that were created stay (they hold nothing). Not closable (no conditional
 * remove exists): an empty file another program created there meanwhile is removed too, and a write landing
 * between the check and `removeEntry` is lost, like a write during `close()` (docs/linked-folders.md).
 * @returns {Promise<boolean>} true when nothing of Carbon's is left at `path`
 */
async function removeEmptyCreated(root, path) {
  const parts = path.split("/"),
    name = parts.pop();
  try {
    const dir = await walk(root, parts, false);
    let file;
    try {
      file = await (await dir.getFileHandle(name)).getFile();
    } catch (e) {
      return e?.name === "NotFoundError"; // a directory now at that path (TypeMismatchError) is not "nothing left"
    }
    if (file.size !== 0) return false;
    await dir.removeEntry(name);
    return true;
  } catch (e) {
    return e?.name === "NotFoundError";
  }
}
/** Thrown by `writeDisk` when the file changed while it was being written; the writable was aborted. */
const CHANGED_DURING_WRITE = "CARBON_CHANGED_DURING_WRITE";
/**
 * Write `bytes` through a writable stream. `before` is what the file held at Sync's last check (null: absent).
 * A writable stages its data until `close()` (Chromium: a swap file), so the target is read once more after
 * the write and before `close()`; if another writer changed it meanwhile the stream is aborted and nothing is
 * committed. This narrows the unavoidable window to `close()` itself (there is no compare-and-swap).
 */
async function writeDisk(root, path, bytes, before) {
  const parts = path.split("/"),
    name = parts.pop();
  const dir = await walk(root, parts, true);
  const handle = await dir.getFileHandle(name, { create: true });
  let writable;
  try {
    writable = await handle.createWritable();
    await writable.write(bytes);
    const now = await readDisk(root, path);
    // A file created for this write reads empty until close(); anything else must still be what was checked.
    const same = before ? now && equal(now.bytes, before) : !now || now.bytes.length === 0;
    if (!same) throw Object.assign(new Error(`${path} changed outside Carbon while it was being written`), { code: CHANGED_DURING_WRITE });
    await writable.close();
  } catch (e) {
    if (writable) await writable.abort().catch(() => {});
    throw e;
  }
}
const folderName = (state) => state.link?.handle?.name || state.stack.manifest.title || "folder";

// ---- consent ---------------------------------------------------------------------------------

/** The first-sync confirmation. Resolves `{history, remember}` or null on cancel. */
export function askConsent(deps, name) {
  return deps.modal(
    "Sync to the original folder?",
    (c) => {
      c.append(
        el("p", `Carbon will modify the original files in “${name}” and create the files you sync there. Until now it only read them.`),
        el("p", "Local history can be stored on disk: before each overwrite the previous version is copied into a .carbon-history/ directory that Carbon creates inside the selected folder."),
        el("p", "Cancel modifies nothing; your file stays saved in Carbon. Only the file you chose is written, and only after it is read back and verified."),
      );
      const history = el("input"),
        remember = el("input");
      history.type = remember.type = "checkbox";
      history.id = "consent-history";
      remember.id = "consent-remember";
      history.checked = true;
      const hl = el("label", " Keep local file history on disk (.carbon-history/)"),
        rl = el("label", " Remember for this folder");
      hl.prepend(history);
      rl.prepend(remember);
      c.append(hl, rl, el("p", "Remembering this choice does not grant folder access: the browser may still ask for write permission.", "hint"));
      return () => ({ history: history.checked, remember: remember.checked });
    },
    "Sync file",
  );
}

/**
 * Remembered per-folder consent (IndexedDB `folders` store). Handles are matched with
 * `isSameEntry`, never by name. Remembered consent never implies browser permission.
 * @param {() => IDBDatabase|null} getDb
 */
export function createFolderMemory(getDb, { read = foldersRead, write = foldersWrite, remove = foldersDelete } = {}) {
  async function find(handle) {
    const db = getDb();
    if (!db) return null;
    for (const record of await read(db)) {
      try {
        if (isObject(record.value) && (await handle.isSameEntry(record.value.handle))) return record;
      } catch {
        /* an unusable stored handle is simply not a match */
      }
    }
    return null;
  }
  return {
    find,
    async remember(handle, consent) {
      const db = getDb();
      if (!db) return false;
      const existing = await find(handle);
      await write(
        db,
        { handle, consent: { granted: true, remember: true, history: consent.history }, history: consent.history, updatedAt: new Date().toISOString() },
        existing?.key,
      );
      return true;
    },
    /** Delete every remembered record for this folder. Throws if the store cannot be changed. */
    async forget(handle) {
      const db = getDb();
      if (!db) return 0;
      let removed = 0;
      for (const record of await read(db)) {
        let same = false;
        try {
          same = isObject(record.value) && (await handle.isSameEntry(record.value.handle));
        } catch {
          /* an unusable stored handle is not a match */
        }
        if (same) {
          await remove(db, record.key);
          removed++;
        }
      }
      return removed;
    },
  };
}

/**
 * Withdraw remembered consent for the current folder: delete its `folders` record, then require
 * the consent dialog again on the next sync. Nothing in the folder is touched.
 */
export async function forgetConsent(deps) {
  const { state } = deps;
  const link = state.link;
  assert(link, "No linked folder.");
  if (deps.confirm) {
    const ok = await deps.confirm(
      "Forget remembered consent?",
      [`Carbon will stop remembering that you allowed syncing to “${folderName(state)}”. The next Sync file to folder asks again.`, "Nothing in the folder changes and no files are deleted."],
      "Forget",
    );
    if (!ok) return;
  }
  try {
    await deps.folderMemory?.forget(link.handle);
  } catch (e) {
    throw new Error(`Could not forget the remembered consent (${msg(e)}). It is still remembered.`);
  }
  await deps.commit({ link: { ...state.link, consent: { ...state.link.consent, granted: false, remember: false } } });
  deps.render?.();
  deps.notify(`Forgot remembered consent for ${folderName(state)}. The next Sync file to folder asks again.`, "ok");
}

// ---- sync pipeline -----------------------------------------------------------------------------

function fail(state, path, message, actions) {
  patch(state, { op: { kind: "syncFailed", path }, lastError: message });
  const error = new Error(message);
  if (actions) error.actions = actions; // the UI runner passes these to the notice
  return error;
}
/** "Reconnect folder…" as a notice action (the click is the user gesture the browser needs). */
const reconnectAction = (deps) => ({ label: "Reconnect folder…", onClick: () => (deps.run ?? ((fn) => fn()))(() => reconnectLink(deps)) });
const withReconnect = (deps, error) => Object.assign(error, { actions: [reconnectAction(deps)] });
/** Errors for a link that is not connected; shared by Sync, Refresh and Take disk. */
function assertConnected(deps, kept) {
  const link = deps.state.link;
  if (!link) throw new Error("This workspace is not a linked folder.");
  if (link.op?.kind === "saving") throw new Error("A sync is already in progress.");
  if (link.status === "permission")
    throw withReconnect(deps, new Error(`Folder access was not granted since this page loaded or was last refused. Use Reconnect folder…; ${kept}`));
  if (link.status === "unavailable")
    throw withReconnect(deps, new Error(`The linked folder cannot be reached${link.lastError ? ` (${link.lastError})` : ""}; ${kept}`));
}

/**
 * Sync ONE file's saved (committed) bytes to the folder. Order (nothing is written before step 5):
 *  0. require a connected link, a committed file and no draft for it (Sync writes the saved copy,
 *     never a draft, so what reached the disk is always a revision);
 *  1. first-sync consent (cancel => nothing written); consent is recorded cache-first;
 *  2. browser write permission (queried every time; remembered consent never implies it);
 *  3. the workspace revision this window holds is still the stored one (another tab has not
 *     committed a newer virtual copy), then the disk is read: it must hold exactly the bytes the
 *     baseline recorded (or nothing, for a file that was never on disk); anything else is refused
 *     with Refresh offered, so a decision is never applied to a folder that changed since it was looked at;
 *  4. history: when enabled, the CURRENT disk bytes are preserved first. Any failure stops the
 *     sync, the original is untouched. The file is re-read just before writing;
 *  5. write through a writable stream (abort on error), then re-read and compare the bytes;
 *  6. only after verification, record the new baseline cache-first (`link` only; the virtual
 *     bytes do not change). If the store refuses that record, the disk still holds the verified
 *     bytes: this window adopts the baseline in memory and the notice says, separately, that
 *     browser storage did not record it.
 *
 * @param {object} deps `state`, `commit`, `notify`, `modal`, optional `diskHistory(handle)`, `checkRevision`,
 *   `folderMemory`, `render`, `renderStatus`, `run`, `disableCache`, `now`
 * @param {string} path workspace path of a committed file
 * @param {{skipHistory?: boolean, recreate?: boolean}} [options] `skipHistory` is a one-off, user-confirmed
 *   sync without backup; `recreate` allows writing a file whose baseline says it was on disk but which is
 *   absent now (explicitly chosen from the refusal notice)
 * @returns {Promise<{ok: true, path: string, backedUp: boolean, written: boolean} | {ok: false, reason: "cancelled"|"conflict"}>}
 * @throws {Error} with a user-facing message on permission, backup, write or verification failure
 */
export async function syncFile(deps, path, { skipHistory = false, recreate = false } = {}) {
  const { state } = deps;
  const refresh = () => (deps.renderStatus ?? deps.render)?.();
  if (!state.link) throw new Error("This workspace is not a linked folder; Save keeps changes in Carbon only.");
  assertConnected(deps, "your copy is kept in Carbon.");
  assert(typeof path === "string" && state.stack.files.has(path), `Not a file in Carbon: ${path}`);
  assert(!state.drafts.has(path), `Save or discard the draft of ${path} first: Sync writes the saved copy, never a draft. Nothing was written.`);
  // The folder's own .carbon-history/ belongs to local file history, whatever Carbon's copy holds.
  assert(path.split("/")[0].toLowerCase() !== HISTORY_DIR_NAME, `${path} is inside ${HISTORY_DIR_NAME}/, which Carbon reserves for local file history in the folder. Nothing was written; rename it in Carbon to sync it.`);
  const bytes = state.stack.files.get(path);
  const base = baselineBytes(state.link, state.stack, path);
  // After this Sync, with `path` at its new size and its parent directories created, the folder as Carbon
  // knows it (files deleted only in Carbon included) must stay within the folder limits (source.js).
  assertCapacity(state.link, state.stack, new Map([[path, bytes.length]]), `Syncing ${path}`, "Nothing was written.");
  const name = folderName(state);

  // Step 1: first-sync consent.
  if (!state.link.consent.granted) {
    const answer = await askConsent(deps, name);
    if (!answer) {
      deps.notify("Sync cancelled. Nothing in the folder was modified; your file stays saved in Carbon.");
      return { ok: false, reason: "cancelled" };
    }
    const consent = { granted: true, remember: !!answer.remember, history: !!answer.history };
    await deps.commit({ link: { ...state.link, consent } });
    if (consent.remember) {
      try {
        await deps.folderMemory?.remember(state.link.handle, consent);
      } catch (e) {
        deps.notify(`Consent applies to this workspace, but it could not be remembered for the folder (${msg(e)}).`, "error");
      }
    }
  }
  const op = (kind) => ({ kind, path });
  const bad = (message, actions) => fail(state, path, message, actions);
  const retry = deps.run ?? ((fn) => fn());
  /** Refuse because the folder is not what the baseline says. Nothing has been written. */
  const refuse = (text, actions = [refreshAction(deps)]) => {
    patch(state, { op: op("conflict"), lastError: text });
    deps.notify(text, "error", actions);
    refresh();
    return { ok: false, reason: "conflict" };
  };
  try {
    patch(state, { op: op("saving"), lastError: null });
    refresh();
    // Step 2: permission (queried on every sync).
    await ensureWritable(state).catch((e) => {
      throw withReconnect(deps, e);
    });

    // Step 3: this window's copy is the stored one, and the disk is what the baseline recorded.
    if (typeof deps.checkRevision === "function") await deps.checkRevision();
    let disk;
    try {
      disk = await readDisk(state.link.handle, path);
    } catch (e) {
      throw bad(`Could not read ${path} in the folder before syncing (${msg(e)}). Nothing was written; your copy is kept in Carbon.`);
    }
    const missing = disk === null;
    if (missing && base !== undefined && !recreate)
      return refuse(`${path} is no longer in the folder (removed or renamed outside Carbon). Nothing was written; Carbon keeps your copy.`, [
        { label: "Recreate in folder", onClick: () => retry(() => syncFile(deps, path, { skipHistory, recreate: true })) },
        refreshAction(deps),
      ]);
    /**
     * Refuse when the folder holds a name that differs from `path` (or a parent) only by case (null = none).
     * Run whether or not the exact lookup found a file: on a case-insensitive filesystem the lookup of
     * `notes.txt` returns `Notes.txt`, and only the folder's listing shows the real spelling.
     */
    const caseRefusal = async () => {
      let other;
      try {
        other = await caseCollision(state.link.handle, path);
      } catch (e) {
        throw bad(`Could not read the folder before syncing ${path} (${msg(e)}). Nothing was written; your copy is kept in Carbon.`);
      }
      return other ? refuse(`The folder already has ${other}, which differs from ${path} only by case. Carbon keeps names unique regardless of case, so nothing was written; rename one of them first.`) : null;
    };
    {
      const refused = await caseRefusal();
      if (refused) return refused;
    }
    if (!missing && base === undefined && !equal(disk.bytes, bytes))
      return refuse(`${path} already exists in the folder but was never imported into Carbon. Nothing was overwritten; Refresh from folder, then Import it or keep both.`);
    if (!missing && base !== undefined && !equal(disk.bytes, base) && !equal(disk.bytes, bytes))
      return refuse(`${path} changed in the folder since Carbon last read it. Nothing was overwritten; Refresh from folder to compare and choose.`);

    // Step 4: history. The current disk version must be safe before it is replaced.
    const unchanged = !missing && equal(disk.bytes, bytes);
    let backedUp = false;
    if (!missing && !unchanged && state.link.consent.history && !skipHistory) {
      try {
        if (typeof deps.diskHistory !== "function") throw new Error("local history is not available in this build");
        const history = await deps.diskHistory(state.link.handle);
        await history.preserve(path, disk.bytes, { modified: disk.modified });
        backedUp = true;
        state.link.historyOk = true;
      } catch (e) {
        state.link.historyOk = false;
        throw bad(`Sync stopped: the backup could not be written (${msg(e)}). The original file is unchanged.`, deps.confirm ? [noHistoryAction(deps, path, recreate)] : undefined);
      }
    }

    // Step 4b: the backup is an await: probe the stored revision again, THEN repeat the folder checks as the
    // last awaits before the write (so a folder change during the probe is seen too): for a new file the
    // case-collision walk, then the exact re-read. If the folder is no longer what the check saw, write nothing
    // (a backup already made is only an extra copy). The step-6 commit is the final store check; the folder
    // write itself cannot join a store transaction, and the window between the last read and the write
    // remains (the file system has no compare-and-swap).
    if (!unchanged && typeof deps.checkRevision === "function") await deps.checkRevision();
    if (!unchanged) {
      const refused = await caseRefusal();
      if (refused) return refused;
    }
    if (!unchanged) {
      let again;
      try {
        again = await readDisk(state.link.handle, path);
      } catch (e) {
        throw bad(`Could not read ${path} in the folder just before writing (${msg(e)}). Nothing was written; your copy is kept in Carbon.`);
      }
      if (missing ? again !== null : !again || !equal(again.bytes, disk.bytes))
        return refuse(
          again === null
            ? `${path} was removed or renamed outside Carbon while the sync was being prepared. Nothing was written; Carbon keeps your copy.`
            : `${path} changed outside Carbon while the sync was being prepared. Nothing was overwritten; Carbon keeps your copy.`,
        );
    }

    // Step 5: write, then verify what is actually on disk.
    let written = disk;
    if (!unchanged) {
      try {
        await writeDisk(state.link.handle, path, bytes, missing ? null : disk.bytes);
      } catch (e) {
        if (e?.code === CHANGED_DURING_WRITE)
          return refuse(`${path} changed outside Carbon while it was being written, so the write was abandoned before it took effect. Nothing was overwritten; Carbon keeps your copy. Refresh from folder to compare.`);
        let after = "Refresh from folder before syncing again.";
        if (missing)
          after = (await removeEmptyCreated(state.link.handle, path))
            ? "Nothing was left in the folder at that path."
            : `${path} may now exist in the folder as an empty or partial file; Refresh from folder before syncing again.`;
        else
          try {
            const now = await readDisk(state.link.handle, path);
            if (now && equal(now.bytes, disk.bytes)) after = "The original file is unchanged.";
          } catch {
            /* leave the cautious wording */
          }
        throw bad(`Sync failed: the folder could not be written (${msg(e)}). ${after} Your copy is kept in Carbon.`);
      }
      try {
        written = await readDisk(state.link.handle, path);
      } catch (e) {
        throw bad(`Sync could not be verified: the file could not be read back (${msg(e)}). Your copy is kept in Carbon; Refresh from folder and compare before syncing again.`);
      }
      if (!written || !equal(written.bytes, bytes))
        throw bad(`Sync could not be verified: the file in the folder does not match what Carbon wrote. Your copy is kept in Carbon; Refresh from folder and compare before syncing again.`);
    }

    // Step 6: verified on disk; now record the baseline in the workspace (cache first). Carbon's copy is
    // read again: a Save, Delete or move in this window while the Sync awaited the folder is not synced.
    const now = state.stack.files.get(path);
    const overtaken = !now || !equal(now, bytes);
    const link = syncedBaseline(
      { ...state.link, op: null, lastError: null, status: "linked", lastSync: { path, at: (deps.now?.() ?? new Date()).toISOString() } },
      path,
      bytes,
      written?.modified ?? null,
      now,
    );
    const candidate = { link };
    let cacheWarning = "",
      actions = [];
    try {
      await deps.commit(candidate);
    } catch (e) {
      // The folder already holds the verified bytes, so this window adopts the baseline in memory:
      // keeping the old one would report a false difference. The stored record still has the previous
      // baseline and observation: after a reload the file reads "edited in Carbon, not synced" until the next
      // Refresh shows "same as folder, not recorded as synced"; either way a Sync records it without writing.
      Object.assign(state, candidate);
      if (isQuota(e) || isConflict(e)) {
        actions = e.actions || [];
        cacheWarning = isConflict(e)
          ? " Browser storage did not record the sync: this workspace changed in another Carbon tab. Reload to continue with the stored copy (the folder keeps what was just written), or download a recovery copy."
          : " Browser storage did not record the sync: it is full. Carbon retries on your next change; download a recovery copy to be safe.";
      } else {
        deps.disableCache?.();
        cacheWarning = ` Browser storage did not record the sync (${msg(e)}); keep this window open and export.`;
      }
    }
    deps.render?.();
    deps.notify(
      `${unchanged ? `${name}/${path} already held these bytes; recorded as synced, nothing written.` : `Synced ${name}/${path} (written and read back).`}${backedUp ? " The previous version is in local history." : skipHistory && !missing && !unchanged ? " Synced without history." : ""}${overtaken ? ` Carbon's copy of ${path} changed while it was syncing; that newer version is not in the folder yet.` : ""}${cacheWarning}`,
      cacheWarning ? "error" : "ok",
      actions,
    );
    return { ok: true, path, backedUp, written: !unchanged };
  } catch (e) {
    if (state.link?.op?.kind === "saving") patch(state, { op: op("syncFailed"), lastError: msg(e) });
    refresh();
    throw e;
  }
}

/** After a backup failure, offer one explicit, confirmed sync without a backup (carried on the error as `actions`). */
function noHistoryAction(deps, path, recreate) {
  return {
    label: "Sync without history…",
    onClick: () =>
      (deps.run ?? ((fn) => fn()))(async () => {
        const ok = await deps.confirm(
          "Sync without a backup?",
          [`The original ${path} will be overwritten and its previous version will NOT be kept anywhere.`, "Only this sync skips history."],
          "Overwrite without backup",
        );
        if (ok) await syncFile(deps, path, { skipHistory: true, recreate });
      }),
  };
}

// ---- refresh (observation) --------------------------------------------------------------------------

/**
 * Re-read the whole linked folder and record what it holds (`link.observed`), WITHOUT changing a
 * single virtual file, draft, tab or History entry: Refresh observes and offers; every change to
 * Carbon's copy is a separate explicit action (docs/linked-folders.md). Writes nothing; needs
 * read access only. One cache-first commit of `{ link }`.
 * @returns {Promise<{counts: Record<string, number>, unsynced: number, foldersAdded: string[], foldersMissing: string[]}>}
 */
export async function refreshFolder(deps) {
  const { state } = deps;
  assertConnected(deps, "Carbon's copy and your drafts are unchanged.");
  const { stack, link } = state;
  let observed;
  try {
    await ensureReadable(state);
    observed = await observe(link.handle, link, stack, { now: deps.now });
  } catch (e) {
    if (e?.name === "NotAllowedError" || e?.name === "SecurityError" || /permission denied/i.test(msg(e))) {
      patch(state, { status: "permission", lastError: null });
      deps.render?.();
      throw withReconnect(deps, new Error("Folder access was not granted. Use Reconnect folder…; Carbon's copy and your drafts are unchanged."));
    }
    if (isMissing(e)) {
      patch(state, { status: "unavailable", lastError: msg(e) });
      deps.render?.();
      throw withReconnect(deps, new Error(`The linked folder cannot be reached (${msg(e)}). Carbon's copy and your drafts are unchanged.`));
    }
    throw new Error(`Could not read the folder (${msg(e)}). Carbon's copy and your drafts are unchanged.`);
  }
  assert(state.stack === stack && state.link === link, "The workspace changed while the folder was being read; refresh again. Nothing was changed.");
  const next = { ...link, observed, op: null, lastError: null };
  await deps.commit({ link: next });
  const { counts, unsynced } = sourceSummary(next, stack);
  const onDisk = new Set(observed.directories);
  const foldersAdded = observed.directories.filter((d) => !stack.directories.has(d)),
    foldersMissing = [...stack.directories].filter((d) => !onDisk.has(d));
  const name = folderName(state);
  const parts = [];
  const say = (n, text) => n && parts.push(`${n} ${text}`);
  say(counts.incoming, "new in folder");
  say(counts.externalChange, "changed in folder");
  say(counts.conflict, "changed in folder and in Carbon");
  say(counts.missing, "missing from folder");
  say(foldersAdded.length + foldersMissing.length, `folder${foldersAdded.length + foldersMissing.length === 1 ? "" : "s"} differ`);
  const changes = parts.length > 0;
  deps.render?.();
  deps.notify(
    `Read ${name}: ${changes ? parts.join(", ") : unsynced ? "no folder changes to resolve" : "no difference from Carbon's copy"}. Nothing in Carbon was changed${unsynced ? `; ${unsynced} file${unsynced === 1 ? "" : "s"} not synced to the folder` : ""}.`,
    "ok",
    changes && typeof deps.openSourceChanges === "function" ? [{ label: "Folder changes…", onClick: () => (deps.run ?? ((fn) => fn()))(() => deps.openSourceChanges()) }] : [],
  );
  return { counts, unsynced, foldersAdded, foldersMissing };
}

// ---- take disk version (explicit, confirmed by the caller) -------------------------------------------------

/**
 * Replace Carbon's bytes for `path` with the file currently on disk (Reload from disk / Take disk
 * version). The caller has shown the user the observed disk version and asked for confirmation;
 * the disk is read again and must still hold what was shown. The previous revision goes to
 * History first and the baseline becomes the adopted bytes. An unsaved draft is NOT discarded
 * (unless it equals the adopted bytes); bytes the Editor cannot open are never adopted while a
 * draft exists, so the draft keeps its tab.
 */
/**
 * Read the folder's current version of `path` for a preview the user confirms (Take folder version of a
 * version the last Refresh did not capture). Reads only; the bytes returned are what a confirmed Take
 * must find on disk (`takeDiskVersion(…, {expected})`).
 * @returns {Promise<Uint8Array>}
 */
export async function readFolderVersion(deps, path) {
  const { state } = deps;
  assertConnected(deps, "Carbon's copy is unchanged.");
  try {
    await ensureReadable(state);
  } catch (e) {
    patch(state, { status: "permission" });
    throw withReconnect(deps, e);
  }
  let disk;
  try {
    disk = await readDisk(state.link.handle, path);
  } catch (e) {
    throw new Error(`Could not read ${path} from the folder (${msg(e)}). Carbon's copy is unchanged.`);
  }
  if (disk === null) throw new Error(`${path} is no longer in the folder, so there is nothing to take. Carbon keeps your copy; Refresh from folder to see the folder as it is now.`);
  return disk.bytes;
}

/**
 * @param {{expected?: Uint8Array}} [options] the exact bytes the user confirmed (from `readFolderVersion`).
 *   Required when the last Refresh did not capture the folder's version: the decision is bound to bytes,
 *   never to size and modified time alone (G2).
 */
export async function takeDiskVersion(deps, path, { expected } = {}) {
  const { state } = deps;
  assertConnected(deps, "Carbon's copy is unchanged.");
  const { stack, link } = state;
  assert(stack.files.has(path), `Not a file in Carbon: ${path}`);
  try {
    await ensureReadable(state);
  } catch (e) {
    patch(state, { status: "permission" });
    throw withReconnect(deps, e);
  }
  let disk;
  try {
    disk = await readDisk(link.handle, path);
  } catch (e) {
    throw new Error(`Could not read ${path} from the folder (${msg(e)}). Carbon's copy is unchanged.`);
  }
  if (disk === null) throw new Error(`${path} is no longer in the folder, so there is nothing to take. Carbon keeps your copy; Refresh from folder to see the folder as it is now.`);
  // The reads above are awaits: a Save, Sync or Refresh in this window meanwhile would make this decision stale.
  assert(state.stack === stack && state.link === link, `${path} or the folder record changed in Carbon while the folder was being read. Nothing was changed; look again and choose.`);
  const seen = link.observed?.entries.get(path);
  const shown = seen ? (seen.same ? baselineBytes(link, stack, path) : seen.bytes) : null;
  // The decision is bound to exact bytes (G2): the captured version the user looked at, and/or the bytes
  // confirmed in a fresh preview. Size and modified time alone never authorise a Take (same-length edits can
  // keep or restore the time), so an uncaptured version without a confirmed preview fails closed.
  if (!shown && !expected)
    throw new Error(`Carbon did not keep the folder's version of ${path} at the last Refresh (it was over the capture budget), so it cannot confirm that the version on disk now is the one you chose. Nothing was changed; use Take folder version… again, which reads and shows the current version before you confirm.`);
  if ((shown && !equal(shown, disk.bytes)) || (expected && !equal(expected, disk.bytes)))
    throw new Error(`${path} changed in the folder since ${expected ? "you confirmed it" : "the last Refresh"}, so the version you looked at is not the one on disk now. Carbon's copy is unchanged; Refresh from folder and look again.`);
  // Never adopt bytes the Editor cannot open while a draft exists, or the draft would lose its tab.
  const issue = state.drafts.has(path) && canEdit(stack, path) && textIssue(disk.bytes);
  if (issue)
    throw new Error(`${path} in the folder can no longer be edited as text (${issue}), so it was not taken: Carbon's copy and your draft are unchanged. Save or discard the draft first.`);
  const drafts = new Map(state.drafts);
  if (drafts.has(path) && equal(new TextEncoder().encode(drafts.get(path)), disk.bytes)) drafts.delete(path);
  // Disk bytes are a baseline, not an Editor write: an unreadable `.md` is adopted read-only; the folder's
  // path, file and total bounds are still checked (source.js builds the LocalFolder directly).
  let taken;
  try {
    taken = takeDisk(link, stack, path, disk.bytes, disk.modified);
  } catch (e) {
    throw new Error(`Could not take ${path} from the folder (${msg(e)}). Carbon's copy is unchanged.`);
  }
  const { stack: next, link: adopted } = taken;
  const history = new History([...state.history.items]);
  if (next !== stack) history.push(stack, `Before taking ${path} from the folder`);
  // A changed revision is not in any archive yet: an export awaiting confirmation must not count it as saved.
  await deps.commit({ stack: next, history, drafts, link: { ...adopted, op: null, lastError: null }, ...(next !== stack ? { unexported: true, copyState: "pending" } : {}) });
  deps.render?.();
  deps.notify(
    `${next === stack ? `${path} already matched the folder; recorded as synced.` : `Took the folder's version of ${path}. The previous version is in History.`}${drafts.has(path) ? " Your unsaved draft is still here." : ""}`,
    "ok",
  );
}

/**
 * Disk-history Restore (D21): put a `.carbon-history` snapshot into Carbon's copy of `path` as a new
 * revision, History first; the folder is written only by a later Sync. A snapshot is folder bytes, not an
 * Editor write, so an unreadable `.md` is restored read-only (`withBytes`). Refused while `path` has a draft.
 */
export async function restoreSnapshot(deps, path, bytes) {
  const { state } = deps;
  assert(!state.drafts.has(path), "Save or discard the draft first");
  assert(state.stack.files.has(path), `Not a file in Carbon: ${path}`);
  let next;
  try {
    next = withBytes(state.stack, path, bytes);
  } catch (e) {
    throw new Error(`Could not restore ${path} (${msg(e)}). Carbon's copy is unchanged.`);
  }
  const history = new History([...state.history.items]);
  history.push(state.stack, `Before restoring ${path} from local history`);
  await deps.commit({ stack: next, history, unexported: true, copyState: "pending" });
  return { ok: true, path };
}

// ---- status for the UI ---------------------------------------------------------------------------

const timeWord = (iso) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
/**
 * Status of `path` (or of the workspace when `path` is null).
 * @returns {{kind: string, label: string, glyph: string, tooltip: string}|null}
 *   null for Stacks. `kind` is one of `imported`, `permission`, `saving`, `syncFailed`, `conflict` (a sync
 *   refused), `linked` (workspace summary) or a source state name.
 */
export function linkedStatus(state, path = state.current) {
  const link = state.link;
  const st = (kind, label, tooltip, glyph = "") => ({ kind, label, glyph, tooltip });
  if (!link)
    return isLocalFolder(state.stack) && !isScratch(state.stack)
      ? st("imported", "Local copy", "An independent copy in Carbon. Save updates this copy only; the source folder is never written.")
      : null;
  const name = link.handle?.name || "the folder";
  if (link.status === "unavailable")
    return st("permission", "Folder unavailable", `The linked folder cannot be reached${link.lastError ? ` (${link.lastError})` : ""}. Your files stay editable in Carbon; Refresh and Sync need the folder.`, "⚠");
  if (link.status === "permission")
    return st("permission", "Reconnect needed", "The browser has not (re)granted access to the folder. Your files stay editable in Carbon; use Reconnect folder… before Refresh or Sync.", "⚠");
  const op = link.op && (path == null || link.op.path === path) ? link.op : null;
  if (op?.kind === "saving") return st("saving", "Syncing…", "Writing and verifying the file in the folder.", "↗");
  if (op?.kind === "conflict") return st("conflict", "Sync refused", link.lastError || "The folder is not what Carbon last read. Nothing was overwritten.", "⚠");
  if (op?.kind === "syncFailed") return st("syncFailed", "Sync failed", link.lastError || "The folder was not updated; your copy is kept in Carbon.", "⚠");
  const read = link.observed ? ` Folder read ${timeWord(link.observed.at)}.` : " The folder has not been read since this workspace was opened.";
  if (path == null) {
    const { unsynced, external } = sourceSummary(link, state.stack);
    const differs = external ? ` ${external} folder change${external === 1 ? "" : "s"} to look at (Folder changes…).` : "";
    return st("linked", `Linked: ${name}`, `${unsynced ? `${unsynced} file${unsynced === 1 ? "" : "s"} not synced to ${name}.` : external ? `No edits in Carbon waiting to sync.` : `Every file matches ${name} as of the last read.`}${differs}${read} Save keeps changes in this browser; Sync file to folder… writes one file.`, unsynced || external ? "●" : "✓");
  }
  const kind = sourceState(link, state.stack, path);
  const { glyph, label } = SOURCE_STATES[kind];
  const tips = {
    virtual: `Only in Carbon: ${name} has no file at this path. Sync file to folder… creates it there.`,
    synced: `Same bytes as ${name} as of the last read${link.lastSync?.path === path ? ` (synced ${timeWord(link.lastSync.at)})` : ""}. Save keeps new edits in this browser.`,
    matched: `${name} already holds exactly these bytes, but the sync was not recorded in this browser. Sync file to folder… records it without writing.`,
    modified: `Edited in Carbon since it was last read from or synced to ${name}. The folder still has the old version until you Sync file to folder….`,
    externalChange: `Changed in ${name} since Carbon last read it; Carbon's copy is unchanged. Compare, or take the folder's version (the previous one goes to History).`,
    conflict: `Changed in ${name} and edited in Carbon. Both versions are kept until you choose: Keep mine, Take disk version or Keep both.`,
    missing: `Not in ${name} any more (removed or renamed outside Carbon). Carbon keeps your copy; Sync file to folder… can recreate it.`,
    deletedInCarbon: `Deleted in Carbon; ${name} still has it. Restore brings it back; Sync never deletes in the folder.`,
    incoming: `New in ${name}; not in Carbon until you Import it.`,
  };
  return st(kind, label, `${tips[kind]}${read}`, glyph);
}

/**
 * Update the linked-folder surfaces. Hooks (all optional in the markup): #link-status, #save-state,
 * #save-entry (label), #stack-id, #stack-status, #reconnect-folder, #forget-folder, #refresh-folder,
 * #sync-file and #source-changes. Nothing is disabled: every editing action is virtual.
 * @param {{state: object}} deps
 */
export function renderLinkedStatus(deps) {
  const { state } = deps;
  const link = state.link;
  const info = linkedStatus(state, null);
  const linkEl = $("link-status"),
    saveEl = $("save-state"),
    reconnect = $("reconnect-folder"),
    forget = $("forget-folder"),
    refresh = $("refresh-folder"),
    sync = $("sync-file"),
    changes = $("source-changes");
  const classes = ["is-dirty", "is-saving", "is-saved", "is-conflict", "is-error"];
  if (linkEl) {
    linkEl.hidden = !info;
    linkEl.classList.remove(...classes);
    if (info) {
      linkEl.textContent = link ? `${info.glyph} ${info.label}` : info.label;
      linkEl.title = info.tooltip;
      if (link && link.status !== "linked") linkEl.classList.add("is-error");
    }
  }
  if (saveEl) {
    saveEl.classList.remove(...classes);
    const file = link && state.current ? linkedStatus(state, state.current) : null;
    saveEl.hidden = !file;
    if (file) {
      const cls = { saving: "is-saving", conflict: "is-conflict", missing: "is-conflict", syncFailed: "is-error", permission: "is-error", synced: "is-saved", matched: "is-saved" }[file.kind] || "is-dirty";
      saveEl.textContent = `${file.glyph} ${file.label}`.trim();
      saveEl.title = file.tooltip;
      saveEl.classList.add(cls);
      saveEl.dataset.state = file.kind;
    }
  }
  if (reconnect) reconnect.hidden = !(link && link.status !== "linked");
  if (forget) forget.hidden = !link?.consent.remember;
  if (refresh) refresh.hidden = !link;
  if (sync) {
    sync.hidden = !link;
    sync.disabled = !link || !state.current;
  }
  if (changes) changes.hidden = !link;
  if (!link) return;
  const save = $("save-entry");
  if (save) save.textContent = "Save in Carbon";
  const id = $("stack-id");
  if (id) id.textContent = "Linked folder · Save keeps changes in this browser only; Sync file to folder… writes one file to the original folder after you confirm. Create an Envoy Stack from Open / Import to use Dispatch / Return.";
  const status = $("stack-status");
  if (status) {
    const { unsynced, external } = sourceSummary(link, state.stack);
    status.textContent =
      link.status !== "linked"
        ? "Folder access needs to be reconnected before Refresh or Sync; your files stay editable in Carbon."
        : `${unsynced ? `${unsynced} file${unsynced === 1 ? "" : "s"} not synced to the folder` : external ? "No edits waiting to sync" : "All files synced"}${external ? ` · ${external} folder change${external === 1 ? "" : "s"} to look at` : ""}${link.observed ? ` · folder read ${timeWord(link.observed.at)}` : " · folder not read yet"}.`;
  }
}
