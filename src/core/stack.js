import {
  yaml,
  entry,
  patchScalar,
  stableEntry,
  removeField,
} from "./entries.js";
import {
  assert,
  id,
  path,
  encode,
  decode,
  equal,
  validatePaths,
  LIMITS,
} from "./validate.js";
import { suggestStackName } from "./naming.js";
/**
 * @typedef {Object} Manifest  Parsed `stack.yaml`; unknown keys are kept on the object.
 * @property {"envoy.stack/v0.2"} format
 * @property {string} id            stable Stack ID (`validate.id` syntax); never changed by Carbon
 * @property {number} revision      non-negative safe integer, incremented once per accepted mutation
 * @property {string} [title]       display title
 * @property {string} [entrypoint]  path of an existing Markdown Entry
 */
/**
 * @typedef {Object} HistoryItem  One bounded prior snapshot.
 * @property {Stack} stack   immutable full snapshot taken before a mutation
 * @property {string} label  why it was taken ("Before saving Entry", ...)
 * @property {string} time   ISO 8601 timestamp of the push
 */
/**
 * @typedef {Object} StackChange  Explicit local transaction for {@link Stack#change}.
 * @property {Map<string, Uint8Array>} [writes]  path -> new bytes (create or replace; never `stack.yaml`)
 * @property {string[]} [deletes]                existing paths to remove (never `stack.yaml`)
 * @property {[string, string][]} [moves]        `[from, to]` renames, applied before deletes and writes
 * @property {Iterable<string>} [directories]    explicit directory set of the new revision (default: current)
 */
/**
 * Immutable, validated Envoy Stack: original file bytes plus explicit directories.
 * No invented file inventory or metadata rewriting; every mutation returns a new instance.
 *
 * Constructor invariants: portable collision-free paths (implied parents included), size and
 * count limits, strict UTF-8 Markdown Entries with valid YAML frontmatter, unique stable Entry
 * IDs, and a root `stack.yaml` with valid format/id/revision/entrypoint. Input bytes are
 * untrusted until the constructor accepts them.
 */
export class Stack {
  /**
   * @param {Iterable<[string, Uint8Array]>} files  path -> bytes; `stack.yaml` required
   * @param {Iterable<string>} [directories]        explicit (possibly empty) directories
   * @throws {Error} on any invariant violation; messages are user-facing
   */
  constructor(files, directories = []) {
    const members = [...files];
    validatePaths(
      members.map(([p]) => p),
      directories,
    );
    this.files = new Map(members);
    this.directories = new Set(directories);
    for (const p of [...this.files.keys(), ...this.directories]) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++)
        this.directories.add(parts.slice(0, i).join("/"));
    }
    assert(
      this.files.size > 0 &&
        this.files.size + this.directories.size <= LIMITS.files,
      "Stack file-count limit exceeded",
    );
    validatePaths(this.files.keys(), this.directories);
    let total = 0;
    const ids = new Set();
    for (const [p, bytes] of this.files) {
      assert(
        bytes instanceof Uint8Array && bytes.length <= LIMITS.file,
        `File too large: ${p}`,
      );
      total += bytes.length;
      if (/\.md$/i.test(p)) {
        const e = entry(decode(bytes));
        if (e.data.id !== undefined) {
          assert(!ids.has(e.data.id), `Duplicate Entry ID: ${e.data.id}`);
          ids.add(e.data.id);
        }
      }
    }
    assert(total <= LIMITS.total, "Stack total size limit exceeded");
    assert(this.files.has("stack.yaml"), "Missing root stack.yaml");
    const m = yaml(this.text("stack.yaml")).data;
    assert(m.format === "envoy.stack/v0.2", "Unsupported Stack format");
    id(m.id);
    assert(
      Number.isSafeInteger(m.revision) && m.revision >= 0,
      "Invalid Stack revision",
    );
    if (m.title !== undefined)
      assert(typeof m.title === "string", "Stack title must be text");
    if (m.entrypoint !== undefined)
      assert(
        this.files.has(path(m.entrypoint)) && /\.md$/i.test(m.entrypoint),
        "Missing Markdown entrypoint",
      );
    /** @type {Manifest} */
    this.manifest = m;
  }
  /**
   * Decode one file as strict UTF-8 text.
   * @param {string} p  existing path
   * @returns {string}
   * @throws {Error} when the path is missing or the bytes are not valid UTF-8
   */
  text(p) {
    assert(this.files.has(p), `Missing file: ${p}`);
    return decode(this.files.get(p));
  }
  /**
   * Apply an explicit local transaction; returns a new validated Stack at revision + 1.
   * Managed Entry IDs cannot change. The manifest is patched in place (comments kept) and
   * follows an entrypoint move or deletion. The receiver is never modified.
   * @param {StackChange} [change]
   * @returns {Stack}
   * @throws {Error} on invalid targets, ID changes, limit breaches or revision exhaustion
   */
  change({
    writes = new Map(),
    deletes = [],
    moves = [],
    directories = this.directories,
  } = {}) {
    const files = new Map(this.files);
    let manifest = this.text("stack.yaml");
    assert(
      !writes.has("stack.yaml") && !deletes.includes("stack.yaml"),
      "Manifest cannot be replaced by an Entry edit",
    );
    for (const [from, to] of moves) {
      path(to);
      assert(
        from !== "stack.yaml" && files.has(from) && !files.has(to),
        "Invalid move target",
      );
      files.set(to, files.get(from));
      files.delete(from);
      if (this.manifest.entrypoint === from)
        manifest = patchScalar(manifest, "entrypoint", to);
    }
    for (const p of deletes) {
      assert(files.has(p), `Missing deletion target: ${p}`);
      files.delete(p);
      if (yaml(manifest).data.entrypoint === p)
        manifest = removeField(manifest, "entrypoint");
    }
    for (const [p, bytes] of writes) {
      path(p);
      if (files.has(p) && /\.md$/i.test(p))
        stableEntry(decode(files.get(p)), decode(bytes));
      files.set(p, bytes);
    }
    assert(
      this.manifest.revision < Number.MAX_SAFE_INTEGER,
      "Revision exhausted",
    );
    files.set(
      "stack.yaml",
      encode(patchScalar(manifest, "revision", this.manifest.revision + 1)),
    );
    return new Stack(files, directories);
  }
}
/**
 * Create an empty Stack at revision 0 with a fresh random stable ID.
 * @param {string} [title]  display title; defaults to a generated local-date name
 * @returns {Stack}
 */
export function newStack(title = suggestStackName()) {
  return new Stack([
    [
      "stack.yaml",
      encode(
        `format: envoy.stack/v0.2\nid: stk-${crypto.randomUUID()}\nrevision: 0\ntitle: ${JSON.stringify(title)}\n`,
      ),
    ],
  ]);
}
/**
 * Byte-for-byte logical equality: same paths, same bytes, same explicit directory set.
 * @param {Stack} a
 * @param {Stack} b
 * @returns {boolean}
 */
export function sameStack(a, b) {
  return (
    a.files.size === b.files.size &&
    [...a.files].every(([p, v]) => equal(v, b.files.get(p))) &&
    [...a.directories].sort().join("\0") ===
      [...b.directories].sort().join("\0")
  );
}
/**
 * Bounded full snapshots retained before every accepted mutation, oldest first.
 * At most 10 items and 64 MiB of file bytes; the oldest items are evicted first and are
 * then invisible to {@link restoreRevision}. Browser-only state; never part of an export.
 */
export class History {
  /** @param {HistoryItem[]} [items]  oldest first */
  constructor(items = []) {
    /** @type {HistoryItem[]} */
    this.items = items;
  }
  /**
   * Append a snapshot, evicting the oldest items beyond the count/size budget.
   * Side effect: mutates `items` in place.
   * @param {Stack} stack
   * @param {string} label
   */
  push(stack, label) {
    const size = (s) => [...s.files.values()].reduce((n, b) => n + b.length, 0);
    this.items.push({ stack, label, time: new Date().toISOString() });
    while (
      this.items.length > 10 ||
      (this.items.length > 1 &&
        this.items.reduce((n, x) => n + size(x.stack), 0) > 64 * 1024 ** 2)
    )
      this.items.shift();
  }
}
/**
 * Next revision for restoring History snapshot `old`, keeping revisions monotonic per Stack id.
 * Same id as the active Stack: 1 + max(active revision, `old`, every History snapshot with that
 * id). Different id: 1 + max(`old`, every History snapshot with `old`'s id); the active Stack
 * is another Stack and is ignored.
 *
 * Limit: only snapshots still retained in History are consulted. Revisions already evicted
 * from History (or living only in downloaded archives) are unknown, so a restore can reuse a
 * number that an older export carries.
 * @param {Stack} stack      active Stack
 * @param {History} history  retained snapshots
 * @param {Stack} old        snapshot to restore (normally `history.items[i].stack`)
 * @returns {number}
 * @throws {Error} when the revision counter is exhausted
 */
export function restoreRevision(stack, history, old) {
  let max = old.manifest.revision;
  if (old.manifest.id === stack.manifest.id)
    max = Math.max(max, stack.manifest.revision);
  for (const item of history.items)
    if (item.stack.manifest.id === old.manifest.id)
      max = Math.max(max, item.stack.manifest.revision);
  assert(max < Number.MAX_SAFE_INTEGER, "Revision exhausted");
  return max + 1;
}
/**
 * Build the Stack that restoring `old` produces: `old`'s files and directories with the
 * manifest `revision` patched to {@link restoreRevision} (other bytes and comments kept).
 * Pure; the caller pushes the active Stack to History and swaps the result in.
 * @param {Stack} stack
 * @param {History} history
 * @param {Stack} old
 * @returns {Stack}
 * @throws {Error} when the snapshot no longer validates or the revision is exhausted
 */
export function restoreSnapshot(stack, history, old) {
  const revision = restoreRevision(stack, history, old);
  const files = new Map(old.files);
  files.set(
    "stack.yaml",
    encode(patchScalar(old.text("stack.yaml"), "revision", revision)),
  );
  return new Stack(files, old.directories);
}
/** Explicit leaf directories with no file or directory beneath them. */
function emptyDirectories(stack) {
  const nodes = [...stack.files.keys(), ...stack.directories];
  return [...stack.directories].filter(
    (d) => !nodes.some((p) => p.startsWith(d + "/")),
  );
}
/**
 * Empty directories (explicit leaf folders not implied by any file) that differ between two
 * Stacks, for import previews that otherwise list files only. A folder that gains a file or
 * subfolder stops being empty and therefore appears under `removed`.
 * @param {Stack} current
 * @param {Stack} next
 * @returns {{added: string[], removed: string[]}}  sorted paths
 */
export function directoryDiff(current, next) {
  const before = new Set(emptyDirectories(current)),
    after = new Set(emptyDirectories(next));
  return {
    added: [...after].filter((d) => !before.has(d)).sort(),
    removed: [...before].filter((d) => !after.has(d)).sort(),
  };
}
