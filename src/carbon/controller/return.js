/**
 * Return controller: import routing -> stage -> review -> accept / reject / checkpoint.
 * Pure and DOM-free; persistence goes through the injected `persist` / `commit`.
 *
 * Trust: Return text is model output and untrusted. Cast Kit parses it strictly, the
 * retained Cast and base Stack are the authority for permissions and identity, and the
 * current full Stack is compared byte-for-byte before anything is applied. Acceptance
 * builds a complete candidate state and commits it atomically; nothing in `state` changes
 * on failure.
 */
import { renameWorkspace } from "../workspace.js";
import {
  parseCast,
  parseReturn,
  registerStack,
  stageReturn,
  acceptInCarbon,
} from "../../../cast-kit/src/kit.mjs";
import { History, sameStack } from "../../core/stack.js";
import { entry } from "../../core/entries.js";
import { assert } from "../../core/validate.js";
import { writeTar } from "../../archives/tar.js";
import { assertStack } from "../local-files.js";
import { unpackStack } from "../state.js";

/** @typedef {import("../types.js").WorkspaceState} WorkspaceState */
/** @typedef {import("../types.js").DispatchRecord} DispatchRecord */
/** @typedef {import("../types.js").ReviewModel} ReviewModel */
/** @typedef {import("../types.js").ReviewChange} ReviewChange */
/** @typedef {import("../types.js").Check} Check */

const UNKNOWN_FORMAT =
  "Unknown Return format. Carbon accepts envoy.return/v0.1 Cast Returns and envoy.handoff/v0.2 packets.";
const STALE =
  "Stack moved past the Cast base; re-dispatch from the current revision";
const SCALAR = (v) => ["string", "number", "boolean"].includes(typeof v);
const isEntryPath = (p) => /\.md$/i.test(p);

/**
 * Route an imported text by its header only.
 * @param {string} text
 * @returns {"cast-return"|"legacy-handoff"|"unknown"}
 */
export function route(text) {
  if (typeof text !== "string") return "unknown";
  if (/^# Envoy Cast Return\n/.test(text)) return "cast-return";
  if (/^# Envoy Handoff\n/.test(text)) return "legacy-handoff";
  return "unknown";
}

/** Which check a Cast Kit staging error belongs to. */
function classify(message) {
  if (/base_revision/.test(message)) return "base";
  if (/Unauthorized|collision|Invalid rename|existence/.test(message)) return "permissions";
  if (/Duplicate|ID/.test(message)) return "ids";
  if (/identity|Objective|stale base/.test(message)) return "cast";
  return "permissions";
}

/**
 * Create the return controller.
 * @param {Object} deps
 * @param {WorkspaceState} deps.state
 * @param {() => Promise<void>} deps.persist queue a cache write of the live state
 * @param {(candidate: Partial<WorkspaceState>) => Promise<void>} deps.commit atomic: cache write first, then assign
 * @param {(bytes: Uint8Array, name: string, type: string) => void} [deps.download] accepted but unused; views download `proposedArchive()` themselves
 * @param {() => string} [deps.now] ISO timestamp source
 */
export function createReturnController({
  state,
  persist,
  commit,
  now = () => new Date().toISOString(),
}) {
  let accepting = false;

  /**
   * Returns apply only to the active Envoy Stack that issued the Dispatch. Records live inside
   * their Stack's own workspace, so this is a second, explicit boundary: a Return can never be
   * staged, reviewed or accepted while Scratch, a local copy, a linked folder or another Stack
   * is active.
   * @param {DispatchRecord} r
   */
  function assertActiveStack(r) {
    assertStack(state.stack);
    assert(
      r.stackId === state.stack.manifest.id,
      `Dispatch ${r.seq} belongs to Stack ${r.stackId}, which is not the open workspace. Switch to that Stack first; nothing was changed.`,
    );
  }
  /** @param {string} id @returns {DispatchRecord} */
  function record(id) {
    const r = state.dispatches.find((x) => x.assignmentId === id);
    assert(r, `Unknown Dispatch: ${id}`);
    assertActiveStack(r);
    return r;
  }
  /** @param {string} id @returns {DispatchRecord} @throws unless staged */
  function stagedRecord(id) {
    const r = record(id);
    assert(r.status === "staged" && r.staged, `Dispatch ${r.seq} has no staged Return.`);
    return r;
  }
  /** Strict parse with the user-facing prefix. */
  function parse(text) {
    try {
      return parseReturn(text);
    } catch (e) {
      throw new Error("Invalid Return: " + e.message);
    }
  }
  /** Frontmatter scalar differences between two Entry texts, or null when unreadable. */
  function metadataChanges(before, after, allowed) {
    let a, b;
    try {
      a = entry(before).data;
      b = entry(after).data;
    } catch {
      return null;
    }
    const out = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key === "id") continue;
      const x = a[key],
        y = b[key];
      // Only scalar differences are reported; any other frontmatter change is caught by
      // Cast Kit's exact-span comparison and surfaces as a permissions failure.
      if (x === y || (!SCALAR(x) && !SCALAR(y))) continue;
      out.push({
        key,
        before: x,
        after: y,
        permitted:
          allowed.includes(key) &&
          Object.hasOwn(a, key) &&
          Object.hasOwn(b, key) &&
          SCALAR(x) &&
          SCALAR(y),
      });
    }
    return out;
  }

  /**
   * Build the ReviewModel for a record and Return text. Shared by `stage` and `review`;
   * no persistence here. Cast Kit failures become failed checks, never throws, except for
   * unparseable Return text.
   * @param {DispatchRecord} r
   * @param {string} source
   * @returns {ReviewModel}
   */
  function evaluate(r, source) {
    const cast = parseCast(r.exported.castSource);
    const { meta, files } = parse(source);
    const current = state.stack;
    const base = r.exported.base ? unpackStack(r.exported.base) : null;
    const checks = {
      framing: { id: "framing", ok: true, text: "Framing and format envoy.return/v0.1" },
      cast: { id: "cast", ok: true, text: `Matches registered Cast ${cast.assignment_id}` },
      base: { id: "base", ok: true, text: `Base revision ${cast.base_revision} matches the current Stack byte-for-byte` },
      permissions: { id: "permissions", ok: true, text: "Every change is within Cast permissions" },
      ids: { id: "ids", ok: true, text: "New Entry IDs are unique across the full Stack, including omitted Entries" },
      omitted: { id: "omitted", ok: true, text: "Omitted Entries and Assets are untouched" },
      drafts: { id: "drafts", ok: true, text: "No unsaved editor changes" },
    };
    const fail = (id, text) => {
      if (checks[id].ok) checks[id] = { id, ok: false, text };
    };
    // cast: identity and objective
    for (const k of ["assignment_id", "dispatch_id", "stack_id"])
      if (meta[k] !== cast[k]) fail("cast", `Return ${k} ${meta[k]} does not match the Cast`);
    if (meta.objective !== cast.objective) fail("cast", "Objective differs from assignment");
    // base: Return base vs Cast base, then the current Stack vs the Cast base
    let stale = false;
    if (meta.base_revision !== cast.base_revision)
      fail("base", `Return claims base ${meta.base_revision}; Cast base is ${cast.base_revision}`);
    if (current.manifest.id !== cast.stack_id || current.manifest.revision !== cast.base_revision) {
      stale = true;
      fail("base", `Stack is now revision ${current.manifest.revision}; Cast base is ${cast.base_revision}`);
    } else if (base && !sameStack(current, base)) {
      stale = true;
      fail("base", `Stack differs from the Cast base revision ${cast.base_revision} byte-for-byte`);
    }
    // registration and staging through Cast Kit
    let handle = null,
      staged = null,
      failure = null;
    try {
      handle = registerStack(base ?? current, r.exported.castSource, r.exported.handoff);
    } catch {
      // Only reachable without a retained base (checkpoint records): the current Stack no
      // longer matches the Cast, by revision or by bytes.
      stale = true;
      fail(
        "base",
        current.manifest.revision !== cast.base_revision
          ? `Stack is now revision ${current.manifest.revision}; Cast base is ${cast.base_revision}`
          : `Stack differs from the Cast base revision ${cast.base_revision} byte-for-byte`,
      );
    }
    if (handle)
      try {
        staged = stageReturn(handle, source);
      } catch (e) {
        failure = e.message;
      }
    const reference = base ?? current;
    const text = (p) =>
      reference.files.has(p) && isEntryPath(p)
        ? (() => {
            try {
              return reference.text(p);
            } catch {
              return null;
            }
          })()
        : null;
    // permissions and omitted, computed against the Cast lists
    const allowed = {
      create: (p) => cast.create.includes(p),
      replace: (p) => cast.replace.includes(p),
      delete: (p) => cast.delete.includes(p),
      rename: (from, to) => cast.rename.some((x) => x[0] === from && x[1] === to),
    };
    const touched = [...meta.creates, ...meta.replaces, ...meta.deletes, ...meta.renames.flat()];
    for (const p of touched)
      if (reference.files.has(p) && !cast.read.includes(p))
        fail("omitted", `${p} is omitted from the Cast and cannot be changed`);
    /** @type {ReviewChange[]} */
    const changes = [];
    for (const p of meta.deletes) {
      const permitted = allowed.delete(p);
      if (!permitted) fail("permissions", `${p}: deletion is not permitted by the Cast`);
      changes.push({ op: "delete", path: p, before: text(p), after: null, permitted });
    }
    for (const [from, to] of meta.renames) {
      const permitted = allowed.rename(from, to);
      if (!permitted) fail("permissions", `${from}: rename to ${to} is not permitted by the Cast`);
      changes.push({ op: "rename", path: from, to, before: text(from), after: text(from), permitted });
    }
    for (const [p, body] of files) {
      if (meta.creates.includes(p)) {
        const permitted = allowed.create(p);
        if (!permitted) fail("permissions", `${p}: creation is not permitted by the Cast`);
        changes.push({ op: "create", path: p, before: null, after: body, permitted });
        continue;
      }
      const before = text(p);
      const keys = cast.metadata.find((m) => m.path === p)?.keys || [];
      const metadata = before === null ? [] : metadataChanges(before, body, keys);
      let permitted = allowed.replace(p);
      if (!permitted) fail("permissions", `${p}: replacement is not permitted by the Cast`);
      if (metadata === null) {
        permitted = false;
        fail("permissions", `${p}: proposed frontmatter is not valid`);
      } else
        for (const m of metadata)
          if (!m.permitted) {
            permitted = false;
            fail("permissions", `${p}: metadata ${m.key} may not change`);
          }
      changes.push({ op: "replace", path: p, before, after: body, metadata: metadata || [], permitted });
    }
    // ids: new Entry IDs against the full current Stack (and the base when retained)
    const known = new Map();
    for (const s of [current, base].filter(Boolean))
      for (const p of s.files.keys())
        if (isEntryPath(p) && !meta.deletes.includes(p) && !meta.replaces.includes(p))
          try {
            const id = entry(s.text(p)).data.id;
            if (id !== undefined) known.set(id, p);
          } catch {
            // unreadable Entry: nothing to compare
          }
    const proposed = new Set();
    for (const [p, body] of files) {
      let id;
      try {
        id = entry(body).data.id;
      } catch {
        continue;
      }
      if (id === undefined) {
        if (meta.creates.includes(p)) fail("ids", `${p}: new Entry requires a stable ID`);
        continue;
      }
      if (proposed.has(id) || (known.has(id) && known.get(id) !== p))
        fail("ids", `${p}: Entry ID ${id} already exists in the Stack`);
      proposed.add(id);
    }
    // Cast Kit's own verdict wins where the manual checks found nothing.
    if (failure) fail(classify(failure), failure);
    // drafts
    const dirtyPaths = [...new Set(touched)].filter((p) => state.drafts.has(p)).sort();
    if (dirtyPaths.length) fail("drafts", `Unsaved editor changes in ${dirtyPaths.join(", ")}`);
    const ordered = ["framing", "cast", "base", "permissions", "ids", "omitted", "drafts"].map((k) => checks[k]);
    const zeroOps = changes.length === 0;
    const allOk = ordered.every((c) => c.ok);
    const canAccept = allOk && !zeroOps;
    // A checkpoint is a receipt for this Dispatch: it must pass the same identity, base and
    // scope checks as an acceptable Return before Carbon stores it and drops the base.
    const canSaveReceipt = allOk && zeroOps;
    const reason = !allOk
      ? ordered.find((c) => !c.ok).text
      : zeroOps
        ? "This Return proposes no file operations; save the receipt instead."
        : `Accepting creates revision ${current.manifest.revision + 1}. Revision ${current.manifest.revision} stays in History.`;
    return {
      dispatch: r,
      selfStatus: meta.status,
      checkpointId: meta.checkpoint_id,
      summary: meta.summary,
      evidence: [...meta.evidence],
      unresolved: [...meta.questions, ...meta.next],
      blockers: [...meta.blockers],
      errors: [...meta.errors],
      completed: [...meta.completed],
      opsPerformed: [...meta.operations_performed],
      accepted: [...meta.accepted],
      decisions: [...meta.decisions],
      verification: [...meta.verification],
      changes,
      checks: ordered,
      canAccept,
      canSaveReceipt,
      reason,
      zeroOps,
      stale,
      dirtyPaths,
      warnings: staged ? [...staged.warnings] : [],
    };
  }

  /**
   * Stage a Cast Return for review. Parses strictly, finds the record (by `assignmentId`
   * or the Return's `assignment_id`), validates against the retained Cast and base, records
   * the staged text and persists.
   * @param {string} text untrusted Return text
   * @param {string|null} [assignmentId] override the Return's own `assignment_id`
   * @returns {Promise<ReviewModel>}
   * @throws {Error} with a user-facing message for framing, unknown Cast or wrong state
   */
  async function stage(text, assignmentId = null) {
    assert(route(text) === "cast-return", UNKNOWN_FORMAT);
    const { meta } = parse(text);
    const id = assignmentId || meta.assignment_id;
    assertStack(state.stack);
    const r = state.dispatches.find((x) => x.assignmentId === id);
    assert(r && r.exported, `Original Cast not found for ${id}. Import the original Cast or export a new Dispatch.`);
    assertActiveStack(r);
    assert(
      ["exported", "staged", "rejected", "checkpoint"].includes(r.status),
      `Dispatch ${r.seq} is ${r.status}; it cannot take another Return.`,
    );
    const model = evaluate(r, text);
    r.staged = { source: text, at: now(), checkpointId: meta.checkpoint_id };
    r.status = "staged";
    r.updatedAt = r.staged.at;
    try {
      await persist();
    } catch {
      model.warning = "Staged Return not saved — it will be lost on reload.";
    }
    return model;
  }

  /**
   * Rebuild the review model from the persisted staged text (after a reload).
   * @param {string} assignmentId
   * @returns {ReviewModel}
   */
  function review(assignmentId) {
    const r = stagedRecord(assignmentId);
    return evaluate(r, r.staged.source);
  }

  /** Register the current Stack against the record's Cast, mapping staleness to the contract text. */
  function handleFor(r) {
    try {
      return registerStack(state.stack, r.exported.castSource, r.exported.handoff);
    } catch (e) {
      if (/stale|identity|inventory|Conflicting/i.test(e.message)) throw new Error(STALE);
      throw e;
    }
  }

  /**
   * Accept the staged Return as one new revision. Requires no unsaved drafts and an
   * unchanged base; builds a candidate (History + Stack + record) and commits it
   * atomically. On commit failure nothing changes and the Return stays staged.
   * @param {string} assignmentId
   * @returns {Promise<{revision: number, renames: string[][]}>}
   * @throws {Error} "Acceptance already in progress", draft/stale messages, or "Not saved: ..."
   */
  async function accept(assignmentId) {
    assert(!accepting, "Acceptance already in progress");
    accepting = true;
    try {
      const r = stagedRecord(assignmentId);
      assert(state.drafts.size === 0, "Save or discard Entry drafts before accepting.");
      const handle = handleFor(r);
      const source = r.staged.source;
      const result = acceptInCarbon(state.stack, handle, source, { approved: true });
      const next = result.next;
      const renames = parseReturn(source).meta.renames;
      const current = new Map(renames).get(state.current) ?? state.current;
      const history = new History([...state.history.items]);
      history.push(state.stack, `Before accepting Return ${r.seq}`);
      const at = now();
      const updated = {
        ...r,
        status: "accepted",
        staged: null,
        acceptedRevision: next.manifest.revision,
        receipts: [...r.receipts, { kind: "accepted", source, acceptance: result.acceptance, at }],
        exported: { ...r.exported, base: null },
        updatedAt: at,
      };
      const candidate = {
        stack: next,
        history,
        dispatches: state.dispatches.map((x) => (x === r ? updated : x)),
        unexported: true,
        copyState: "pending",
        trusted: null,
        selected: new Set(),
        documents: renameWorkspace(state.documents, renames),
        current: next.files.has(current)
          ? current
          : [...next.files.keys()].find(isEntryPath) || null,
      };
      try {
        await commit(candidate);
      } catch (e) {
        throw new Error(`Not saved: ${e.message}. The Stack is unchanged and the Return is still staged.`);
      }
      return { revision: next.manifest.revision, renames };
    } finally {
      accepting = false;
    }
  }

  /**
   * The Stack that accepting would produce, as a TAR, without committing anything.
   * @param {string} assignmentId
   * @returns {Uint8Array}
   */
  function proposedArchive(assignmentId) {
    const r = stagedRecord(assignmentId);
    const handle = handleFor(r);
    return writeTar(acceptInCarbon(state.stack, handle, r.staged.source, { approved: true }).next);
  }

  /**
   * Reject the staged Return; the base is kept so another Return can be staged.
   * @param {string} assignmentId
   * @returns {Promise<void>}
   */
  async function reject(assignmentId) {
    const r = stagedRecord(assignmentId);
    const at = now();
    r.receipts = [...r.receipts, { kind: "rejected", source: r.staged.source, at }];
    r.staged = null;
    r.status = "rejected";
    r.updatedAt = at;
    await persist();
  }

  /**
   * Store a zero-operation Return as a checkpoint receipt; the base is dropped. The Return is
   * re-evaluated first and every check must pass.
   * @param {string} assignmentId
   * @returns {Promise<void>}
   * @throws {Error} when the Return proposes file operations or fails a check
   */
  async function saveReceipt(assignmentId) {
    const r = checkedReceipt(assignmentId);
    const at = now();
    r.receipts = [...r.receipts, { kind: "checkpoint", source: r.staged.source, at }];
    r.staged = null;
    r.status = "checkpoint";
    r.exported = { ...r.exported, base: null };
    r.updatedAt = at;
    await persist();
  }

  /**
   * The Dispatch list with this staged Return stored as a checkpoint receipt, built WITHOUT changing
   * `state` (same checks as `saveReceipt`), so a caller can commit it atomically together with other
   * changes, such as the answer Entry of "Save answer as Entry".
   * @param {string} assignmentId
   * @returns {DispatchRecord[]}
   */
  function receiptDispatches(assignmentId) {
    const r = checkedReceipt(assignmentId);
    const at = now();
    const updated = {
      ...r,
      receipts: [...r.receipts, { kind: "checkpoint", source: r.staged.source, at }],
      staged: null,
      status: "checkpoint",
      exported: { ...r.exported, base: null },
      updatedAt: at,
    };
    return state.dispatches.map((x) => (x === r ? updated : x));
  }

  /** The staged record, after the checks a checkpoint receipt requires. */
  function checkedReceipt(assignmentId) {
    const r = stagedRecord(assignmentId);
    const { meta } = parse(r.staged.source);
    assert(
      !meta.creates.length && !meta.replaces.length && !meta.deletes.length && !meta.renames.length,
      "This Return proposes file operations; accept or reject it instead.",
    );
    // Re-run the full evaluation against the current Stack: an untrusted Return that fails
    // identity, base or scope checks is never stored as this Dispatch's checkpoint.
    const failed = evaluate(r, r.staged.source).checks.find((c) => !c.ok);
    assert(!failed, `Cannot save this receipt: ${failed?.text}. Reject it or re-dispatch.`);
    return r;
  }

  return {
    route,
    stage,
    review,
    accept,
    proposedArchive,
    reject,
    receiptDispatches,
    saveReceipt,
    /** Keep the Return staged; nothing to do. */
    keepPending() {},
  };
}
