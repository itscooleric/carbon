import { canEdit, isLocalFolder, isScratch, scratchFolder } from "./local-files.js";
/**
 * Workspace state and persistence. One `WorkspaceState` object is created by the
 * composition root and passed explicitly to every module; this module owns its
 * serialization to a `carbon-vfs` mount record (vfs.js) and the atomic `commit()` rule.
 */
import { workspaceState } from "./workspace.js";
import { newStack, History, Stack } from "../core/stack.js";
import { registerHandoff, readHandoff, parseReturn } from "../../cast-kit/src/kit.mjs";
import { packStack, unpackStack } from "./fs.js";
import { packLink, validLink } from "./linked.js";
export { packStack, unpackStack } from "./fs.js";

/** @typedef {import("./types.js").WorkspaceState} WorkspaceState */
/** @typedef {import("./types.js").CacheRecord} CacheRecord */

/** Valid `copyState` values; unknown cached values fall back to "pending". */
export const COPY_STATES = [
  "pending",
  "requested",
  "confirmed",
  "imported",
  "folder",
];

/**
 * Create the default workspace: Scratch with one empty, open Markdown note and no History,
 * drafts or dispatches. A pristine Scratch is not "unexported", so a first visit never
 * prompts on close.
 * @param {Date} [date] names the note (`YYYY-MM-DD.md`)
 * @returns {WorkspaceState}
 */
export function createState(date = new Date()) {
  const stack = scratchFolder(date);
  return { ...blankState(stack), current: [...stack.files.keys()][0], unexported: false };
}

/**
 * A workspace with no History, drafts, tabs or dispatches around `stack` (a new mount).
 * @param {import("./types.js").Documents} [stack] defaults to an empty new Stack
 * @returns {WorkspaceState}
 */
export function blankState(stack = newStack()) {
  return {
    stack,
    history: new History(),
    current: null,
    documents: null,
    drafts: new Map(),
    selected: new Set(),
    trusted: null,
    unexported: true,
    copyState: "pending",
    dispatches: [],
    lastArchiveRevision: -1,
    link: null,
  };
}

/** @typedef {"scratch"|"folder"|"linked"|"stack"} MountKind */
/**
 * Kind of the workspace a state holds, from its identity and link.
 * @param {{stack: import("./types.js").Documents, link: object|null}} state
 * @returns {MountKind}
 */
export function mountKind(state) {
  return isScratch(state.stack) ? "scratch" : state.link ? "linked" : isLocalFolder(state.stack) ? "folder" : "stack";
}

/**
 * The `carbon-vfs` mount record for a state: `serialize(state)` plus identity. `rev` is
 * assigned by the store when the record is written.
 * @param {WorkspaceState} state
 * @param {Date} [now]
 * @returns {CacheRecord & {id: string, kind: MountKind, title: string, updatedAt: string}}
 */
export function mountRecord(state, now = new Date()) {
  const { id, title } = state.stack.manifest;
  return { ...serialize(state), id, kind: mountKind(state), title: title || id, updatedAt: now.toISOString() };
}
/** Default writer: the store's revision-checked single-mount write. */
const writeMount = (db, record) => db.write(record);
/** A store that does not persist (memory-only window) behaves like no store for writes. */
const durable = (db) => Boolean(db) && db.durable !== false;

/**
 * Serialize the workspace into the structured-clonable cache record. `selected` is
 * session-only and not persisted. `dispatches` records are stored as given.
 * @param {WorkspaceState} state
 * @returns {CacheRecord}
 */
export function serialize(state) {
  return {
    stack: packStack(state.stack),
    history: state.history.items.map((x) => ({
      ...x,
      stack: packStack(x.stack),
    })),
    current: state.current,
    documents: workspaceState(state.stack, state.current, state.documents),
    drafts: [...state.drafts],
    unexported: state.unexported,
    copyState: state.copyState,
    trusted: state.trusted
      ? { ...state.trusted, base: packStack(state.trusted.base) }
      : null,
    dispatches: state.dispatches,
    lastArchiveRevision: state.lastArchiveRevision,
    link: packLink(state.link),
  };
}

/**
 * Rebuild a workspace from a cache record. The record is untrusted: Stacks are
 * re-validated by `unpackStack`, the open Entry and drafts are dropped when their paths
 * no longer exist, and fields missing from older records receive defaults. The whole
 * object is built before returning, so a throw leaves the caller's state untouched.
 * Each cached Dispatch record is validated with {@link validDispatch}; malformed or duplicate
 * records are skipped (reported through `warn`) so one damaged record never blocks recovery.
 * @param {CacheRecord} cached
 * @param {(message: string) => void} [warn] receives a user-facing message when records are skipped
 * @returns {WorkspaceState}
 * @throws {Error} when a cached Stack fails validation
 */
export function restore(cached, warn = () => {}) {
  const stack = unpackStack(cached.stack);
  const cachedDispatches = Array.isArray(cached.dispatches) ? cached.dispatches : [];
  const dispatches = cachedDispatches.map(validDispatch).filter(Boolean);
  const seen = new Set();
  const unique = dispatches.filter((r) => !seen.has(r.assignmentId) && seen.add(r.assignmentId));
  if (unique.length < cachedDispatches.length)
    warn(
      `${cachedDispatches.length - unique.length} damaged Dispatch record(s) in the browser cache were skipped. Your Stack and other Dispatches were recovered.`,
    );
  return {
    stack,
    history: new History(
      (cached.history || []).map((x) => ({
        ...x,
        stack: unpackStack(x.stack),
      })),
    ),
    current: canEdit(stack, cached.current) ? cached.current : null,
    documents: workspaceState(stack, cached.current, cached.documents),
    drafts: new Map((cached.drafts || []).filter(([p]) => stack.files.has(p))),
    selected: new Set(),
    trusted: cached.trusted && !isLocalFolder(stack)
      ? { ...cached.trusted, base: new Stack(cached.trusted.base.files, cached.trusted.base.directories) }
      : null,
    unexported: cached.copyState ? !!cached.unexported : true,
    copyState: COPY_STATES.includes(cached.copyState)
      ? cached.copyState
      : "pending",
    dispatches: unique,
    lastArchiveRevision: Number.isInteger(cached.lastArchiveRevision)
      ? cached.lastArchiveRevision
      : -1,
    // Provisionally "permission" until verifyLink asks the browser; unknown shapes mean no link.
    link: validLink(cached.link, stack),
  };
}

const STATUSES = ["draft", "exported", "staged", "accepted", "checkpoint", "rejected", "abandoned"];
const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isText = (v) => typeof v === "string";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validate one cached Dispatch record. The cache is untrusted input (older builds, partial
 * writes, other tools, older Cast Kit versions), so every field the views and controllers
 * read is type-checked, a retained base is re-validated as a Stack, and the stored Cast,
 * original handoff, Return template and staged Return must parse with this build's Cast Kit
 * and agree on identity. Returns the record, or null when it is malformed.
 * @param {unknown} r
 * @returns {import("./types.js").DispatchRecord|null}
 */
export function validDispatch(r) {
  try {
    if (!isObject(r) || !isText(r.assignmentId) || !/^cast-[A-Za-z0-9._-]{1,120}$/.test(r.assignmentId))
      return null;
    if (!Number.isSafeInteger(r.seq) || r.seq < 1 || !STATUSES.includes(r.status)) return null;
    if (!isText(r.stackId) || !Number.isSafeInteger(r.baseRevision) || r.baseRevision < 0) return null;
    if (!isText(r.createdAt) || !isText(r.updatedAt)) return null;
    const d = r.draft;
    if (!isObject(d)) return null;
    if (!["question", "plan", "report", "custom"].includes(d.preset)) return null;
    if (!isText(d.objective) || !(d.mission === null || isText(d.mission))) return null;
    if (![d.criteria, d.context, d.assets].every(isStrings)) return null;
    if (!["selected", "complete"].includes(d.scope) || !["text", "files", "tar"].includes(d.target)) return null;
    if (typeof d.consent !== "boolean" || !Number.isInteger(d.step) || d.step < 0 || d.step > 4) return null;
    if (
      !Array.isArray(d.playbooks) ||
      !d.playbooks.every((p) => isObject(p) && isText(p.name) && isText(p.source) && isText(p.content))
    )
      return null;
    const p = d.permissions;
    if (!isObject(p) || ![p.create, p.replace, p.delete].every(isStrings)) return null;
    if (!Array.isArray(p.metadata) || !p.metadata.every((m) => isObject(m) && isText(m.path) && isStrings(m.keys)))
      return null;
    if (!Array.isArray(p.rename) || !p.rename.every((x) => isStrings(x) && x.length === 2)) return null;
    const e = r.exported;
    if (r.status !== "draft") {
      if (!isObject(e) || ![e.castSource, e.handoff, e.dispatchId, e.returnTemplate, e.via, e.at].every(isText))
        return null;
      if (e.base !== null && isLocalFolder(unpackStack(e.base))) return null; // throws on a damaged snapshot
      // Protocol payloads must still parse with this build's Cast Kit and agree with the
      // record: registerHandoff validates the Cast, the original handoff and their identity
      // and read scope together (pure; no state is kept).
      const handle = registerHandoff(e.castSource, e.handoff);
      if (handle.assignment_id !== r.assignmentId || handle.stack_id !== r.stackId) return null;
      if (handle.base_revision !== r.baseRevision) return null;
      const template = parseReturn(e.returnTemplate).meta;
      if (template.assignment_id !== r.assignmentId) return null;
      if (readHandoff(e.handoff).meta.dispatch_id !== e.dispatchId) return null;
    } else if (e !== null) return null;
    if (r.status === "staged" ? !(isObject(r.staged) && isText(r.staged.source)) : r.staged !== null) return null;
    if (r.status === "staged") parseReturn(r.staged.source); // throws on a corrupt staged Return
    if (
      !Array.isArray(r.receipts) ||
      !r.receipts.every((x) => isObject(x) && ["accepted", "checkpoint", "rejected"].includes(x.kind) && isText(x.source))
    )
      return null;
    if (!(r.acceptedRevision === null || Number.isSafeInteger(r.acceptedRevision))) return null;
    return r;
  } catch {
    return null;
  }
}

// One write queue per state object so cache writes never interleave or reorder.
const queues = new WeakMap();
/**
 * Run `job` after every queued write of `state` (exported for mount switches, which must not
 * interleave with a pending write of the workspace they park).
 * @template T
 * @param {WorkspaceState} state
 * @param {() => Promise<T>} job
 * @returns {Promise<T>}
 */
export function enqueue(state, job) {
  const next = (queues.get(state) || Promise.resolve())
    .catch(() => {})
    .then(job);
  queues.set(state, next);
  return next;
}

/**
 * Queue a write of the live state's mount record. Resolves immediately when `db` is null or
 * not durable. Rejects when the write fails (quota, a revision conflict with another tab);
 * the caller decides how to report it.
 * @param {WorkspaceState} state
 * @param {import("./vfs.js").Vfs|null} db
 * @param {(db: import("./vfs.js").Vfs, value: CacheRecord) => Promise<unknown>} [write] injectable writer (tests)
 * @returns {Promise<void>}
 */
export function persist(state, db, write = writeMount) {
  if (!durable(db)) return Promise.resolve();
  // Snapshot when the queued write starts, after earlier atomic commits publish.
  return enqueue(state, () => write(db, mountRecord(state))).then(() => undefined);
}

/**
 * Atomically apply `candidate` to the workspace: serialize the merged state, write it to
 * the store FIRST, and only on success assign the candidate's fields into `state`. When
 * `db` is null (or not durable) the assignment happens immediately. On write failure the
 * promise rejects and `state` is untouched; `db` is not modified here.
 * @param {WorkspaceState} state
 * @param {import("./vfs.js").Vfs|null} db
 * @param {Partial<WorkspaceState>} candidate same field names; may share objects with `state`
 * @param {(db: import("./vfs.js").Vfs, value: CacheRecord) => Promise<unknown>} [write] injectable writer (tests)
 * @returns {Promise<void>}
 */
export async function commit(state, db, candidate, write = writeMount) {
  if (durable(db)) {
    await enqueue(state, async () => {
      await write(db, mountRecord({ ...state, ...candidate }));
      Object.assign(state, candidate);
    });
  } else Object.assign(state, candidate);
}
