/**
 * Independent workspaces ("mounts"). Exactly one is active in `state`; every other one is a
 * parked `carbon-vfs` record with its own files, History, drafts, tabs, Dispatches and link.
 * Switching parks the active workspace and activates the target in ONE store transaction, and
 * only then replaces the fields of `state` (the object every module holds), so a failed or
 * conflicting write leaves both the window and the store exactly as they were.
 *
 * DOM-free; the store is a `Vfs` or `MemoryVfs` (vfs.js), so Node tests run the same rules.
 */
import { SCRATCH_ID, archiveWorkspace, isLocalFolder } from "./local-files.js";
import { assert, encode } from "../core/validate.js";
import { writeTarFiles } from "../archives/tar.js";
import { createState, enqueue, mountRecord, restore } from "./state.js";

/** Active plus parked workspaces kept in one browser profile (RFC D8: 8 parked). */
export const MAX_MOUNTS = 9;
/** Above this a parked body is reported as large (bytes, including History). */
export const LARGE_MOUNT_BYTES = 16 * 1024 * 1024;

export const KIND_LABELS = { scratch: "Scratch", folder: "Local copy", linked: "Linked folder", stack: "Envoy Stack" };

/**
 * Read and validate a parked workspace. Nothing is written; a damaged record stays untouched.
 * @param {import("./vfs.js").Vfs|import("./vfs.js").MemoryVfs} store
 * @param {string} id
 * @param {(message: string) => void} [warn]
 * @returns {Promise<import("./types.js").WorkspaceState>}
 */
export async function loadMount(store, id, warn) {
  const record = await store.read(id);
  assert(record, "That workspace is no longer stored in this browser.");
  try {
    assert(Number.isSafeInteger(record.rev) && record.rev > 0, "its storage revision is unreadable");
    const state = restore(record, warn);
    assert(state.stack.manifest.id === id, "its stored identity does not match");
    return state;
  } catch (e) {
    throw new Error(`“${typeof record.title === "string" ? record.title : id}” could not be restored (${e.message}). Its stored copy is left untouched.`);
  }
}

/**
 * Park the active workspace and activate `target`, atomically.
 * @param {import("./vfs.js").Vfs|import("./vfs.js").MemoryVfs} store
 * @param {import("./types.js").WorkspaceState} state the live state; replaced only on success
 * @param {import("./types.js").WorkspaceState} target complete state of the workspace to activate
 * @param {{create?: boolean, write?: boolean}} [options] `create`: the target must not exist yet;
 *   `write`: store the target body too (always when creating)
 * @returns {Promise<void>}
 * @throws {import("./vfs.js").VfsConflictError} when either workspace changed in another tab
 */
export function activate(store, state, target, { create = false, write = create } = {}) {
  return enqueue(state, async () => {
    const from = state.stack.manifest.id,
      to = target.stack.manifest.id;
    assert(from !== to, "That workspace is already open.");
    const limitMessage = `Carbon keeps up to ${MAX_MOUNTS} workspaces in this browser. Remove one you have exported (Workspaces…) before opening another.`;
    // Early refusal from the last listing; the store re-checks inside the transaction (another tab may have added one).
    assert(new Set([...Object.keys(store.index), from, to]).size <= MAX_MOUNTS, limitMessage);
    const expect = new Map([
      [from, store.revs.get(from) ?? 0],
      [to, create ? 0 : store.revs.get(to) ?? 0],
    ]);
    const put = new Map([[from, mountRecord(state)]]);
    if (write) put.set(to, mountRecord(target));
    await store.transact({ expect, put, active: to, limit: MAX_MOUNTS, limitMessage });
    Object.assign(state, target, { selected: new Set() });
  });
}

/**
 * The state to activate for `id`: its stored record, or a fresh Scratch when Scratch was never
 * stored. `create` tells `activate` which case applies.
 * @returns {Promise<{target: import("./types.js").WorkspaceState, create: boolean}>}
 */
export async function mountTarget(store, id, warn) {
  await store.list();
  if (id === SCRATCH_ID && !Object.hasOwn(store.index, id) && !(await store.read(id))) return { target: createState(), create: true };
  return { target: await loadMount(store, id, warn), create: false };
}

/**
 * Remove a parked workspace (never the active one, never Scratch). The revision shown in the
 * listing the user acted on (`listedRev`, default: the last index read) must still match, so a workspace another tab changed since is not deleted; a record
 * without a readable revision (damaged) can still be removed.
 */
export function removeMount(store, state, id, listedRev = store.index[id]?.rev) {
  return enqueue(state, async () => {
    assert(id !== state.stack.manifest.id, "Switch to another workspace before removing this one.");
    assert(id !== SCRATCH_ID, "Scratch is always kept. Delete its notes instead.");
    const rev = listedRev;
    await store.transact({ expect: new Map([[id, Number.isSafeInteger(rev) && rev > 0 ? rev : null]]), remove: [id] });
  });
}

/**
 * Switcher rows: the active workspace first, then the most recently changed.
 * @param {object} index `meta/index`
 * @param {import("./types.js").WorkspaceState} state
 */
export function mountRows(index, state) {
  const active = state.stack.manifest.id;
  const rows = Object.entries(index || {}).map(([id, e]) => ({ id, ...e, active: id === active }));
  if (!rows.some((r) => r.active))
    rows.push({ id: active, kind: null, title: state.stack.manifest.title || active, files: state.stack.files.size, drafts: state.drafts.size, active: true });
  return rows.sort((a, b) => (b.active - a.active) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

/**
 * Files for a storage-failure recovery download (built in memory, no store write): the workspace
 * with its drafts applied as one archive; when the drafts cannot be part of a valid workspace
 * archive (validation, size or count limits), the saved workspace and a drafts-only archive at the
 * original paths, so recovery never depends on the workspace's spare capacity; as a last resort
 * each draft as its own text file.
 * @param {import("./types.js").Documents} stack
 * @param {Map<string, string>} drafts
 * @returns {{name: string, bytes: Uint8Array}[]}
 */
export function recoveryFiles(stack, drafts) {
  const writes = new Map([...drafts].map(([p, text]) => [p, encode(text)]));
  const base = `${stack.manifest.id}-recovery-r${stack.manifest.revision}`,
    kind = isLocalFolder(stack) ? ".folder" : "";
  try {
    return [{ name: `${base}${kind}.tar`, bytes: archiveWorkspace(writes.size ? stack.change({ writes }) : stack) }];
  } catch {
    /* the drafts do not fit the workspace archive: separate downloads below */
  }
  const out = [{ name: `${base}-saved${kind}.tar`, bytes: archiveWorkspace(stack) }];
  try {
    out.push({ name: `${base}-drafts.tar`, bytes: writeTarFiles(writes, new Set(), "drafts") });
  } catch {
    for (const [p, b] of writes) out.push({ name: `${base}-draft-${p.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120)}.txt`, bytes: b });
  }
  return out;
}
