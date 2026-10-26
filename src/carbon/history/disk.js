/**
 * On-disk local file history (`carbon-history/1`). No DOM: everything goes through
 * FileSystem Access handles, so the module is testable with an in-memory fake.
 *
 * Layout under the linked folder (see docs/local-history.md):
 *   .carbon-history/README.txt
 *   .carbon-history/carbon-history.json
 *   .carbon-history/versions/<original/dir>/<base>.<savedAt>.<hash6>[.m<modified>][<ext>]
 *
 * Every snapshot is a complete copy of the user's file. Nothing here is required to restore:
 * a person can copy a snapshot back by hand. The directory is the source of truth; no index
 * exists, so an interrupted write can never hide a valid snapshot.
 */
import { assert, path, equal, encode, decode, LIMITS } from "../../core/validate.js";
import { writeTarFiles } from "../../archives/tar.js";

export const HISTORY_DIR = ".carbon-history";
export const FORMAT = "carbon-history/1";
const MANIFEST = "carbon-history.json";
const README = "README.txt";
const VERSIONS = "versions";
const DAY = 86_400_000;
/** First 6 hex digits of SHA-256 of zero bytes: the only hash a 0-byte snapshot may carry. */
const EMPTY_HASH = "e3b0c4";
const NAME = /^(.+)\.(\d{8}T\d{9}Z)\.([0-9a-f]{6})(?:\.m(\d{8}T\d{9}Z))?(\.[^.]+)?$/;

const README_TEXT = `This folder is Carbon's local file history for this folder.

What it is
  Before Carbon replaces one of your files on disk, it first copies the previous
  version in here. Every file under "versions" is a COMPLETE earlier version of
  one of your files (not a diff). It contains nothing else of yours, and nothing
  is uploaded anywhere.

How to find a version
  Snapshots mirror the original path:
    versions/notes/plan.md
  is kept as
    versions/notes/plan.20260315T142530123Z.a1b2c3.md
  The long number is the UTC time the copy was saved (year, month, day, "T",
  hour, minute, second, millisecond, "Z"); the six characters after it are the
  start of the file's SHA-256 hash. A ".m<time>" part, when present, is the
  file's own last-modified time. Newest time wins.

How to restore by hand
  Copy the version you want out of "versions", rename it to the original name
  (drop the time and hash parts) and put it back where the original lives.
  Carbon is not needed. Copy rather than move if you want to keep the history.

Housekeeping
  Carbon deletes versions older than the retention period and the oldest ones
  once the folder grows past its size limit, but always keeps the newest version
  of every file. Settings are in ${MANIFEST}. It is safe to delete this
  whole folder if you do not want the history; version control (git) ignores
  nothing here unless you add ${HISTORY_DIR}/ to your ignore file.

Format: ${FORMAT}
`;

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, "");
const unstamp = (s) =>
  Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15), +s.slice(15, 18));
const notFound = (e) => e?.name === "NotFoundError";
/**
 * Newest `savedAt` handed out per linked-folder handle in this page session. The app opens a fresh
 * DiskHistory for every save, so the monotonic counter must outlive the instance; otherwise two
 * different contents saved in the same millisecond (or after a clock rollback) would tie or sort
 * behind older snapshots.
 */
const clocks = new WeakMap();
const clockFor = (root) => {
  if (root === null || (typeof root !== "object" && typeof root !== "function")) return { last: 0 };
  let c = clocks.get(root);
  if (!c) clocks.set(root, (c = { last: 0 }));
  return c;
};

async function hash6(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 3), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validate a user-supplied original path (shared by preserve/list). */
function original(p) {
  path(p);
  assert(
    p.toLowerCase().split("/")[0] !== HISTORY_DIR,
    "Local history cannot snapshot its own folder",
  );
  const name = p.slice(p.lastIndexOf("/") + 1);
  assert(!/\.m\d{8}T\d{9}Z$/.test(name), "Unsupported file name for local history");
  return p;
}
function splitName(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}
const snapshotName = (name, savedAt, hash, modified) => {
  const [base, ext] = splitName(name);
  return `${base}.${stamp(savedAt)}.${hash}${modified === null ? "" : `.m${stamp(modified)}`}${ext}`;
};
/** Parse a snapshot file name; null when it is not one of ours. */
function parseName(file) {
  const m = NAME.exec(file);
  if (!m) return null;
  return {
    name: m[1] + (m[5] ?? ""),
    savedAt: unstamp(m[2]),
    hash: m[3],
    modified: m[4] ? unstamp(m[4]) : null,
  };
}

async function writeVerified(dir, name, bytes) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
  const stored = await handle.getFile();
  assert(stored.size === bytes.length, "Backup verification failed: size mismatch");
  assert(
    equal(new Uint8Array(await stored.arrayBuffer()), bytes),
    "Backup verification failed: content mismatch",
  );
}

async function readText(dir, name) {
  const file = await (await dir.getFileHandle(name)).getFile();
  assert(file.size <= LIMITS.text, `${name} is too large`);
  return decode(new Uint8Array(await file.arrayBuffer()));
}

/**
 * Open (creating if needed) the history directory under a linked folder.
 * With `create: false` nothing is ever written: a missing directory yields an empty history
 * (`list()` is `[]`, `exportArchive()` throws "No local history yet"), so browsing or
 * exporting works with read-only access and never adds `.carbon-history/` to the folder.
 * @param {FileSystemDirectoryHandle} rootHandle  readwrite handle of the linked folder (read-only is enough with `create: false`)
 * @param {{retentionDays?: number, maxBytes?: number, now?: () => number, create?: boolean}} [options]
 * @returns {Promise<DiskHistory>}
 * @throws {Error} when the directory cannot be created or the manifest format is unsupported
 */
export async function openDiskHistory(
  rootHandle,
  { retentionDays = 30, maxBytes = 100 * 1024 * 1024, now = () => Date.now(), create = true } = {},
) {
  assert(retentionDays > 0 && !Number.isNaN(retentionDays), "retentionDays must be positive");
  assert(maxBytes > 0 && !Number.isNaN(maxBytes), "maxBytes must be positive");
  let dir;
  try {
    if (create) {
      // Carbon writes only into a history directory it created. A folder entry whose name differs only by
      // case may be the same directory on a case-insensitive filesystem (or someone else's): refused.
      for await (const [name] of rootHandle.entries())
        if (name !== HISTORY_DIR && name.toUpperCase() === HISTORY_DIR.toUpperCase()) // the fold caseCollision uses
          throw new Error(`The folder has "${name}", which differs from ${HISTORY_DIR} only by case; Carbon keeps local history only in a ${HISTORY_DIR} directory it created and wrote nothing`);
      dir = await rootHandle.getDirectoryHandle(HISTORY_DIR, { create: true });
    } else {
      try {
        dir = await rootHandle.getDirectoryHandle(HISTORY_DIR);
      } catch (e) {
        if (!notFound(e)) throw e;
        return new DiskHistory(null, { retentionDays, maxBytes, now, clock: clockFor(rootHandle) });
      }
    }
    let manifest = null;
    try {
      manifest = await readText(dir, MANIFEST);
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    if (manifest === null) {
      if (!create) return new DiskHistory(dir, { retentionDays, maxBytes, now, clock: clockFor(rootHandle) });
      // No manifest: initialise only a directory that is empty, or holds nothing but Carbon's own README from
      // an interrupted initialisation. Anything else is not Carbon's and is never overwritten.
      const foreign = [];
      for await (const [name, handle] of dir.entries()) {
        let ours = false;
        if (name === README && handle.kind === "file") {
          const file = await handle.getFile();
          ours = file.size <= LIMITS.text && equal(new Uint8Array(await file.arrayBuffer()), encode(README_TEXT));
        }
        if (!ours) foreign.push(name);
      }
      if (foreign.length)
        throw new Error(
          `${HISTORY_DIR}/ already exists in the folder but was not created by Carbon (no ${MANIFEST}; it holds ${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ` and ${foreign.length - 3} more` : ""}). Carbon does not write into it and changed nothing; rename or move it to use local history`,
        );
      // README first: a visible explanation exists even if the manifest write is interrupted.
      await writeVerified(dir, README, encode(README_TEXT));
      await writeVerified(
        dir,
        MANIFEST,
        encode(
          JSON.stringify(
            {
              format: FORMAT,
              created: new Date(now()).toISOString(),
              retention: {
                days: retentionDays === Infinity ? null : retentionDays,
                maxBytes: maxBytes === Infinity ? null : maxBytes,
              },
            },
            null,
            2,
          ) + "\n",
        ),
      );
    } else {
      let parsed;
      try {
        parsed = JSON.parse(manifest);
      } catch {
        throw new Error(`${HISTORY_DIR}/${MANIFEST} is not valid JSON`);
      }
      assert(
        parsed && parsed.format === FORMAT,
        `Unsupported local history format: ${String(parsed?.format)}`,
      );
    }
  } catch (e) {
    if (e?.message?.startsWith("Unsupported local history") || e?.message?.includes("is not valid JSON")) throw e;
    throw new Error(`Local history unavailable: ${e?.message ?? e}`, { cause: e });
  }
  return new DiskHistory(dir, { retentionDays, maxBytes, now, clock: clockFor(rootHandle) });
}

export class DiskHistory {
  #dir;
  #opts;
  #clock;
  #queue = Promise.resolve();
  constructor(dir, opts) {
    this.#dir = dir;
    this.#opts = opts;
    this.#clock = opts.clock ?? { last: 0 };
  }
  /** Serialize operations so prune never races a write on the same instance. */
  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }
  async #versions(create) {
    if (!this.#dir) return null; // opened read-only on a folder without history
    try {
      return await this.#dir.getDirectoryHandle(VERSIONS, { create });
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }
  async #dirFor(parts, create) {
    let dir = await this.#versions(create);
    for (const part of parts) {
      if (!dir) return null;
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    }
    return dir;
  }

  /**
   * Save a complete copy of `bytes` (the on-disk version about to be replaced). Resolves only
   * once the snapshot has been written, closed, re-read and compared byte for byte.
   * @param {string} p  original relative path
   * @param {Uint8Array} bytes
   * @param {{modified?: number}} [meta]  source mtime in ms since epoch
   * @returns {Promise<{id: string, path: string, savedAt: number, size: number}>}
   * @throws {Error} on any failure; no partial snapshot is left visible where cleanup is possible
   */
  preserve(p, bytes, { modified } = {}) {
    return this.#serial(async () => {
      assert(this.#dir, "Local history was opened read-only");
      original(p);
      assert(bytes instanceof Uint8Array, "Backup bytes must be a Uint8Array");
      assert(bytes.length <= LIMITS.file, `File too large for local history: ${p}`);
      if (modified !== undefined) {
        assert(
          Number.isFinite(modified) && modified >= 0 && modified < Date.UTC(10000, 0, 1),
          "Invalid modified time",
        );
        modified = Math.floor(modified);
      }
      const t = this.#opts.now();
      assert(Number.isFinite(t) && t >= 0 && t < Date.UTC(10000, 0, 1), "Invalid clock");
      const hash = await hash6(bytes);
      const parts = p.split("/"),
        name = parts.pop();
      let savedAt = Math.max(Math.floor(t), this.#clock.last + 1);
      // Fail on over-long or too-deep names before touching the disk.
      path(`${HISTORY_DIR}/${VERSIONS}/${[...parts, snapshotName(name, savedAt, hash, modified ?? null)].join("/")}`);
      let result;
      try {
        const dir = await this.#dirFor(parts, true);
        for (let tries = 0; ; tries++) {
          assert(tries < 1000, "Could not choose a unique snapshot name");
          try {
            await dir.getFileHandle(snapshotName(name, savedAt, hash, modified ?? null));
            savedAt++; // same millisecond and content already preserved
          } catch (e) {
            if (!notFound(e)) throw e;
            break;
          }
        }
        const file = snapshotName(name, savedAt, hash, modified ?? null);
        try {
          await writeVerified(dir, file, bytes);
        } catch (e) {
          await dir.removeEntry(file).catch(() => {});
          throw e;
        }
        this.#clock.last = Math.max(this.#clock.last, savedAt);
        result = {
          id: [HISTORY_DIR, VERSIONS, ...parts, file].join("/"),
          path: p,
          savedAt,
          size: bytes.length,
        };
      } catch (e) {
        throw new Error(`Local history backup failed: ${e?.message ?? e}`, { cause: e });
      }
      try {
        await this.#prune(result.id);
      } catch {
        // The snapshot is verified; housekeeping failures never fail the backup.
      }
      return result;
    });
  }

  /**
   * Versions of one original path, newest first, found by reading the directory.
   * Empty files whose name does not carry the empty-content hash (interrupted writes) are skipped.
   * @param {string} p
   * @returns {Promise<{id: string, path: string, savedAt: number, size: number, modified: number|null}[]>}
   */
  async list(p) {
    original(p);
    const parts = p.split("/"),
      name = parts.pop();
    const dir = await this.#dirFor(parts, false);
    if (!dir) return [];
    const out = [];
    for await (const [file, handle] of dir.entries()) {
      if (handle.kind !== "file") continue;
      const info = parseName(file);
      if (!info || info.name !== name) continue;
      const size = (await handle.getFile()).size;
      if (!valid(info, size)) continue;
      out.push({
        id: [HISTORY_DIR, VERSIONS, ...parts, file].join("/"),
        path: p,
        savedAt: info.savedAt,
        size,
        modified: info.modified,
      });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : -1));
  }

  /**
   * Read one snapshot by id and verify it against the hash in its name.
   * @param {string} id  an `id` from list() / preserve()
   * @returns {Promise<Uint8Array>}
   */
  async read(id) {
    path(id);
    const parts = id.split("/");
    assert(
      parts[0] === HISTORY_DIR && parts[1] === VERSIONS && parts.length >= 3,
      "Not a local history snapshot",
    );
    const file = parts.pop();
    const info = parseName(file);
    assert(info, "Not a local history snapshot");
    const dir = await this.#dirFor(parts.slice(2), false);
    assert(dir, "Snapshot not found");
    const stored = await (await dir.getFileHandle(file)).getFile();
    assert(stored.size <= LIMITS.file, "Snapshot too large");
    const bytes = new Uint8Array(await stored.arrayBuffer());
    assert((await hash6(bytes)) === info.hash, "Snapshot is corrupt (hash mismatch)");
    return bytes;
  }

  /**
   * Enforce retention. Never removes the newest verified snapshot of any path; also removes
   * empty/half-written leftovers and snapshots whose content no longer matches the hash in
   * their name (only the newest candidate of each path is read to check this). Unrecognised
   * files are never touched.
   * @returns {Promise<{removed: number}>}
   */
  prune() {
    return this.#serial(() => this.#prune());
  }
  async #scan() {
    const root = await this.#versions(false);
    const items = [];
    if (!root) return items;
    const walk = async (dir, parts) => {
      for await (const [file, handle] of dir.entries()) {
        if (handle.kind === "directory") {
          await walk(handle, [...parts, file]);
          continue;
        }
        const info = parseName(file);
        if (!info) continue;
        const size = (await handle.getFile()).size;
        items.push({
          dir,
          file,
          id: [HISTORY_DIR, VERSIONS, ...parts, file].join("/"),
          path: [...parts, info.name].join("/"),
          savedAt: info.savedAt,
          size,
          ok: valid(info, size),
        });
      }
    };
    await walk(root, []);
    return items;
  }
  /** True when the stored bytes still hash to the value in the snapshot's name. */
  async #intact(it) {
    try {
      const stored = await (await it.dir.getFileHandle(it.file)).getFile();
      if (stored.size > LIMITS.file) return false;
      return (await hash6(new Uint8Array(await stored.arrayBuffer()))) === parseName(it.file).hash;
    } catch (e) {
      if (notFound(e)) return false;
      throw e;
    }
  }
  /** @param {string} [protectedId]  snapshot that was just verified by preserve(); never pruned */
  async #prune(protectedId) {
    const { retentionDays, maxBytes, now } = this.#opts;
    const items = await this.#scan();
    // A name and a size do not prove a snapshot is readable: a truncated backup whose cleanup
    // failed looks valid. Protection must go to a snapshot whose content is verified, so check
    // the newest candidate of each path and fall back to the next one when it is corrupt.
    const byPath = new Map();
    for (const it of items)
      if (it.ok) byPath.set(it.path, [...(byPath.get(it.path) ?? []), it]);
    const newest = new Map();
    for (const [p, group] of byPath) {
      group.sort((a, b) => b.savedAt - a.savedAt || (a.file < b.file ? 1 : -1));
      for (const it of group) {
        if (it.id === protectedId || (await this.#intact(it))) {
          newest.set(p, it);
          break;
        }
        it.ok = false; // corrupt: doomed like an empty leftover
      }
    }
    const doomed = new Set(items.filter((it) => !it.ok));
    const cutoff = now() - retentionDays * DAY;
    const keep = (it) => newest.get(it.path) === it || it.id === protectedId;
    for (const it of items) if (it.ok && it.savedAt < cutoff && !keep(it)) doomed.add(it);
    let total = 0;
    for (const it of items) if (it.ok && !doomed.has(it)) total += it.size;
    const oldest = items
      .filter((it) => it.ok && !doomed.has(it) && !keep(it))
      .sort((a, b) => a.savedAt - b.savedAt || (a.file < b.file ? -1 : 1));
    for (const it of oldest) {
      if (total <= maxBytes) break;
      doomed.add(it);
      total -= it.size;
    }
    let removed = 0;
    for (const it of doomed) {
      try {
        await it.dir.removeEntry(it.file);
        removed++;
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    }
    if (removed) await this.#sweep();
    return { removed };
  }
  /** Remove empty directories under versions/ (best effort). */
  async #sweep() {
    const root = await this.#versions(false);
    if (!root) return;
    const walk = async (dir) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "directory") continue;
        await walk(handle);
        let empty = true;
        for await (const _ of handle.entries()) {
          empty = false;
          break;
        }
        if (empty) await dir.removeEntry(name).catch(() => {});
      }
    };
    await walk(root).catch(() => {});
  }

  /**
   * TAR of the whole history directory (root `carbon-history`: README.txt, carbon-history.json,
   * versions/…), newest snapshots first. Carbon's TAR limits are 32 MiB total, so a larger
   * history is truncated oldest-first and the archive then contains EXPORT-INCOMPLETE.txt
   * naming every omitted snapshot; the on-disk folder is never changed.
   * @returns {Promise<Uint8Array>}
   */
  exportArchive() {
    return this.#serial(async () => {
      assert(this.#dir, "No local history yet");
      const files = new Map();
      for (const name of [README, MANIFEST]) {
        try {
          const f = await (await this.#dir.getFileHandle(name)).getFile();
          files.set(name, new Uint8Array(await f.arrayBuffer()));
        } catch (e) {
          if (!notFound(e)) throw e;
        }
      }
      let total = [...files.values()].reduce((n, b) => n + b.length, 0);
      const items = (await this.#scan()).filter((it) => it.ok).sort((a, b) => b.savedAt - a.savedAt);
      const omitted = [];
      const budget = LIMITS.total - 64 * 1024,
        slots = LIMITS.files - 16; // members = files + directories; leave room for the note
      const dirs = new Set(["versions"]);
      const fresh = (rel) => {
        const out = [];
        const parts = rel.split("/");
        for (let i = 1; i < parts.length; i++) {
          const d = parts.slice(0, i).join("/");
          if (!dirs.has(d)) out.push(d);
        }
        return out;
      };
      for (const it of items) {
        const rel = relative(it);
        let safe = true;
        try {
          path(rel);
        } catch {
          safe = false;
        }
        const added = safe ? fresh(rel) : [];
        if (!safe || files.size + dirs.size + added.length + 1 > slots || total + it.size > budget) {
          omitted.push(rel);
          continue;
        }
        for (const d of added) dirs.add(d);
        const f = await (await it.dir.getFileHandle(it.file)).getFile();
        files.set(rel, new Uint8Array(await f.arrayBuffer()));
        total += it.size;
      }
      if (omitted.length)
        files.set(
          "EXPORT-INCOMPLETE.txt",
          encode(
            `This export is incomplete: the history is larger than Carbon's archive limits.\nThe following snapshots are still in ${HISTORY_DIR}/ on disk but are not in this archive:\n\n${omitted.join("\n")}\n`,
          ),
        );
      return writeTarFiles(files, dirs, "carbon-history");
    });
  }
}

function valid(info, size) {
  return size <= LIMITS.file && (size > 0 || info.hash === EMPTY_HASH);
}
/** Path of a scanned snapshot relative to the history directory (`versions/<dir>/<file>`). */
function relative(it) {
  const parts = it.path.split("/");
  parts.pop();
  return [VERSIONS, ...parts, it.file].join("/");
}
