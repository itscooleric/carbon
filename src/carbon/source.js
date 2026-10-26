/**
 * Source adapter for linked folders (RFC #25 rev 3, A3): the folder on disk is an explicitly
 * chosen source and optional Sync target, never an authority over the virtual working copy.
 *
 * Three records live on `state.link` beside the handle and consent:
 *  - `baseline`: Map<path, {shadow?: Uint8Array}>. A key exists iff the path was imported from or
 *    synced to the folder (and not re-baselined away since). `baselineBytes(p)` is the bytes the
 *    folder held then: the virtual bytes while they still match, otherwise the `shadow` copy that
 *    `trackBaseline` stores at the first virtual divergence. A key with a shadow and no virtual
 *    file is "deleted in Carbon".
 *  - `observed`: the most recent read-only snapshot of the folder (`observe`): per-path size,
 *    modified time, whether the disk bytes equal the baseline, and the disk bytes where they differ
 *    (captured up to `CAPTURE_LIMIT` in total, with the shadows). Replaced wholesale by each Refresh;
 *    never consulted to change `files`.
 *  - per-path state (`sourceState`) is a pure function of `files`, `baseline` and `observed`.
 *
 * Nothing here writes to disk or to the store; the explicit actions return candidate fields for
 * one `deps.commit`. DOM-free; Node tests run it with the fake handles of tests/linked-fake-fs.js.
 */
import { assert, equal, LIMITS, path as validPath } from "../core/validate.js";
import { LocalFolder } from "./local-files.js";
import { readDirectoryFiles } from "./fs.js";

/** Every state `sourceState` can return, with its text and glyph (never colour alone). */
export const SOURCE_STATES = Object.freeze({
  virtual: { glyph: "◌", label: "Only in Carbon" },
  synced: { glyph: "✓", label: "Same as folder" },
  matched: { glyph: "✓", label: "Same as folder, not recorded as synced" },
  modified: { glyph: "●", label: "Edited in Carbon, not synced" },
  externalChange: { glyph: "⇣", label: "Changed in folder" },
  conflict: { glyph: "⚠", label: "Changed in folder and in Carbon" },
  missing: { glyph: "∅", label: "Missing from folder" },
  deletedInCarbon: { glyph: "⌫", label: "Deleted in Carbon" },
  incoming: { glyph: "+", label: "New in folder" },
});
/**
 * The folder as Carbon knows it once `writes` (path -> new size) are in it and in the baseline: every
 * baseline path (files deleted only in Carbon included, at their baseline size), every file the last
 * Refresh saw, the directories it saw and every parent directory of those paths. `entries` counts files
 * and directories together, as `readDirectoryFiles` does for its limit.
 * @param {Map<string, number>} writes
 * @returns {{entries: number, bytes: number}}
 */
export function knownFolder(link, stack, writes = new Map()) {
  const sizes = new Map();
  for (const [p, e] of link.observed?.entries ?? []) sizes.set(p, e.size);
  // The larger of what the last Refresh saw and the baseline: either may be what the folder holds now.
  for (const p of link.baseline.keys()) sizes.set(p, Math.max(sizes.get(p) ?? 0, baselineBytes(link, stack, p)?.length ?? 0));
  for (const [p, n] of writes) sizes.set(p, n);
  const dirs = new Set(link.observed?.directories ?? []);
  for (const p of sizes.keys()) for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i));
  let bytes = 0;
  for (const n of sizes.values()) bytes += n;
  return { entries: sizes.size + dirs.size, bytes };
}
/**
 * Refuse when `writes` would take `knownFolder` past the folder limits: the folder stays one Carbon can
 * read back, and the baseline records (shadows of files deleted only in Carbon) stay bounded. Every
 * builder here that adds or re-sizes a baseline entry (Import, Take folder version, Keep mine / Keep
 * both) calls it, as Sync does before writing; Accept move and Restore only reuse an existing entry.
 */
export function assertCapacity(link, stack, writes, action, unchanged) {
  const { entries, bytes } = knownFolder(link, stack, writes);
  assert(
    entries <= LIMITS.files && bytes <= LIMITS.total,
    `${action} would take the folder, as Carbon knows it, past Carbon's folder limits (${LIMITS.files} files and folders, ${LIMITS.total / 1024 ** 2} MiB, counting files deleted only in Carbon). ${unchanged} Forget deleted files you no longer need (Folder changes…) or export a copy.`,
  );
}
/** Shadows plus captured disk bytes kept per linked workspace (rev 2 D8: 8 MiB per root). */
export const CAPTURE_LIMIT = 8 * 1024 ** 2;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isBytes = (v) => v instanceof Uint8Array && v.length <= LIMITS.file;
const safePath = (p) => {
  try {
    return typeof p === "string" && validPath(p) === p;
  } catch {
    return false;
  }
};

// ---- baseline ------------------------------------------------------------------------------------

/** The baseline for a folder just imported: every file is as on disk, no shadows. */
export function importedBaseline(stack) {
  return new Map([...stack.files.keys()].map((p) => [p, {}]));
}
/**
 * Bytes the folder held for `p` when it was last imported or synced, or undefined when Carbon has
 * never seen `p` on disk (a `virtual` path).
 */
export function baselineBytes(link, stack, p) {
  const entry = link?.baseline?.get(p);
  if (!entry) return undefined;
  return entry.shadow ?? stack.files.get(p);
}
/** Bytes of every shadow (for the capture budget and the Workspaces listing). */
export function shadowBytes(baseline) {
  let n = 0;
  for (const e of baseline?.values() ?? []) n += e.shadow?.length ?? 0;
  return n;
}
/**
 * The baseline after a virtual change `before` → `after` (the hook in `deps.commit`): a baseline
 * path whose bytes change or vanish keeps its pre-change bytes as the shadow; the first divergence
 * is kept across later edits; a path edited back to exactly its baseline bytes drops the shadow.
 * Paths are never added (only Import, Accept move and Sync do that) and never removed (only
 * explicit actions do). Returns the same Map when nothing changes.
 */
export function trackBaseline(baseline, before, after) {
  let next = null;
  for (const [p, entry] of baseline) {
    const now = after.files.get(p);
    if (entry.shadow) {
      if (now && equal(now, entry.shadow)) (next ??= new Map(baseline)).set(p, {});
      continue;
    }
    const was = before.files.get(p);
    if (!was) continue; // an entry without a shadow always has a virtual file; tolerate a damaged record
    if (!now || !equal(was, now)) (next ??= new Map(baseline)).set(p, { shadow: was });
  }
  return next ?? baseline;
}

// ---- observation ---------------------------------------------------------------------------------

/**
 * Read the folder (read permission only; `.carbon-history` skipped) and describe it against the
 * baseline. Captures bytes only where the disk differs from the baseline or the path is new, and
 * only while shadows plus captures stay within `limit`; beyond that an entry is recorded with
 * `captured: false` (size and time only). Reads nothing into `files`; the result is the whole
 * `link.observed` for one `deps.commit({ link })`.
 * @param {FileSystemDirectoryHandle} handle
 * @param {{baseline: Map<string, {shadow?: Uint8Array}>}} link
 * @param {import("./types.js").Documents} stack
 * @param {{now?: () => Date, limit?: number}} [options]
 * @returns {Promise<Observed>}
 */
export async function observe(handle, link, stack, options = {}) {
  return describeFolder(await readDirectoryFiles(handle), link, stack, options);
}
/**
 * The observation for a folder already read (`readDirectoryFiles` result): the folder open uses the
 * read it imports from, so the first observation costs no second read.
 * @param {{files: [string, Uint8Array][], directories: string[], modified?: Map<string, number>}} read
 * @returns {Observed}
 */
export function describeFolder(read, link, stack, { now = () => new Date(), limit = CAPTURE_LIMIT } = {}) {
  const entries = new Map();
  let budget = limit - shadowBytes(link.baseline);
  for (const [p, bytes] of read.files) {
    const base = baselineBytes(link, stack, p);
    const same = base !== undefined && equal(bytes, base);
    const entry = { size: bytes.length, modified: read.modified?.get(p) ?? null, same, captured: same };
    if (!same && bytes.length <= budget) {
      entry.bytes = bytes;
      entry.captured = true;
      budget -= bytes.length;
    }
    entries.set(p, entry);
  }
  return { at: now().toISOString(), directories: [...read.directories], entries };
}
/**
 * @typedef {Object} Observed
 * @property {string} at ISO time of the read
 * @property {string[]} directories every directory on disk
 * @property {Map<string, ObservedEntry>} entries every file on disk
 */
/**
 * @typedef {Object} ObservedEntry
 * @property {number} size
 * @property {number|null} modified `File.lastModified`
 * @property {boolean} same disk bytes equal the baseline bytes
 * @property {boolean} captured `bytes` holds the disk bytes (always true when `same`)
 * @property {Uint8Array} [bytes] disk bytes, when they differ and were captured
 */

// ---- per-path state ---------------------------------------------------------------------------------

/**
 * State of `p` from `files`, `baseline` and `observed` (pure). A null `observed` (never read, or a
 * damaged record) is treated as "disk still equals the baseline", which only ever reads as
 * synced / modified / virtual and offers no disk-derived action.
 * @returns {keyof typeof SOURCE_STATES}
 */
export function sourceState(link, stack, p) {
  const virtual = stack.files.get(p);
  const entry = link.baseline.get(p);
  const seen = link.observed?.entries.get(p) ?? null;
  const observed = Boolean(link.observed);
  if (!virtual) {
    if (entry?.shadow) return "deletedInCarbon";
    return seen ? "incoming" : "virtual"; // an absent, unobserved path only reaches here from a damaged record
  }
  if (!entry) {
    // A path Carbon never saw on disk. The folder holding one too is a collision, unless the bytes agree.
    if (!seen) return "virtual";
    return seen.bytes && equal(seen.bytes, virtual) ? "matched" : "conflict";
  }
  const diverged = Boolean(entry.shadow);
  if (!observed) return diverged ? "modified" : "synced";
  if (!seen) return "missing";
  if (seen.same) return diverged ? "modified" : "synced";
  if (!diverged) return "externalChange";
  return seen.bytes && equal(seen.bytes, virtual) ? "matched" : "conflict";
}
/**
 * Every path with a source state: virtual files, deleted-in-Carbon shadows and incoming disk files,
 * sorted. `moveTo` names the incoming path whose bytes equal a missing path's baseline exactly
 * (D25); `movedFrom` is the reverse; `gone` marks a deleted-in-Carbon path no longer on disk;
 * `captured: false` marks an observed difference whose bytes were not captured.
 * @returns {{path: string, state: keyof typeof SOURCE_STATES, moveTo?: string, movedFrom?: string, gone?: boolean, captured?: boolean}[]}
 */
export function sourceRows(link, stack, { moves = true } = {}) {
  const paths = new Set([...stack.files.keys(), ...link.baseline.keys(), ...(link.observed?.entries.keys() ?? [])]);
  const rows = [...paths].sort().map((p) => ({ path: p, state: sourceState(link, stack, p) }));
  // Exact-byte move candidates, indexed once by size and hash so a large folder costs one pass over its bytes
  // (equal() still confirms every match).
  const incoming = new Map();
  if (moves)
    for (const r of rows) {
      const bytes = r.state === "incoming" ? link.observed.entries.get(r.path)?.bytes : undefined;
      if (!bytes) continue;
      const key = bytesKey(bytes);
      if (!incoming.has(key)) incoming.set(key, []);
      incoming.get(key).push(r);
    }
  for (const row of rows) {
    const seen = link.observed?.entries.get(row.path);
    if (seen && !seen.same && !seen.captured) row.captured = false;
    if (row.state === "deletedInCarbon" && link.observed && !seen) row.gone = true;
    if (row.state !== "missing" || !incoming.size) continue;
    const base = baselineBytes(link, stack, row.path);
    const target = (incoming.get(bytesKey(base)) ?? []).find((r) => !r.movedFrom && equal(link.observed.entries.get(r.path).bytes, base));
    if (target) {
      row.moveTo = target.path;
      target.movedFrom = row.path;
    }
  }
  return rows;
}
/** Size plus FNV-1a hash: a cheap index key for exact-byte comparison (never a substitute for it). */
function bytesKey(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return `${bytes.length}:${h >>> 0}`;
}
/**
 * Counts for the status line and the switcher index (no move detection: counts only). Memoised on the
 * identities of `stack`, `baseline` and `observed`, which every change replaces: an Editor keystroke (a
 * draft) changes none of them, so status renders do not rescan file bytes.
 */
const summaries = new WeakMap();
export function sourceSummary(link, stack) {
  const hit = summaries.get(stack);
  if (hit && hit.baseline === link.baseline && hit.observed === link.observed) return hit.result;
  const result = summarise(link, stack);
  summaries.set(stack, { baseline: link.baseline, observed: link.observed, result });
  return result;
}
function summarise(link, stack) {
  const counts = {};
  let missingEdited = 0;
  for (const { path, state } of sourceRows(link, stack, { moves: false })) {
    counts[state] = (counts[state] || 0) + 1;
    if (state === "missing" && link.baseline.get(path)?.shadow) missingEdited++;
  }
  // Carbon-side edits the folder does not have: a missing file edited in Carbon counts here and as external.
  const unsynced = (counts.virtual || 0) + (counts.modified || 0) + (counts.conflict || 0) + (counts.deletedInCarbon || 0) + (counts.matched || 0) + missingEdited;
  // Differences the folder holds that Carbon's copy does not (a conflict counts on both sides).
  const external = (counts.incoming || 0) + (counts.externalChange || 0) + (counts.conflict || 0) + (counts.missing || 0);
  return { counts, unsynced, external };
}

// ---- explicit actions (candidate builders; nothing is committed here) ---------------------------------

/** The disk bytes `observed` holds for `p` (captured), or throws with the reason. */
export function observedBytes(link, p) {
  const seen = link.observed?.entries.get(p);
  assert(seen, `${p} was not in the folder at the last Refresh. Refresh from folder first.`);
  assert(seen.bytes || seen.same, `The folder's version of ${p} was not captured at the last Refresh (it is larger than the capture budget). Reload from disk reads the folder again.`);
  return seen.bytes ?? undefined;
}
const revision = (stack) => ({ ...stack.manifest, revision: stack.manifest.revision + 1 });
/**
 * Next LocalFolder with `writes` applied (and `deletes` / `moves`), built directly so disk bytes that
 * are not valid Markdown text are carried exactly as a folder open carries them.
 */
function rebuild(stack, { writes = new Map(), deletes = [], moves = [], directories = stack.directories } = {}) {
  const files = new Map(stack.files);
  for (const [from, to] of moves) {
    assert(files.has(from) && !files.has(to), "Invalid move target");
    files.set(to, files.get(from));
    files.delete(from);
  }
  for (const p of deletes) files.delete(p);
  for (const [p, bytes] of writes) files.set(p, bytes);
  return new LocalFolder(files, directories, revision(stack));
}
/**
 * `stack` with `p` set to exactly `bytes` as a new revision, built like a folder open (not through
 * `change`, whose Markdown check is for Editor writes): folder bytes or a disk-history snapshot that is
 * not valid text is carried read-only. Path, file, total and count bounds still apply.
 */
export function withBytes(stack, p, bytes) {
  return rebuild(stack, { writes: new Map([[p, bytes]]) });
}
/** `link` with the given baseline / observed replaced (other fields untouched). */
const withSource = (link, fields) => ({ ...link, ...fields });
/** `observed` with `p` marked as equal to the (new) baseline, keeping its size and time. */
function markSame(observed, p, bytes, modified) {
  if (!observed) return observed;
  const entries = new Map(observed.entries);
  entries.set(p, { size: bytes.length, modified: modified ?? entries.get(p)?.modified ?? null, same: true, captured: true });
  return { ...observed, entries };
}

/**
 * Import incoming disk files `paths` as virtual files with a fresh baseline (D24: only on request).
 * Parent directories are created; a case-insensitive or file/directory collision with the virtual
 * tree is refused by `LocalFolder` validation with both names in the message.
 * @param {string[]} paths incoming paths (bytes from `observed`)
 * @returns {{stack: LocalFolder, link: object}}
 */
export function importIncoming(link, stack, paths) {
  const writes = new Map();
  for (const p of paths) {
    assert(sourceState(link, stack, p) === "incoming", `${p} is not a new file in the folder.`);
    writes.set(p, observedBytes(link, p));
  }
  assertCapacity(link, stack, new Map([...writes].map(([p, b]) => [p, b.length])), `Importing ${paths.length === 1 ? paths[0] : `${paths.length} files`}`, "Nothing was imported.");
  const next = collisionChecked(() => rebuild(stack, { writes }), stack, paths);
  const baseline = new Map(link.baseline);
  let observed = link.observed;
  for (const p of paths) {
    baseline.set(p, {});
    observed = markSame(observed, p, writes.get(p));
  }
  return { stack: next, link: withSource(link, { baseline, observed }) };
}
/** Run `build`; a path collision is reported with the colliding virtual name. */
function collisionChecked(build, stack, paths) {
  try {
    return build();
  } catch (e) {
    const m = /^Path collision: (.+)$/.exec(e?.message || "");
    if (!m) throw e;
    const key = m[1].toUpperCase();
    const other = [...stack.files.keys(), ...stack.directories].find((q) => q.toUpperCase() === key || key.startsWith(q.toUpperCase() + "/") || q.toUpperCase().startsWith(key + "/"));
    throw new Error(`${m[1]} collides with ${other ?? "an existing path"} in Carbon (names that differ only by case, or a file and a folder of the same name, cannot both exist). Rename one of them first; nothing was imported.`);
  }
}
/**
 * Replace the virtual bytes of `p` with `bytes` just re-read from disk (Reload from disk / Take disk
 * version, after confirmation). The caller pushes the previous revision to History. The baseline
 * becomes `bytes` (shadow dropped). A draft is the caller's concern (kept, unless it equals `bytes`).
 * @returns {{stack: LocalFolder, link: object}}
 */
export function takeDisk(link, stack, p, bytes, modified = null) {
  assert(stack.files.has(p), `Not a file in Carbon: ${p}`);
  assert(isBytes(bytes), "Nothing to reload");
  assertCapacity(link, stack, new Map([[p, bytes.length]]), `Taking the folder's version of ${p}`, "Nothing was taken.");
  const next = equal(stack.files.get(p), bytes) ? stack : rebuild(stack, { writes: new Map([[p, bytes]]) });
  const baseline = new Map(link.baseline);
  baseline.set(p, {});
  return { stack: next, link: withSource(link, { baseline, observed: markSame(link.observed, p, bytes, modified) }) };
}
/**
 * Keep mine: the virtual bytes stay; the folder's observed version becomes the acknowledged baseline
 * (shadow := disk bytes), so the file reads `modified` and a later Sync re-checks the folder against
 * exactly this version (a change after this decision is refused, G6).
 * @returns {{link: object}}
 */
export function keepMine(link, stack, p) {
  assert(sourceState(link, stack, p) === "conflict", `${p} has no conflict to resolve.`);
  const disk = observedBytes(link, p);
  assertCapacity(link, stack, new Map([[p, disk.length]]), `Keeping your version of ${p}`, "Nothing was changed.");
  const baseline = new Map(link.baseline);
  baseline.set(p, { shadow: disk });
  return { link: withSource(link, { baseline, observed: markSame(link.observed, p, disk) }) };
}
/** The virtual name for the folder's version of `p` kept beside Carbon's: `<name>.folder.<ext>`. */
export function keepBothName(stack, p) {
  const dot = p.lastIndexOf("."), slash = p.lastIndexOf("/");
  const [stem, ext] = dot > slash + 1 ? [p.slice(0, dot), p.slice(dot)] : [p, ""];
  for (let i = 0; i < 100; i++) {
    const q = `${stem}.folder${i ? i + 1 : ""}${ext}`;
    const key = q.toUpperCase();
    if (![...stack.files.keys(), ...stack.directories].some((x) => x.toUpperCase() === key)) return q;
  }
  throw new Error(`Could not find a free name for the folder's version of ${p}.`);
}
/**
 * Keep both: the folder's version is saved as a new virtual file next to Carbon's (`keepBothName`),
 * then Keep mine applies. The new file is `virtual` (never on disk under that name).
 * @returns {{stack: LocalFolder, link: object, path: string}}
 */
export function keepBoth(link, stack, p) {
  const { link: kept } = keepMine(link, stack, p);
  const q = keepBothName(stack, p);
  const next = rebuild(stack, { writes: new Map([[q, observedBytes(link, p)]]) });
  return { stack: next, link: kept, path: q };
}
/**
 * Accept move (D25): the missing path `from` is renamed to the incoming path `to`, allowed only when
 * the incoming bytes equal the baseline bytes of `from` exactly. The baseline key moves with it; a
 * virtual edit of `from` (its shadow) is kept under `to`.
 * @returns {{stack: LocalFolder, link: object}}
 */
export function acceptMove(link, stack, from, to) {
  const row = sourceRows(link, stack).find((r) => r.path === from);
  assert(row?.state === "missing" && row.moveTo === to, `${from} was not moved to ${to} in the folder (the bytes must match exactly).`);
  const next = collisionChecked(() => rebuild(stack, { moves: [[from, to]] }), stack, [to]);
  const baseline = new Map(link.baseline);
  const entry = baseline.get(from);
  baseline.delete(from);
  baseline.set(to, entry);
  const disk = link.observed.entries.get(to);
  return { stack: next, link: withSource(link, { baseline, observed: markSame(link.observed, to, disk.bytes, disk.modified) }) };
}
/**
 * Restore a deleted-in-Carbon path from its shadow as a virtual file. The restored bytes are the
 * baseline's, so the path reads `synced`, `externalChange` or `missing` by what the folder holds
 * now. Refused when a newer virtual path collides.
 * @returns {{stack: LocalFolder, link: object}}
 */
export function restoreDeleted(link, stack, p) {
  assert(sourceState(link, stack, p) === "deletedInCarbon", `${p} is not deleted in Carbon.`);
  const bytes = link.baseline.get(p).shadow;
  const next = collisionChecked(() => rebuild(stack, { writes: new Map([[p, bytes]]) }), stack, [p]);
  const baseline = new Map(link.baseline);
  baseline.set(p, {});
  return { stack: next, link: withSource(link, { baseline }) };
}
/**
 * Forget a deleted-in-Carbon shadow (empties the "Deleted in Carbon" list for `p`): the path becomes
 * unknown to the baseline; the folder is untouched. History still holds the bytes.
 */
export function forgetDeleted(link, stack, p) {
  assert(sourceState(link, stack, p) === "deletedInCarbon", `${p} is not deleted in Carbon.`);
  const shadow = link.baseline.get(p).shadow;
  const baseline = new Map(link.baseline);
  baseline.delete(p);
  // An observation that the folder still held the baseline carried no bytes (`same`); with the baseline
  // gone the path reads `incoming`, so its bytes (the shadow) move into the observation for Import/Open.
  let observed = link.observed;
  const seen = observed?.entries.get(p);
  if (seen?.same) {
    const entries = new Map(observed.entries);
    entries.set(p, { ...seen, same: false, captured: true, bytes: shadow });
    observed = { ...observed, entries };
  }
  return { link: withSource(link, { baseline, observed }) };
}
/**
 * Whether a History snapshot holds exactly the deleted-in-Carbon shadow of `p`. After Keep mine the shadow
 * is the folder's version, which need not be any revision Carbon held: Forget then discards the only copy.
 * @param {{items: {stack: {files: Map<string, Uint8Array>}}[]}} history
 */
export function shadowInHistory(link, history, p) {
  const shadow = link.baseline.get(p)?.shadow;
  return Boolean(shadow) && history.items.some((h) => equal(h.stack.files.get(p), shadow));
}
/**
 * The link after a verified Sync of `p` with `bytes`: the baseline is the written bytes and the
 * observation says the folder holds them now. `current` is Carbon's copy of `p` at the time of
 * recording: when it is no longer `bytes` (saved, deleted or moved in this window while the Sync was
 * awaiting the folder), the written bytes are kept as the shadow, so the newer revision reads
 * `modified` (or `deletedInCarbon`) instead of being taken for what the folder holds.
 */
export function syncedBaseline(link, p, bytes, modified, current) {
  const baseline = new Map(link.baseline);
  baseline.set(p, current && equal(current, bytes) ? {} : { shadow: bytes });
  return withSource(link, { baseline, observed: markSame(link.observed, p, bytes, modified) });
}

// ---- persistence ---------------------------------------------------------------------------------------

/** Structured-clonable form of `baseline` and `observed` for the mount record. */
export function packSource(link) {
  return {
    baseline: [...(link.baseline ?? new Map())].map(([p, e]) => [p, e.shadow ?? null]),
    observed: link.observed
      ? {
          at: link.observed.at,
          directories: [...link.observed.directories],
          entries: [...link.observed.entries].map(([p, e]) => [p, { size: e.size, modified: e.modified, same: e.same, captured: e.captured, bytes: e.bytes ?? null }]),
        }
      : null,
  };
}
/**
 * Validate untrusted stored `baseline` / `observed` against the restored workspace. A malformed
 * member is dropped (a path reads `virtual` or loses its observation, both non-destructive: Sync
 * then requires the disk to be absent, and no disk-derived action is offered); a malformed whole
 * yields an empty baseline / no observation, never a failed restore.
 * @returns {{baseline: Map<string, {shadow?: Uint8Array}>, observed: Observed|null}}
 */
export function validSource(raw, stack) {
  const baseline = new Map();
  if (Array.isArray(raw?.baseline))
    for (const item of raw.baseline) {
      if (!Array.isArray(item) || !safePath(item[0])) continue;
      const [p, shadow] = item;
      if (shadow === null || shadow === undefined) {
        if (stack.files.has(p)) baseline.set(p, {}); // no shadow means the virtual file is the baseline
      } else if (isBytes(shadow)) baseline.set(p, { shadow });
    }
  let observed = null;
  const o = raw?.observed;
  if (isObject(o) && typeof o.at === "string" && Array.isArray(o.directories) && Array.isArray(o.entries)) {
    const entries = new Map();
    for (const item of o.entries) {
      if (!Array.isArray(item) || !safePath(item[0]) || !isObject(item[1])) continue;
      const [p, e] = item;
      if (!Number.isSafeInteger(e.size) || e.size < 0 || typeof e.same !== "boolean") continue;
      const bytes = e.bytes === null || e.bytes === undefined ? undefined : isBytes(e.bytes) ? e.bytes : null;
      if (bytes === null) continue;
      // "Same as the baseline" means nothing without that baseline (dropped as damaged above): the folder's
      // bytes would be advertised but unavailable.
      if (e.same && !baseline.has(p)) continue;
      entries.set(p, {
        size: e.size,
        modified: Number.isFinite(e.modified) ? e.modified : null,
        same: e.same,
        captured: e.same || Boolean(bytes),
        ...(bytes && !e.same ? { bytes } : {}),
      });
    }
    observed = { at: o.at, directories: o.directories.filter(safePath), entries };
  }
  return { baseline, observed };
}
/** Bytes a link's source records occupy (shadows and captured disk bytes), for `recordBytes`. */
export function sourceBytes(packed) {
  let n = 0;
  if (Array.isArray(packed?.baseline)) for (const item of packed.baseline) n += Array.isArray(item) && Number.isSafeInteger(item[1]?.length) ? item[1].length : 0;
  if (Array.isArray(packed?.observed?.entries)) for (const item of packed.observed.entries) n += Array.isArray(item) && Number.isSafeInteger(item[1]?.bytes?.length) ? item[1].bytes.length : 0;
  return n;
}
