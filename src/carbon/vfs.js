/**
 * Carbon virtual filesystem store: the `carbon-vfs` IndexedDB database. Every workspace (Scratch,
 * local copies, linked folders, Envoy Stacks) is one independent record in `mounts`, keyed by its
 * stable workspace id. `meta/active` names the workspace that opens on the next load and
 * `meta/index` lists every mount for the switcher without reading bodies.
 *
 * Rules (see docs/virtual-workspace.md):
 *  - One `readwrite` transaction per change across `mounts` + `meta`; the index is rewritten in the
 *    same transaction as the bodies it describes, so a failure leaves every key as it was.
 *  - Each body carries `rev`. A write states the revision it expects (0: must not exist yet); a
 *    mismatch aborts the whole transaction with `VfsConflictError` ("changed in another tab")
 *    instead of overwriting. A stored body without a valid `rev` is never overwritten.
 *  - A failure is reported only from `onabort`, with the request's own error (for example
 *    `QuotaExceededError`); the store keeps working and the next change simply retries.
 *  - The pre-VFS database `envoy-carbon-v1` is never opened, written or deleted here.
 *
 * `MemoryVfs` implements the same interface without durability: it is the per-window store when
 * IndexedDB is unavailable, and the Node test double for the transaction rules.
 */
import { assert } from "../core/validate.js";
import { sourceBytes } from "./source.js";

export const VFS_NAME = "carbon-vfs";
export const VFS_VERSION = 1;
/** The pre-VFS private-beta database. Only its name is used, to mention it on a fresh start. */
export const LEGACY_DB_NAME = "envoy-carbon-v1";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Another tab (or an earlier write in this one) changed a workspace since this window read it. */
export class VfsConflictError extends Error {
  constructor(id, expected, found) {
    super(`This workspace changed in another Carbon tab or window (revision ${Number.isNaN(found) ? "unreadable" : found}, this window expected ${expected}). Nothing was overwritten.`);
    this.name = "VfsConflictError";
    this.code = "VFS_CONFLICT";
    this.mountId = id;
  }
}
export const isConflict = (e) => e?.code === "VFS_CONFLICT";
/** A storage-full failure as browsers report it (by name, or legacy DOMException code 22). */
export const isQuota = (e) => e?.name === "QuotaExceededError" || e?.code === 22;

/** Total bytes of a packed workspace body: its files, History snapshots and a linked folder's source records (shadows, captured disk bytes). */
export function recordBytes(record) {
  // Bodies may be damaged (index recovery): tolerate any member shape.
  const size = (packed) =>
    Array.isArray(packed?.files) ? packed.files.reduce((n, f) => n + (Array.isArray(f) && Number.isSafeInteger(f[1]?.length) ? f[1].length : 0), 0) : 0;
  return size(record?.stack) + (Array.isArray(record?.history) ? record.history.reduce((n, x) => n + size(x?.stack), 0) : 0) + sourceBytes(record?.link);
}

/** The switcher entry for a body (kept in `meta/index`, written with the body). */
export function indexEntry(record) {
  return {
    kind: record.kind,
    title: record.title,
    rev: record.rev,
    bytes: recordBytes(record),
    files: Array.isArray(record.stack?.files) ? record.stack.files.length : 0,
    drafts: Array.isArray(record.drafts) ? record.drafts.length : 0,
    unexported: !!record.unexported,
    updatedAt: record.updatedAt,
    ...(record.link?.handle ? { handle: record.link.handle } : {}),
  };
}

/**
 * Pure transaction rules shared by both stores.
 * @param {Map<string, number>} found stored `rev` per requested id (absent key: no body; NaN: unreadable rev)
 * @param {object} index current `meta/index` value
 * @param {{expect?: Map<string, number|null>, put?: Map<string, object>, remove?: string[]}} ops
 *   `expect`: revision each id must have (0: absent, null: unchecked, only for removal)
 * @param {object} [tombstones] `meta/tombstones`: last revision of each removed id
 * @returns {{writes: Map<string, object>, revs: Map<string, number>, index: object, tombstones: object}}
 * @throws {VfsConflictError} when any expectation fails; nothing may be written then
 *
 * Revisions are monotonic per id across removal: a recreated workspace continues after its
 * tombstone, so a stale window still holding the removed incarnation's revision conflicts.
 */
export function planTransaction(found, index, { expect = new Map(), put = new Map(), remove = [], limit = Infinity, limitMessage = "Too many workspaces" }, tombstones = {}, now = Date.now()) {
  const removing = new Set(remove);
  for (const [id, want] of expect) {
    const have = found.has(id) ? found.get(id) : 0;
    if (removing.has(id)) {
      // Removal checks what is stored NOW: an absent or unreadable body holds nothing that can be lost,
      // while a readable one must be exactly the listed revision (a "damaged" listing, `null`, never
      // matches a readable body, so a healthy replacement made meanwhile is a conflict, not a deletion).
      if (Number.isNaN(have) || have === 0) continue;
      if (have !== want) throw new VfsConflictError(id, want ?? "unreadable", have);
      continue;
    }
    if (want === null) continue;
    if (have !== want) throw new VfsConflictError(id, want, have);
  }
  const next = isObject(index) ? { ...index } : {};
  const graves = isObject(tombstones) ? { ...tombstones } : {};
  const writes = new Map(), revs = new Map();
  for (const [id, record] of put) {
    assert(expect.has(id) && expect.get(id) !== null, `Internal error: write to ${id} without an expected revision`);
    assert(record.id === id, "Internal error: workspace record id mismatch");
    const base = expect.get(id) || (Number.isSafeInteger(graves[id]) ? graves[id] : 0);
    const body = { ...record, rev: base + 1 };
    writes.set(id, body);
    revs.set(id, body.rev);
    next[id] = indexEntry(body);
  }
  for (const id of remove) {
    assert(expect.has(id) && !put.has(id), `Internal error: removal of ${id} without an expectation`);
    // The tombstone is the highest revision any window could still hold for this id. When the body's
    // revision is unreadable, nothing records how high it went, so jump past any count of real writes
    // (milliseconds since the epoch): a re-created workspace then always outranks a stale window.
    const last = found.get(id), want = expect.get(id);
    const known = [last, want, graves[id]].filter((n) => Number.isSafeInteger(n));
    graves[id] = Math.max(...known, Number.isNaN(last) ? now : 0, 0);
    delete next[id];
  }
  // Checked against the index read inside the transaction, so two tabs cannot both exceed it.
  assert(Object.keys(next).length <= limit, limitMessage);
  return { writes, revs, index: next, tombstones: graves };
}
/**
 * The switcher index rebuilt from the stored bodies, for a `meta/index` that is missing or not an
 * object: every body stays listed (an unreadable one with `rev: null`, so it can still be removed).
 * @param {IDBValidKey[]} keys
 * @param {unknown[]} bodies same order as `keys`
 */
export function rebuildIndex(keys, bodies) {
  const out = {};
  keys.forEach((key, i) => {
    if (typeof key !== "string") return;
    const body = bodies[i],
      rev = storedRev(body);
    const fallback = { kind: null, title: key, rev: rev > 0 ? rev : null, bytes: 0, files: 0, drafts: 0, unexported: false, updatedAt: null };
    try {
      out[key] = isObject(body) && rev > 0
        ? indexEntry({ ...body, kind: typeof body.kind === "string" ? body.kind : null, title: typeof body.title === "string" ? body.title : key })
        : fallback;
    } catch {
      out[key] = fallback; // still listed (with its revision) so it can be removed
    }
  });
  return out;
}
/** Read `meta/index` inside `t`, rebuilding it from the bodies when it is missing or damaged. */
function readIndex(t, done) {
  const mounts = t.objectStore("mounts");
  const r = t.objectStore("meta").get("index"),
    keys = mounts.getAllKeys();
  keys.onsuccess = () => {
    const index = r.result;
    // Usable only when every stored body has an entry with a valid revision (or `rev: null`, which only
    // a rebuild writes after finding the body unreadable); otherwise rebuild it from the bodies, so a
    // removal can never run unchecked against a healthy body.
    const listed = (e) => isObject(e) && (e.rev === null || (Number.isSafeInteger(e.rev) && e.rev > 0));
    if (isObject(index) && keys.result.every((k) => typeof k !== "string" || listed(index[k]))) return done(index);
    const all = mounts.getAll();
    all.onsuccess = () => done(rebuildIndex(keys.result, all.result));
  };
}
const storedRev = (body) => (body === undefined ? undefined : Number.isSafeInteger(body?.rev) && body.rev > 0 ? body.rev : NaN);

/** Shared bookkeeping: the revisions this window last read or wrote, and the last index seen. */
class Base {
  constructor() {
    /** @type {Map<string, number>} */
    this.revs = new Map();
    this.index = {};
  }
  /** Write one body, expecting the revision this window last saw (0 when it never existed). */
  write(record) {
    return this.transact({ expect: new Map([[record.id, this.revs.get(record.id) ?? 0]]), put: new Map([[record.id, record]]) });
  }
  remember(record, id) {
    const rev = storedRev(record);
    if (rev === undefined) this.revs.delete(id);
    else this.revs.set(id, rev);
    return record;
  }
}

/** IndexedDB-backed store. Construct with `openVfs()`. */
export class Vfs extends Base {
  constructor(db) {
    super();
    this.db = db;
    this.durable = true;
  }
  close() {
    this.db.close();
  }
  /** Read `meta/active`, `meta/index` and the active body (Scratch when none is recorded). */
  load() {
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = this.db.transaction(["mounts", "meta"], "readonly");
      } catch (e) {
        return reject(e);
      }
      const out = { active: null, index: {}, record: undefined, id: null };
      const meta = t.objectStore("meta");
      const a = meta.get("active");
      a.onsuccess = () => {
        out.active = isObject(a.result) && typeof a.result.mountId === "string" ? a.result.mountId : null;
        out.id = out.active;
        if (!out.id) return;
        const m = t.objectStore("mounts").get(out.id);
        m.onsuccess = () => (out.record = m.result);
      };
      readIndex(t, (index) => (out.index = index));
      t.oncomplete = () => {
        this.index = out.index;
        if (out.id) this.remember(out.record, out.id);
        resolve(out);
      };
      t.onabort = () => reject(t.error ?? new DOMException("Browser storage read aborted", "AbortError"));
    });
  }
  /** Read one body (undefined when absent) and remember its revision. */
  read(id) {
    return new Promise((resolve, reject) => {
      let t, r;
      try {
        t = this.db.transaction("mounts", "readonly");
        r = t.objectStore("mounts").get(id);
      } catch (e) {
        return reject(e);
      }
      t.oncomplete = () => resolve(this.remember(r.result, id));
      t.onabort = () => reject(t.error ?? new DOMException("Browser storage read aborted", "AbortError"));
    });
  }
  /** Re-read the switcher index. */
  list() {
    return new Promise((resolve, reject) => {
      let t, index = {};
      try {
        t = this.db.transaction(["mounts", "meta"], "readonly");
        readIndex(t, (value) => (index = value));
      } catch (e) {
        return reject(e);
      }
      t.oncomplete = () => resolve((this.index = index));
      t.onabort = () => reject(t.error ?? new DOMException("Browser storage read aborted", "AbortError"));
    });
  }
  /**
   * One atomic change: check every expected revision, then write bodies, removals, the index and
   * (optionally) the active pointer, all in a single `readwrite` transaction over `mounts` + `meta`.
   * @param {{expect?: Map<string, number|null>, put?: Map<string, object>, remove?: string[], active?: string}} ops
   * @returns {Promise<Map<string, number>>} the new revision of each written body
   */
  transact(ops) {
    const { expect = new Map(), active } = ops;
    return new Promise((resolve, reject) => {
      let t, failure = null, plan = null;
      try {
        t = this.db.transaction(["mounts", "meta"], "readwrite");
      } catch (e) {
        return reject(e);
      }
      const fail = (e) => {
        failure ??= e;
        try {
          t.abort();
        } catch {
          /* already finishing; onabort reports */
        }
      };
      // Only onabort settles a failure: a request error bubbles to an abort, and t.error is set then.
      t.onabort = () => reject(failure ?? t.error ?? new DOMException("Browser storage transaction aborted", "AbortError"));
      const mounts = t.objectStore("mounts"),
        meta = t.objectStore("meta");
      const ids = [...expect.keys()];
      const found = new Map();
      let index = {},
        tombstones = {},
        pending = ids.length + 2;
      const step = () => {
        if (--pending) return;
        try {
          plan = planTransaction(found, index, ops, tombstones);
          for (const [id, body] of plan.writes) mounts.put(body, id);
          for (const id of ops.remove || []) mounts.delete(id);
          meta.put(plan.index, "index");
          if ((ops.remove || []).length) meta.put(plan.tombstones, "tombstones");
          if (active !== undefined) meta.put({ mountId: active, at: new Date().toISOString() }, "active");
          // Assigned after the writes are queued (the transaction cannot complete before they run).
          t.oncomplete = () => {
            this.index = plan.index;
            for (const [id, rev] of plan.revs) this.revs.set(id, rev);
            for (const id of ops.remove || []) this.revs.delete(id);
            resolve(plan.revs);
          };
        } catch (e) {
          fail(e);
        }
      };
      try {
        for (const id of ids) {
          const r = mounts.get(id);
          r.onsuccess = () => {
            const rev = storedRev(r.result);
            if (rev !== undefined) found.set(id, rev);
            step();
          };
        }
        readIndex(t, (value) => {
          index = value;
          step();
        });
        const g = meta.get("tombstones");
        g.onsuccess = () => {
          tombstones = g.result;
          step();
        };
      } catch (e) {
        fail(e);
      }
    });
  }
}

/** Same interface without durability: bodies live in this window only. */
export class MemoryVfs extends Base {
  constructor() {
    super();
    this.durable = false;
    this.bodies = new Map();
    this.tombstones = {};
    this.active = null;
  }
  close() {}
  async load() {
    const id = this.active;
    return { active: id, id, index: this.index, record: id ? this.remember(this.bodies.get(id), id) : undefined };
  }
  async read(id) {
    return this.remember(this.bodies.get(id), id);
  }
  async list() {
    return this.index;
  }
  async transact(ops) {
    const found = new Map();
    for (const id of (ops.expect || new Map()).keys()) {
      const rev = storedRev(this.bodies.get(id));
      if (rev !== undefined) found.set(id, rev);
    }
    const plan = planTransaction(found, this.index, ops, this.tombstones);
    this.tombstones = plan.tombstones;
    for (const [id, body] of plan.writes) this.bodies.set(id, body);
    for (const id of ops.remove || []) this.bodies.delete(id);
    this.index = plan.index;
    if (ops.active !== undefined) this.active = ops.active;
    for (const [id, rev] of plan.revs) this.revs.set(id, rev);
    for (const id of ops.remove || []) this.revs.delete(id);
    return plan.revs;
  }
}

/**
 * Open (creating on first use) the `carbon-vfs` database.
 * @param {{factory?: IDBFactory, onVersionChange?: () => void}} [options]
 * @returns {Promise<Vfs>}
 */
export function openVfs({ factory = globalThis.indexedDB, onVersionChange } = {}) {
  return new Promise((resolve, reject) => {
    assert(factory && typeof factory.open === "function", "IndexedDB is not available in this browser window");
    const request = factory.open(VFS_NAME, VFS_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result,
        stores = db.objectStoreNames;
      if (!stores.contains("mounts")) db.createObjectStore("mounts");
      if (!stores.contains("meta")) db.createObjectStore("meta");
      // Remembered linked-folder consent, matched with isSameEntry (same shape as before the VFS).
      if (!stores.contains("folders")) db.createObjectStore("folders", { autoIncrement: true });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Browser storage is blocked by another Carbon tab; close the other tab and reload"));
    request.onsuccess = () => {
      const db = request.result;
      // A future version must never be blocked by this window: close and say so.
      db.onversionchange = () => {
        db.close();
        onVersionChange?.();
      };
      resolve(new Vfs(db));
    };
  });
}

/**
 * Whether the pre-VFS database exists, without opening it (`indexedDB.databases()` lists names
 * only). False when the browser cannot tell.
 */
export async function legacyDatabasePresent(factory = globalThis.indexedDB) {
  try {
    if (typeof factory?.databases !== "function") return false;
    return (await factory.databases()).some((d) => d?.name === LEGACY_DB_NAME);
  } catch {
    return false;
  }
}
