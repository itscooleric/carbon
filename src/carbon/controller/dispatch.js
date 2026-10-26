/**
 * Dispatch controller: draft -> Cast -> export. Pure and DOM-free; every side effect
 * (clipboard, download, persistence) goes through injected deps so views and tests can
 * capture it. Owns every mutation of `state.dispatches` for draft/exported records.
 *
 * Trust: Entry text and paths come from the user's own Stack, but the composed packets are
 * validated by Cast Kit (`parseCast`, `registerStack`, `composeDispatch`) before any write.
 * The Cast `permissions` block is always `{network:false, execute:false, write_files:false,
 * transmit_to:[]}`; a Playbook or Entry cannot widen it.
 */
import {
  parseCast,
  parseReturn,
  registerStack,
  encodeReturn,
  dump,
  LIMITS,
} from "../../../cast-kit/src/kit.mjs";
import {
  composeDispatch,
  dispatchTar,
} from "../../../cast-kit/src/dispatch.mjs";
import { dispatch as handoffFor } from "../../core/handoff.js";
import { entry } from "../../core/entries.js";
import { assertNewPath } from "../../core/naming.js";
import { assert, encode } from "../../core/validate.js";
import { writeTar } from "../../archives/tar.js";
import { packStack, unpackStack } from "../state.js";
import { assertStack } from "../local-files.js";

/** @typedef {import("../types.js").WorkspaceState} WorkspaceState */
/** @typedef {import("../types.js").DispatchRecord} DispatchRecord */
/** @typedef {import("../types.js").DispatchDraft} DispatchDraft */
/** @typedef {import("../types.js").DispatchIssue} DispatchIssue */
/** @typedef {import("../types.js").DispatchPreview} DispatchPreview */
/** @typedef {import("../types.js").ExportVia} ExportVia */
/** @typedef {import("../types.js").CastkitAssets} CastkitAssets */
/** @typedef {import("../../core/stack.js").Stack} Stack */

/** Wizard presets. */
export const PRESETS = ["question", "plan", "report", "custom"];
/** Export destinations. */
export const TARGETS = ["text", "files", "tar"];
/** Export actions. */
export const VIAS = ["copy", "download-md", "download-files", "download-tar"];
/** Records in these states still hold their packed base Stack; at most this many at once. */
const PENDING_LIMIT = 8;
const DEFAULT_COMPLETION =
  "Every finding names its supplied source; unresolved limitations are explicit.";
const CONSTRAINT =
  "Preserve sources, accepted decisions, stable IDs and omitted files.";
const PLAYBOOK_CHARS = 16000;
const collisionMessage = (name) =>
  `Two selected files share the name ${name}; loose files cannot keep them apart. Choose TAR-capable, or deselect one.`;

const isEntryPath = (p) => typeof p === "string" && /\.md$/i.test(p);
const unique = (list) => [...new Set(list)];
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Entry paths whose frontmatter declares `kind: mission`, sorted. Exported for the UI's
 * Mission picker; the controller uses it to pre-select a Mission from the context.
 * @param {Stack} stack
 * @returns {string[]}
 */
export function missionCandidates(stack) {
  const out = [];
  for (const p of stack.files.keys()) {
    if (!isEntryPath(p)) continue;
    try {
      if (entry(stack.text(p)).data.kind === "mission") out.push(p);
    } catch {
      // An Entry that fails to parse cannot be a Mission.
    }
  }
  return out.sort();
}

/**
 * Create the dispatch controller.
 * @param {Object} deps
 * @param {WorkspaceState} deps.state
 * @param {() => Promise<void>} deps.persist queue a cache write of the live state (never rejects in Carbon)
 * @param {(candidate: Partial<WorkspaceState>) => Promise<void>} [deps.commit] accepted for symmetry with the return controller; unused (drafts and exports persist, they never swap the Stack)
 * @param {CastkitAssets} deps.assets generated `castkit-assets.json`
 * @param {(bytes: Uint8Array, name: string, type: string) => void} deps.download
 * @param {(text: string) => Promise<void>} deps.clipboard rejects when the clipboard is unavailable
 * @param {() => string} [deps.now] ISO timestamp source
 * @param {() => string} [deps.uuid] UUID source
 */
export function createDispatchController({
  state,
  persist,
  assets,
  download,
  clipboard,
  now = () => new Date().toISOString(),
  uuid = () => crypto.randomUUID(),
}) {
  // `persist` never rejects in Carbon (app.js catches and notifies); a rejecting test
  // double must not surface as an unhandled rejection from a synchronous draft edit.
  const save = () => {
    try {
      Promise.resolve(persist()).catch(() => {});
    } catch {
      // a synchronous throw from a test double is equally ignorable here
    }
  };
  const stack = () => state.stack;

  /** @param {string} id @returns {DispatchRecord} @throws when unknown or the workspace is an ordinary copy */
  function record(id) {
    // Every per-record action passes here, so callbacks rendered for an earlier Stack cannot act on an ordinary copy.
    assertStack(stack());
    const r = state.dispatches.find((x) => x.assignmentId === id);
    assert(r, `Unknown Dispatch: ${id}`);
    return r;
  }
  /** @param {string} id @returns {DispatchRecord} @throws unless status is draft */
  function draftRecord(id) {
    const r = record(id);
    assert(r.status === "draft", `Dispatch ${r.seq} is no longer a draft.`);
    return r;
  }
  /** Built-in Playbook object by display name; null when the assets lack it. */
  function builtin(name) {
    const content = assets?.playbooks?.[name];
    if (typeof content !== "string") return null;
    return {
      name,
      source: assets.sources?.[name] || `builtin:${name}`,
      content,
    };
  }
  /** First vacant `entries/report.md` / `entries/report-N.md`, or null. */
  function reportPath() {
    for (let n = 1; n <= 100; n++) {
      const candidate = n === 1 ? "entries/report.md" : `entries/report-${n}.md`;
      try {
        return assertNewPath(stack(), candidate);
      } catch {
        // taken or colliding; try the next number
      }
    }
    return null;
  }
  /**
   * Effective context and Asset selection for a draft: "complete" scope means every
   * Entry and (for file/tar targets) every Asset in the Stack.
   * @param {DispatchDraft} draft
   */
  function selection(draft) {
    const files = [...stack().files.keys()];
    if (draft.scope === "complete")
      return {
        context: files.filter(isEntryPath).sort(),
        assets: files.filter((p) => p !== "stack.yaml" && !isEntryPath(p)).sort(),
      };
    return {
      context: unique(draft.context).sort(),
      assets: unique(draft.assets).sort(),
    };
  }
  /** Human-readable `outputs` derived from permissions and preset. */
  function outputs(draft) {
    const p = draft.permissions,
      out = [];
    for (const path of p.create)
      out.push(
        draft.preset === "report"
          ? `Complete Markdown report at ${path}`
          : `Complete new Markdown Entry at ${path}`,
      );
    for (const path of p.replace)
      out.push(
        draft.preset === "plan"
          ? `Updated plan at ${path}`
          : `Complete replacement of ${path}`,
      );
    for (const m of p.metadata)
      out.push(`Permitted metadata changes at ${m.path}: ${m.keys.join(", ")}`);
    for (const path of p.delete) out.push(`Deletion of ${path}`);
    for (const [from, to] of p.rename) out.push(`Rename ${from} to ${to}`);
    return out.length
      ? out
      : ["Conversational answer in Return summary and evidence"];
  }
  /**
   * Compose the Cast object for a draft against a handoff. Field names are exactly the
   * `envoy.cast/v0.1` schema; nothing else is emitted.
   * @param {DispatchRecord} r
   * @param {{included: string[], dispatchId: string}} handoff
   */
  function cast(r, handoff) {
    const d = r.draft,
      p = d.permissions,
      { assets: selectedAssets } = selection(d);
    const create = unique(p.create),
      replace = unique(p.replace);
    const required = unique([
      ...create,
      ...(d.preset === "plan" || d.preset === "report" ? replace : []),
    ]).filter((x) => create.includes(x) || replace.includes(x));
    return {
      format: "envoy.cast/v0.1",
      contract: "envoy.operating/v0.1",
      assignment_id: r.assignmentId,
      dispatch_id: handoff.dispatchId,
      stack_id: stack().manifest.id,
      base_revision: stack().manifest.revision,
      mission: d.mission,
      objective: d.objective,
      read: [...handoff.included],
      replace,
      create,
      delete: unique(p.delete),
      rename: p.rename.map(([a, b]) => [a, b]),
      outputs: outputs(d),
      constraints: [CONSTRAINT],
      permissions: {
        network: false,
        execute: false,
        write_files: false,
        transmit_to: [],
      },
      completion: d.criteria.length ? [...d.criteria] : [DEFAULT_COMPLETION],
      return_format: "envoy.return/v0.1",
      playbooks: d.playbooks.map(({ name, source, content }) => ({
        name,
        source,
        content,
      })),
      metadata: p.metadata.map(({ path, keys }) => ({ path, keys: [...keys] })),
      assets: selectedAssets,
      required_files: required,
    };
  }
  /** Empty Return skeleton with the Cast identity, like the workbench template. */
  function returnTemplate(c) {
    return encodeReturn(
      {
        format: "envoy.return/v0.1",
        assignment_id: c.assignment_id,
        dispatch_id: c.dispatch_id,
        stack_id: c.stack_id,
        base_revision: c.base_revision,
        checkpoint_id: `checkpoint-${uuid()}`,
        parent_checkpoint: null,
        status: "partial",
        summary: "Replace this summary with actual progress.",
        objective: c.objective,
        accepted: [],
        evidence: [],
        decisions: [],
        completed: [],
        questions: [],
        blockers: [],
        next: ["Continue the assigned work."],
        verification: [],
        errors: [],
        capabilities: [],
        operations_performed: [],
        creates: [],
        replaces: [],
        deletes: [],
        renames: [],
        boundary: `envoy-return-${uuid().replace(/-/g, "")}`,
      },
      new Map(),
    );
  }
  /** Asset bytes for the selected paths, from a Stack. */
  function assetBytes(paths, from) {
    const map = new Map();
    for (const p of paths) {
      assert(from.files.has(p), `Asset no longer available: ${p}`);
      map.set(p, from.files.get(p));
    }
    return map;
  }
  /**
   * Build handoff, Cast, template and composed package for a draft; validates through
   * Cast Kit. Random boundary/ids make each call distinct; no state is touched.
   */
  function compose(r, mode) {
    const { context, assets: selectedAssets } = selection(r.draft);
    const handoff = handoffFor(stack(), context);
    const c = cast(r, handoff),
      castSource = dump(c);
    registerStack(stack(), castSource, handoff.text);
    const template = returnTemplate(c);
    const composed = composeDispatch({
      castSource,
      originalHandoff: handoff.text,
      contract: assets.contract,
      bootstrap: assets.bootstrap,
      returnTemplate: template,
      mode,
      assets: assetBytes(selectedAssets, stack()),
    });
    return { handoff, cast: c, castSource, template, composed };
  }
  /**
   * Loose-file names for a Files export (`dispatch.md` plus each Asset's own file name) and
   * the first case-insensitive collision among them, if any. Shared by `issues()`,
   * `actionsFor()` and `write()` so the blocker, the offered buttons and the refusal agree.
   * @param {DispatchRecord} r
   * @param {string[]} assetPaths
   * @returns {{text: string, attachments: {path: string, name: string}[], collision: string|null}}
   */
  function looseFiles(r, assetPaths) {
    const text = `${stack().manifest.id}-dispatch-${r.seq}.dispatch.md`;
    const attachments = assetPaths.map((path) => ({ path, name: path.split("/").pop() }));
    const seen = new Set([text.toUpperCase()]);
    let collision = null;
    for (const { name } of attachments) {
      if (seen.has(name.toUpperCase())) {
        collision = name;
        break;
      }
      seen.add(name.toUpperCase());
    }
    return { text, attachments, collision };
  }
  /**
   * Export actions a record's draft supports, primary first. The single source of truth for
   * both `write()` and the views: complete scope only as the TAR; Assets never through the
   * text-only actions (`copy`, `download-md`); otherwise the target's own download plus copy.
   * @param {DispatchRecord} r
   * @returns {ExportVia[]}
   */
  function actionsFor(r) {
    const d = r.draft;
    if (d.scope === "complete") return ["download-tar"];
    const selected = selection(d).assets;
    const text = selected.length ? [] : ["copy", "download-md"];
    if (d.target === "files")
      return looseFiles(r, selected).collision ? text : ["download-files", ...text];
    if (d.target === "tar") return ["download-tar", ...text];
    return text;
  }
  /**
   * Write the composed package through the requested channel. Throws before any state change.
   * - `copy` / `download-md`: the self-contained `dispatch.md` text (no Assets).
   * - `download-files`: `dispatch.md` plus each selected Asset under its original file name,
   *   matching the `assets` paths the Cast in that text lists. The `envoy.dispatch/v0.1`
   *   manifest (generated `assets/0001.bin` names) only describes the TAR package, so it is
   *   not emitted as a loose file.
   * - `download-tar`: the selected `.dispatch.tar` package, or for complete scope the actual
   *   complete `.stack.tar` of the Cast base plus `dispatch.md` (which carries the Cast).
   * @param {DispatchRecord} r
   * @param {ExportVia} via
   * @param {ReturnType<typeof composeDispatch>} composed
   * @param {Stack|null} base the Stack the Cast was built against (null once no longer retained)
   */
  async function write(r, via, composed, base) {
    assert(VIAS.includes(via), `Unknown export action: ${via}`);
    const name = `${composed.manifest.stack_id}-dispatch-${r.seq}.dispatch`;
    const text = () => download(encode(composed.text), `${name}.md`, "text/markdown");
    assert(
      r.draft.scope !== "complete" || via === "download-tar",
      "Complete Stack scope exports only as a TAR (.stack.tar + dispatch.md).",
    );
    if (via === "copy" || via === "download-md")
      assert(
        !composed.manifest.assets.length,
        "Text export cannot carry Assets; choose Download files or TAR.",
      );
    assert(
      actionsFor(r).includes(via),
      `This Dispatch's destination does not support ${via}; use ${actionsFor(r).join(" or ") || "another destination"}.`,
    );
    if (via === "copy") {
      try {
        await clipboard(composed.text);
      } catch {
        throw new Error("Clipboard unavailable — use Download instead");
      }
    } else if (via === "download-md") text();
    else if (via === "download-tar" && r.draft.scope === "complete") {
      assert(
        base,
        `Dispatch ${r.seq}'s complete base Stack is no longer retained; export the current Stack instead.`,
      );
      const archive = writeTar(base);
      download(
        archive,
        `${base.manifest.id}-r${base.manifest.revision}.stack.tar`,
        "application/x-tar",
      );
      text();
    } else if (via === "download-tar")
      download(dispatchTar(composed.files), `${name}.tar`, "application/x-tar");
    else {
      const loose = looseFiles(r, composed.manifest.assets.map((a) => a.path));
      assert(!loose.collision, collisionMessage(loose.collision));
      text();
      for (const [i, { name: file }] of loose.attachments.entries())
        download(
          composed.files.get(composed.manifest.assets[i].packaged_as),
          file,
          "application/octet-stream",
        );
    }
  }
  /** Mint a draft record with a fresh assignment id and the next seq. */
  function create(draft) {
    const seq = state.dispatches.reduce((n, r) => Math.max(n, r.seq || 0), 0) + 1;
    const at = now();
    /** @type {DispatchRecord} */
    const r = {
      assignmentId: `cast-${uuid()}`,
      seq,
      status: "draft",
      stackId: stack().manifest.id,
      baseRevision: stack().manifest.revision,
      createdAt: at,
      updatedAt: at,
      draft,
      exported: null,
      staged: null,
      receipts: [],
      acceptedRevision: null,
    };
    state.dispatches.push(r);
    save();
    return r;
  }
  const existing = (p) => isEntryPath(p) && stack().files.has(p);
  const blankDraft = () => ({
    preset: "custom",
    objective: "",
    mission: null,
    criteria: [],
    context: [],
    assets: [],
    scope: "selected",
    playbooks: [],
    permissions: { create: [], replace: [], metadata: [], delete: [], rename: [] },
    target: "text",
    consent: false,
    step: 0,
  });

  /**
   * Start a draft seeded from the sidebar selection or the open Entry, with preset pre-fills.
   * @param {{seedContext?: string[], openPath?: string|null, preset?: string}} [options]
   * @returns {DispatchRecord}
   */
  function startDraft({ seedContext = [], openPath = null, preset = "question" } = {}) {
    assertStack(stack());
    assert(PRESETS.includes(preset), `Unknown preset: ${preset}`);
    const draft = blankDraft();
    draft.preset = preset;
    let context = unique(seedContext.filter(existing));
    if (!context.length && existing(openPath)) context = [openPath];
    draft.context = context.sort();
    const missions = missionCandidates(stack());
    draft.mission = draft.context.find((p) => missions.includes(p)) ?? null;
    const open = existing(openPath) ? [openPath] : [];
    if (preset === "question") draft.playbooks = [builtin("Research")];
    else if (preset === "plan") {
      draft.playbooks = [builtin("Planning")];
      draft.permissions.replace = open;
    } else if (preset === "report") {
      draft.playbooks = [builtin("Research"), builtin("Report generation")];
      draft.permissions.replace = open;
      const report = reportPath();
      draft.permissions.create = report ? [report] : [];
    }
    draft.playbooks = draft.playbooks.filter(Boolean);
    return create(draft);
  }

  /**
   * Merge a partial draft into a draft record. Field types are checked lightly; unknown
   * keys are rejected. Persists (the UI debounces its own calls).
   * @param {string} assignmentId
   * @param {Partial<DispatchDraft>} patch
   * @returns {DispatchRecord}
   */
  function updateDraft(assignmentId, patch) {
    const r = draftRecord(assignmentId),
      d = { ...r.draft };
    for (const [k, v] of Object.entries(patch || {})) {
      switch (k) {
        case "preset":
          assert(PRESETS.includes(v), "Invalid preset");
          break;
        case "objective":
          assert(typeof v === "string", "Objective must be text");
          break;
        case "mission":
          assert(v === null || typeof v === "string", "Mission must be a path or null");
          break;
        case "criteria":
        case "context":
        case "assets":
          assert(strings(v), `${k} must be a list of strings`);
          break;
        case "scope":
          assert(["selected", "complete"].includes(v), "Invalid scope");
          break;
        case "playbooks":
          assert(
            Array.isArray(v) &&
              v.length <= 8 &&
              v.every(
                (p) =>
                  p &&
                  typeof p.name === "string" &&
                  typeof p.source === "string" &&
                  typeof p.content === "string",
              ),
            "Playbooks must be {name, source, content} objects (at most eight)",
          );
          break;
        case "permissions":
          assert(v && typeof v === "object", "Invalid permissions");
          for (const [pk, pv] of Object.entries(v)) {
            if (pk === "metadata")
              assert(
                Array.isArray(pv) &&
                  pv.every((m) => m && typeof m.path === "string" && strings(m.keys)),
                "metadata permissions must be {path, keys[]}",
              );
            else if (pk === "rename")
              assert(
                Array.isArray(pv) &&
                  pv.every(
                    (x) =>
                      Array.isArray(x) &&
                      x.length === 2 &&
                      x.every((s) => typeof s === "string"),
                  ),
                "rename permissions must be [from, to] pairs",
              );
            else
              assert(
                ["create", "replace", "delete"].includes(pk) && strings(pv),
                `Invalid permission list: ${pk}`,
              );
          }
          break;
        case "target":
          assert(TARGETS.includes(v), "Invalid target");
          break;
        case "consent":
          assert(typeof v === "boolean", "Consent must be boolean");
          break;
        case "step":
          assert(Number.isInteger(v) && v >= 0 && v <= 4, "Step must be 0..4");
          break;
        default:
          throw new Error(`Unknown draft field: ${k}`);
      }
      d[k] = k === "permissions" ? { ...d.permissions, ...v } : v;
    }
    r.draft = d;
    r.updatedAt = now();
    save();
    return r;
  }

  /**
   * Step-tagged blockers. Empty means the draft is exportable. Never throws for an
   * invalid draft: every problem becomes an issue.
   * @param {string} assignmentId
   * @returns {DispatchIssue[]}
   */
  function issues(assignmentId) {
    const r = record(assignmentId);
    if (r.status !== "draft") return [];
    const d = r.draft,
      s = stack(),
      p = d.permissions,
      out = [];
    const issue = (step, text, fix) => out.push(fix ? { step, text, fix } : { step, text });
    if (!d.objective.trim()) issue(0, "Objective is required.");
    const { context, assets: selectedAssets } = selection(d);
    for (const c of context) {
      if (!existing(c)) issue(1, `Context Entry no longer exists: ${c}`, "remove");
      else if (state.drafts.has(c))
        issue(1, `Unsaved draft in ${c}. Save it or remove it from the context.`, "save");
    }
    if (d.mission !== null && !context.includes(d.mission))
      issue(1, `Mission ${d.mission} must be an included context Entry.`, "include");
    for (const a of selectedAssets)
      if (a === "stack.yaml" || isEntryPath(a) || !s.files.has(a))
        issue(1, `Not an available Asset: ${a}`, "remove");
    if (d.playbooks.length > 8) issue(2, "At most eight Playbooks.");
    const names = new Set();
    for (const pb of d.playbooks) {
      if (names.has(pb.name)) issue(2, `Duplicate Playbook name: ${pb.name}`);
      names.add(pb.name);
      if (!pb.content.trim()) issue(2, `Playbook "${pb.name}" is empty.`);
      else if (pb.content.length > PLAYBOOK_CHARS || encode(pb.content).length > PLAYBOOK_CHARS)
        issue(2, `Playbook "${pb.name}" exceeds ${PLAYBOOK_CHARS} characters.`);
    }
    const targets = [...p.create, ...p.rename.map((x) => x[1])];
    for (const t of targets) {
      try {
        assertNewPath(s, t);
      } catch (e) {
        issue(3, e.message);
      }
    }
    const seen = new Map();
    for (const t of targets) {
      const key = t.toUpperCase();
      if (seen.has(key) && seen.get(key) !== t)
        issue(3, `New paths collide case-insensitively: ${seen.get(key)} and ${t}`);
      else if (seen.has(key)) issue(3, `Duplicate new path: ${t}`);
      seen.set(key, t);
    }
    for (const [label, list] of [
      ["replaced", p.replace],
      ["deleted", p.delete],
      ["renamed", p.rename.map((x) => x[0])],
    ])
      for (const src of list) {
        if (!existing(src)) issue(3, `Cannot be ${label}: ${src} is not an existing Entry.`);
        else if (!context.includes(src))
          issue(3, `${src} must be in the context to be ${label}.`, "include");
      }
    for (const m of p.metadata)
      if (!p.replace.includes(m.path))
        issue(3, `Metadata permission for ${m.path} requires replace permission.`);
    // Complete scope means "hand over the importable complete Stack archive"; only the TAR
    // target produces it, so any other destination is refused rather than silently narrowed.
    if (d.scope === "complete" && d.target !== "tar")
      issue(
        4,
        "Complete Stack scope exports only as a TAR (.stack.tar + dispatch.md); choose TAR-capable or switch to selected context.",
      );
    else if (selectedAssets.length && d.target === "text")
      issue(4, "Text export cannot carry Assets; deselect them or choose Files or TAR.");
    else if (d.target === "files" && looseFiles(r, selectedAssets).collision)
      issue(4, collisionMessage(looseFiles(r, selectedAssets).collision));
    const pending = state.dispatches.filter((x) => x.exported?.base).length;
    if (pending >= PENDING_LIMIT)
      issue(
        4,
        `${PENDING_LIMIT} Dispatches already await a Return; accept, reject or abandon one before exporting.`,
      );
    // Cast size and anything the schema rejects that the checks above did not name.
    try {
      const c = cast(r, { included: ["stack.yaml", ...context].sort(), dispatchId: "dispatch-preview" });
      const source = dump(c);
      if (encode(source).length > LIMITS.yaml)
        issue(2, "Cast exceeds 64 KiB; remove Playbooks or shorten the objective and criteria.");
      else if (!out.length) parseCast(source);
    } catch (e) {
      issue(4, e.message);
    }
    return out;
  }

  /**
   * Compose the Cast and package without side effects (random boundary/ids aside).
   * @param {string} assignmentId
   * @returns {DispatchPreview}
   * @throws {Error} with the Cast Kit message when the composition is rejected
   */
  function preview(assignmentId) {
    const r = draftRecord(assignmentId);
    const { assets: selectedAssets } = selection(r.draft);
    // The text is identical in every mode; only text mode refuses Assets, which issues() reports.
    const mode = r.draft.target === "text" && selectedAssets.length ? "files" : r.draft.target;
    const { handoff, castSource, composed } = compose(r, mode);
    let assetBytesTotal = 0;
    for (const a of composed.manifest.assets) assetBytesTotal += a.bytes;
    return {
      castSource,
      included: [...handoff.included],
      omitted: [...handoff.omitted],
      sizes: {
        castBytes: encode(castSource).length,
        textBytes: encode(composed.text).length,
        assetBytes: assetBytesTotal,
      },
    };
  }

  /**
   * Export a draft: compose -> write clipboard/file FIRST -> record exported + base -> persist.
   * A clipboard failure leaves the record a draft.
   * @param {string} assignmentId
   * @param {ExportVia} via
   * @returns {Promise<{text: string}>}
   * @throws {Error} when issues remain, consent is missing, or the write fails
   */
  async function exportDraft(assignmentId, via) {
    const r = draftRecord(assignmentId);
    const problems = issues(assignmentId);
    assert(!problems.length, problems.map((x) => x.text).join(" "));
    assert(r.draft.consent, "Confirm the data-handling consent before exporting.");
    const { handoff, castSource, template, composed } = compose(r, r.draft.target);
    await write(r, via, composed, stack());
    r.exported = {
      castSource,
      handoff: handoff.text,
      dispatchId: handoff.dispatchId,
      returnTemplate: template,
      via,
      at: now(),
      base: packStack(stack()),
    };
    r.stackId = stack().manifest.id;
    r.baseRevision = stack().manifest.revision;
    r.status = "exported";
    r.updatedAt = r.exported.at;
    await persist();
    return { text: composed.text };
  }

  /** Recompose the stored package byte-for-byte. */
  function recompose(r) {
    assert(r.exported, `Dispatch ${r.seq} has not been exported.`);
    const c = parseCast(r.exported.castSource);
    const from = r.exported.base ? unpackStack(r.exported.base) : stack();
    return composeDispatch({
      castSource: r.exported.castSource,
      originalHandoff: r.exported.handoff,
      contract: assets.contract,
      bootstrap: assets.bootstrap,
      returnTemplate: r.exported.returnTemplate,
      mode: r.draft.target,
      assets: assetBytes(c.assets, from),
    });
  }

  /**
   * Write the exported package again (same bytes, no new Cast).
   * @param {string} assignmentId
   * @param {ExportVia} via
   * @returns {Promise<{text: string}>}
   */
  async function exportAgain(assignmentId, via) {
    const r = record(assignmentId);
    const composed = recompose(r);
    await write(r, via, composed, r.exported.base ? unpackStack(r.exported.base) : null);
    r.updatedAt = now();
    await persist();
    return { text: composed.text };
  }

  /**
   * Download the exported Cast YAML as `<assignmentId>.cast.yaml`.
   * @param {string} assignmentId
   */
  function downloadCast(assignmentId) {
    const r = record(assignmentId);
    assert(r.exported, `Dispatch ${r.seq} has not been exported.`);
    download(encode(r.exported.castSource), `${r.assignmentId}.cast.yaml`, "application/yaml");
  }

  /**
   * Remove a draft.
   * @param {string} assignmentId
   */
  function discard(assignmentId) {
    const r = draftRecord(assignmentId);
    state.dispatches = state.dispatches.filter((x) => x !== r);
    save();
  }

  /**
   * Abandon a Dispatch that awaits a Return (exported, staged or rejected): drops the
   * staged Return and the retained base.
   * @param {string} assignmentId
   */
  function abandon(assignmentId) {
    const r = record(assignmentId);
    assert(
      ["exported", "staged", "rejected"].includes(r.status),
      `Dispatch ${r.seq} cannot be abandoned while ${r.status}.`,
    );
    r.status = "abandoned";
    r.staged = null;
    if (r.exported) r.exported = { ...r.exported, base: null };
    r.updatedAt = now();
    save();
  }

  /** Paths an accepted Return created or renamed to, from the stored receipts. */
  function createdBy(r) {
    const out = [];
    for (const receipt of r.receipts) {
      if (receipt.kind !== "accepted") continue;
      try {
        const { meta } = parseReturn(receipt.source);
        out.push(...meta.creates, ...meta.renames.map((x) => x[1]));
      } catch {
        // A receipt that no longer parses contributes nothing.
      }
    }
    return out;
  }

  /**
   * New draft after an accepted or checkpoint Return: prior context that still exists plus
   * the paths the accepted Return created, same preset and Playbooks, at the current revision.
   * @param {string} assignmentId
   * @returns {DispatchRecord}
   */
  function continueFrom(assignmentId) {
    const prior = record(assignmentId);
    assert(
      ["accepted", "checkpoint"].includes(prior.status),
      `Dispatch ${prior.seq} has no accepted or checkpoint Return to continue from.`,
    );
    const draft = blankDraft();
    draft.preset = prior.draft.preset;
    draft.playbooks = prior.draft.playbooks.map((p) => ({ ...p }));
    draft.target = prior.draft.target;
    draft.context = unique([...prior.draft.context, ...createdBy(prior)].filter(existing)).sort();
    draft.mission =
      prior.draft.mission && draft.context.includes(prior.draft.mission)
        ? prior.draft.mission
        : null;
    return create(draft);
  }

  /**
   * New draft copying the assignment of a stale or finished Dispatch to the current revision.
   * The old record is untouched.
   * @param {string} assignmentId
   * @returns {DispatchRecord}
   */
  function redispatch(assignmentId) {
    const prior = record(assignmentId),
      d = prior.draft;
    const draft = blankDraft();
    draft.preset = d.preset;
    draft.objective = d.objective;
    draft.criteria = [...d.criteria];
    draft.context = unique(d.context.filter(existing)).sort();
    draft.assets = unique(d.assets.filter((a) => stack().files.has(a))).sort();
    draft.scope = d.scope;
    draft.playbooks = d.playbooks.map((p) => ({ ...p }));
    draft.permissions = {
      create: [...d.permissions.create],
      replace: d.permissions.replace.filter(existing),
      metadata: d.permissions.metadata.map((m) => ({ path: m.path, keys: [...m.keys] })),
      delete: d.permissions.delete.filter(existing),
      rename: d.permissions.rename.filter(([from]) => existing(from)).map((x) => [x[0], x[1]]),
    };
    draft.permissions.metadata = draft.permissions.metadata.filter((m) =>
      draft.permissions.replace.includes(m.path),
    );
    draft.target = d.target;
    draft.mission = d.mission && draft.context.includes(d.mission) ? d.mission : null;
    return create(draft);
  }

  return {
    startDraft,
    updateDraft,
    discard,
    abandon,
    issues,
    preview,
    export: exportDraft,
    exportAgain,
    downloadCast,
    /** @param {string} assignmentId @returns {ExportVia[]} supported export actions, primary first */
    exportActions: (assignmentId) => actionsFor(record(assignmentId)),
    continueFrom,
    redispatch,
    /** @param {string} assignmentId @returns {DispatchRecord|undefined} */
    find: (assignmentId) => state.dispatches.find((x) => x.assignmentId === assignmentId),
    /** @returns {DispatchRecord[]} a copy, oldest first */
    list: () => [...state.dispatches],
  };
}
