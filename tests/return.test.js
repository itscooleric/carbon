import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createState, serialize, restore, commit as commitState, persist as persistState } from "../src/carbon/state.js";
import { createDispatchController } from "../src/carbon/controller/dispatch.js";
import { createReturnController, route } from "../src/carbon/controller/return.js";
import { parseCast, encodeReturn } from "../cast-kit/src/kit.mjs";
import { patchScalarFrontmatter, entry as kitEntry } from "../cast-kit/src/validation.mjs";
import { sameStack, newStack } from "../src/core/stack.js";
import { readTar } from "../src/archives/tar.js";
import { encode } from "../src/core/validate.js";
import { sample } from "./helpers.js";
import { LocalFolder } from "../src/carbon/local-files.js";

const assets = JSON.parse(
  readFileSync(new URL("../src/carbon/castkit-assets.json", import.meta.url), "utf8"),
);
const NOTE = "entries/nested/note.md",
  OTHER = "entries/other.md",
  REPORT = "entries/report.md";
const REPORT_BODY = "---\nid: ent-report\nkind: report\n---\n# Report\n\nFrom the notes.\n";

/**
 * Workspace with both controllers and one exported report Dispatch (context NOTE + OTHER,
 * replace NOTE with `kind` metadata permitted, create REPORT).
 */
async function exported({ stack = sample(), commit, persist, metadata = true, rename = [], preset = "report" } = {}) {
  const state = createState();
  state.stack = stack;
  state.current = NOTE;
  const log = { commits: 0, persists: 0 };
  let tick = 0;
  const deps = {
    state,
    persist: persist || (async () => void log.persists++),
    commit:
      commit ||
      (async (candidate) => {
        log.commits++;
        Object.assign(state, candidate);
      }),
    download: () => {},
    clipboard: async () => {},
    assets,
    now: () => `2026-10-20T00:${String(tick++ % 60).padStart(2, "0")}:00.000Z`,
  };
  const dispatchCtl = createDispatchController(deps);
  const returnCtl = createReturnController(deps);
  const r = dispatchCtl.startDraft({ seedContext: [NOTE, OTHER], openPath: NOTE, preset });
  dispatchCtl.updateDraft(r.assignmentId, {
    objective: "Write the report.",
    consent: true,
    permissions: { ...(metadata ? { metadata: [{ path: NOTE, keys: ["kind"] }] } : {}), rename },
  });
  await dispatchCtl.export(r.assignmentId, "copy");
  return { state, dispatchCtl, returnCtl, record: r, log, id: r.assignmentId };
}
function returnFor(record, overrides = {}, files = new Map()) {
  const c = parseCast(record.exported.castSource);
  return encodeReturn(
    {
      format: "envoy.return/v0.1",
      assignment_id: c.assignment_id,
      dispatch_id: c.dispatch_id,
      stack_id: c.stack_id,
      base_revision: c.base_revision,
      checkpoint_id: "checkpoint-test-0001",
      parent_checkpoint: null,
      status: "complete",
      summary: "Report written from the supplied notes.",
      objective: c.objective,
      accepted: ["Notes are the only source."],
      evidence: ["entries/other.md: plain note, fixture."],
      decisions: ["Keep the original note."],
      completed: ["Report drafted."],
      questions: [],
      blockers: [],
      next: ["Review the report."],
      verification: ["Checked the file inventory."],
      errors: [],
      capabilities: ["text"],
      operations_performed: ["none"],
      creates: [],
      replaces: [],
      deletes: [],
      renames: [],
      boundary: "test-return-boundary-0001",
      ...overrides,
    },
    files,
  );
}
/** A complete Return: new report plus the note with `kind` patched. */
function complete(record, state, kind = "report") {
  const note = state.stack.text(NOTE);
  const front = kitEntry(note).frontmatter;
  const patched = note.replace(front, patchScalarFrontmatter(front, "kind", kind)) + "\nMore evidence.\n";
  return returnFor(
    record,
    { creates: [REPORT], replaces: [NOTE] },
    new Map([[REPORT, REPORT_BODY], [NOTE, patched]]),
  );
}
const checkMap = (model) => Object.fromEntries(model.checks.map((c) => [c.id, c]));

test("route decides by header only", () => {
  assert.equal(route("# Envoy Cast Return\n\n```yaml\n"), "cast-return");
  assert.equal(route("# Envoy Handoff\n\n```yaml\n"), "legacy-handoff");
  assert.equal(route("# Envoy Cast Return"), "unknown");
  assert.equal(route("hello"), "unknown");
  assert.equal(route(""), "unknown");
});

test("unknown formats, unknown Casts and invalid Returns are refused before staging", async () => {
  const { returnCtl, record, state } = await exported();
  await assert.rejects(returnCtl.stage("garbage"), {
    message:
      "Unknown Return format. Carbon accepts envoy.return/v0.1 Cast Returns and envoy.handoff/v0.2 packets.",
  });
  await assert.rejects(returnCtl.stage(record.exported.handoff), /Unknown Return format/);
  await assert.rejects(returnCtl.stage(returnFor(record, { assignment_id: "cast-nope" })), {
    message: "Original Cast not found for cast-nope. Import the original Cast or export a new Dispatch.",
  });
  await assert.rejects(returnCtl.stage(returnFor(record).replace("files=\"0\"", "files=\"1\"")), {
    message: /^Invalid Return: /,
  });
  await assert.rejects(returnCtl.stage(returnFor(record), "cast-other"), /Original Cast not found for cast-other/);
  assert.equal(record.status, "exported");
  assert.equal(record.staged, null);
  assert.equal(state.stack.manifest.revision, 3);
});

test("a complete in-scope Return stages with every check ok", async () => {
  const { returnCtl, record, state, log } = await exported();
  const model = await returnCtl.stage(complete(record, state));
  assert.equal(model.dispatch, record);
  assert.equal(record.status, "staged");
  assert.equal(record.staged.checkpointId, "checkpoint-test-0001");
  assert.equal(model.selfStatus, "complete");
  assert.equal(model.checkpointId, "checkpoint-test-0001");
  assert.equal(model.summary, "Report written from the supplied notes.");
  assert.deepEqual(model.unresolved, ["Review the report."]);
  assert.deepEqual(model.evidence, ["entries/other.md: plain note, fixture."]);
  assert.deepEqual(model.opsPerformed, ["none"]);
  assert.deepEqual(model.checks, [
    { id: "framing", ok: true, text: "Framing and format envoy.return/v0.1" },
    { id: "cast", ok: true, text: `Matches registered Cast ${record.assignmentId}` },
    { id: "base", ok: true, text: "Base revision 3 matches the current Stack byte-for-byte" },
    { id: "permissions", ok: true, text: "Every change is within Cast permissions" },
    { id: "ids", ok: true, text: "New Entry IDs are unique across the full Stack, including omitted Entries" },
    { id: "omitted", ok: true, text: "Omitted Entries and Assets are untouched" },
    { id: "drafts", ok: true, text: "No unsaved editor changes" },
  ]);
  assert.equal(model.canAccept, true);
  assert.equal(model.zeroOps, false);
  assert.equal(model.stale, false);
  assert.deepEqual(model.dirtyPaths, []);
  assert.equal(model.reason, "Accepting creates revision 4. Revision 3 stays in History.");
  assert.deepEqual(model.changes.map((c) => [c.op, c.path, c.permitted]), [
    ["create", REPORT, true],
    ["replace", NOTE, true],
  ]);
  assert.equal(model.changes[0].before, null);
  assert.equal(model.changes[0].after, REPORT_BODY);
  assert.equal(model.changes[1].before, state.stack.text(NOTE));
  assert.deepEqual(model.changes[1].metadata, [
    { key: "kind", before: "research", after: "report", permitted: true },
  ]);
  assert.equal(model.warning, undefined);
  assert.ok(model.warnings.length);
  assert.ok(log.persists > 0);
});

test("accept creates one revision, retains History and the receipt, and drops the base", async () => {
  const { returnCtl, record, state, log } = await exported();
  const before = sample();
  await returnCtl.stage(complete(record, state));
  const { revision } = await returnCtl.accept(record.assignmentId);
  assert.equal(revision, 4);
  assert.equal(log.commits, 1);
  assert.equal(state.stack.manifest.revision, 4);
  assert.equal(state.history.items.length, 1);
  assert.equal(state.history.items[0].label, "Before accepting Return 1");
  assert.ok(sameStack(state.history.items[0].stack, before));
  assert.equal(state.stack.text(REPORT), REPORT_BODY);
  assert.match(state.stack.text(NOTE), /kind: "report"/);
  assert.match(state.stack.text(NOTE), /# keep comment/);
  assert.match(state.stack.text("stack.yaml"), /# keep manifest comment/);
  for (const p of ["assets/bytes.bin", OTHER, "entries/日本語-☃.md"])
    assert.deepEqual(state.stack.files.get(p), before.files.get(p));
  assert.ok(state.stack.directories.has("empty"));
  const r = state.dispatches[0];
  assert.equal(r.status, "accepted");
  assert.equal(r.acceptedRevision, 4);
  assert.equal(r.staged, null);
  assert.equal(r.exported.base, null);
  assert.equal(r.receipts.length, 1);
  assert.equal(r.receipts[0].kind, "accepted");
  assert.equal(r.receipts[0].acceptance.accepted_revision, 4);
  assert.equal(r.receipts[0].acceptance.assignment_id, record.assignmentId);
  assert.equal(state.unexported, true);
  assert.equal(state.copyState, "pending");
  assert.equal(state.trusted, null);
  assert.equal(state.selected.size, 0);
  assert.equal(state.current, NOTE);
  await assert.rejects(returnCtl.accept(record.assignmentId), /no staged Return/);
});

test("a failed commit leaves the Stack, History and record unchanged", async () => {
  const { returnCtl, record, state } = await exported({
    commit: async () => {
      throw new Error("quota exceeded");
    },
  });
  await returnCtl.stage(complete(record, state));
  const stackBefore = state.stack;
  await assert.rejects(returnCtl.accept(record.assignmentId), {
    message: "Not saved: quota exceeded. The Stack is unchanged and the Return is still staged.",
  });
  assert.equal(state.stack, stackBefore);
  assert.equal(state.stack.manifest.revision, 3);
  assert.equal(state.history.items.length, 0);
  assert.equal(record.status, "staged");
  assert.ok(record.staged);
  assert.ok(record.exported.base);
  assert.deepEqual(record.receipts, []);
  assert.equal(state.dispatches[0], record);
  const archive = readTar(returnCtl.proposedArchive(record.assignmentId));
  assert.equal(archive.manifest.revision, 4);
  assert.equal(archive.text(REPORT), REPORT_BODY);
});

test("a Stack that moved past the Cast base fails the base check and cannot be accepted", async () => {
  const { returnCtl, record, state } = await exported();
  const source = complete(record, state);
  state.stack = state.stack.change({ writes: new Map([[OTHER, encode("# Edited\n")]]) });
  const model = await returnCtl.stage(source);
  assert.equal(checkMap(model).base.ok, false);
  assert.equal(checkMap(model).base.text, "Stack is now revision 4; Cast base is 3");
  assert.equal(model.stale, true);
  assert.equal(model.canAccept, false);
  assert.equal(model.reason, "Stack is now revision 4; Cast base is 3");
  assert.equal(checkMap(model).permissions.ok, true);
  assert.equal(model.changes.length, 2);
  assert.equal(record.status, "staged");
  await assert.rejects(returnCtl.accept(record.assignmentId), {
    message: "Stack moved past the Cast base; re-dispatch from the current revision",
  });
  assert.equal(state.stack.manifest.revision, 4);
  assert.equal(record.status, "staged");
  const claimed = await returnCtl.stage(returnFor(record, { base_revision: 2 }));
  assert.equal(checkMap(claimed).base.text, "Return claims base 2; Cast base is 3");
});

test("an unauthorized path fails the permissions check and is marked not permitted", async () => {
  const { returnCtl, record, state } = await exported();
  const extra = "entries/extra.md";
  const model = await returnCtl.stage(
    returnFor(
      record,
      { status: "partial", creates: [REPORT, extra] },
      new Map([[REPORT, REPORT_BODY], [extra, "---\nid: ent-extra\n---\n# Extra\n"]]),
    ),
  );
  assert.deepEqual(checkMap(model).permissions, {
    id: "permissions",
    ok: false,
    text: "entries/extra.md: creation is not permitted by the Cast",
  });
  assert.deepEqual(model.changes.map((c) => [c.op, c.path, c.permitted]), [
    ["create", REPORT, true],
    ["create", extra, false],
  ]);
  assert.equal(model.changes[1].after, "---\nid: ent-extra\n---\n# Extra\n");
  assert.equal(model.canAccept, false);
  assert.equal(model.stale, false);
  assert.equal(model.reason, "entries/extra.md: creation is not permitted by the Cast");
  assert.equal(checkMap(model).base.ok, true);
  await assert.rejects(returnCtl.accept(record.assignmentId), /Unauthorized creates/);
  assert.equal(state.stack.manifest.revision, 3);
});

test("metadata changes outside the permitted keys fail permissions", async () => {
  const { returnCtl, record, state } = await exported({ metadata: false });
  const model = await returnCtl.stage(complete(record, state));
  assert.equal(checkMap(model).permissions.ok, false);
  assert.equal(checkMap(model).permissions.text, "entries/nested/note.md: metadata kind may not change");
  assert.deepEqual(model.changes[1].metadata, [
    { key: "kind", before: "research", after: "report", permitted: false },
  ]);
  assert.equal(model.changes[1].permitted, false);
  assert.equal(model.canAccept, false);
});

test("a new Entry ID that collides with an omitted Entry fails the ids check", async () => {
  const stack = sample().change({
    writes: new Map([["entries/omitted.md", encode("---\nid: ent-omitted\n---\nKept out of the Cast.\n")]]),
  });
  const { returnCtl, record } = await exported({ stack });
  const model = await returnCtl.stage(
    returnFor(
      record,
      { status: "partial", creates: [REPORT] },
      new Map([[REPORT, REPORT_BODY.replace("ent-report", "ent-omitted")]]),
    ),
  );
  assert.equal(checkMap(model).ids.ok, false);
  assert.equal(checkMap(model).ids.text, "entries/report.md: Entry ID ent-omitted already exists in the Stack");
  assert.equal(checkMap(model).permissions.ok, true);
  assert.equal(model.canAccept, false);
  await assert.rejects(returnCtl.accept(record.assignmentId), /Duplicate Entry ID/);
});

test("unsaved drafts in affected Entries fail the drafts check and block acceptance", async () => {
  const { returnCtl, record, state } = await exported();
  state.drafts.set(NOTE, "# editing");
  const model = await returnCtl.stage(complete(record, state));
  assert.deepEqual(checkMap(model).drafts, {
    id: "drafts",
    ok: false,
    text: "Unsaved editor changes in entries/nested/note.md",
  });
  assert.deepEqual(model.dirtyPaths, [NOTE]);
  assert.equal(model.canAccept, false);
  await assert.rejects(returnCtl.accept(record.assignmentId), {
    message: "Save or discard Entry drafts before accepting.",
  });
  state.drafts.clear();
  assert.equal(returnCtl.review(record.assignmentId).canAccept, true);
});

test("zero-operation Returns become checkpoints; file operations cannot be saved as receipts", async () => {
  const { returnCtl, record, state } = await exported();
  const model = await returnCtl.stage(
    returnFor(record, { status: "blocked", blockers: ["Need the data dictionary."], verification: [] }),
  );
  assert.equal(model.zeroOps, true);
  assert.equal(model.canAccept, false);
  assert.ok(model.checks.every((c) => c.ok));
  assert.equal(model.reason, "This Return proposes no file operations; save the receipt instead.");
  assert.deepEqual(model.blockers, ["Need the data dictionary."]);
  assert.equal(model.selfStatus, "blocked");
  await assert.rejects(returnCtl.accept(record.assignmentId), /Checkpoint-only Return has no Stack mutation/);
  // receiptDispatches builds the checkpoint for an atomic commit without touching state.
  const before = structuredClone(state.dispatches);
  const candidate = returnCtl.receiptDispatches(record.assignmentId);
  assert.deepEqual(state.dispatches, before, "state is unchanged until the caller commits");
  assert.equal(record.status, "staged");
  const built = candidate.find((x) => x.assignmentId === record.assignmentId);
  assert.notEqual(built, record);
  assert.equal(built.status, "checkpoint");
  assert.equal(built.staged, null);
  assert.equal(built.receipts.at(-1).kind, "checkpoint");
  await returnCtl.saveReceipt(record.assignmentId);
  assert.equal(record.status, "checkpoint");
  assert.equal(record.staged, null);
  assert.equal(record.exported.base, null);
  assert.equal(record.receipts[0].kind, "checkpoint");
  assert.equal(state.stack.manifest.revision, 3);
  // Another Return can still be staged against the current Stack while it matches the Cast base.
  const next = await returnCtl.stage(complete(record, state));
  assert.equal(next.canAccept, true);
  await assert.rejects(returnCtl.saveReceipt(record.assignmentId), /proposes file operations/);
});

test("a zero-operation Return that fails a check cannot be saved as a checkpoint", async () => {
  const { returnCtl, record, state } = await exported();
  const base = record.exported.base;
  // Stale: the Stack moves past the Cast base after export.
  const model = await returnCtl.stage(
    returnFor(record, { status: "blocked", blockers: ["Need the data dictionary."], verification: [] }),
  );
  assert.equal(model.zeroOps, true);
  assert.equal(model.canSaveReceipt, true);
  const { encode: enc } = await import("../src/core/validate.js");
  state.stack = state.stack.change({
    writes: new Map([["entries/other.md", enc("# Edited after export\n")]]),
  });
  const stale = returnCtl.review(record.assignmentId);
  assert.equal(stale.canSaveReceipt, false);
  assert.match(stale.reason, /Stack is now revision 4; Cast base is 3/);
  await assert.rejects(returnCtl.saveReceipt(record.assignmentId), /Cannot save this receipt: Stack is now revision 4/);
  assert.equal(record.status, "staged");
  assert.equal(record.exported.base, base);
  assert.deepEqual(record.receipts, []);
});

test("a zero-operation Return with a different objective cannot be saved as a checkpoint", async () => {
  const { returnCtl, record } = await exported();
  const model = await returnCtl.stage(
    returnFor(record, {
      status: "blocked",
      blockers: ["Need the data dictionary."],
      verification: [],
      objective: "A different assignment.",
    }),
  );
  assert.equal(model.zeroOps, true);
  assert.equal(model.canSaveReceipt, false);
  await assert.rejects(returnCtl.saveReceipt(record.assignmentId), /Cannot save this receipt/);
  assert.equal(record.status, "staged");
  assert.ok(record.exported.base);
});

test("reject keeps the base so another Return can be staged", async () => {
  const { returnCtl, record, state } = await exported();
  await returnCtl.stage(complete(record, state));
  await returnCtl.reject(record.assignmentId);
  assert.equal(record.status, "rejected");
  assert.equal(record.staged, null);
  assert.ok(record.exported.base);
  assert.equal(record.receipts[0].kind, "rejected");
  await assert.rejects(returnCtl.reject(record.assignmentId), /no staged Return/);
  const model = await returnCtl.stage(complete(record, state));
  assert.equal(model.canAccept, true);
  assert.equal(record.status, "staged");
  returnCtl.keepPending();
  assert.equal(record.status, "staged");
});

test("accepted and abandoned records cannot take another Return", async () => {
  const { returnCtl, dispatchCtl, record, state } = await exported();
  const source = complete(record, state);
  await returnCtl.stage(source);
  await returnCtl.accept(record.assignmentId);
  await assert.rejects(returnCtl.stage(source), /is accepted; it cannot take another Return/);
  const other = dispatchCtl.startDraft({ seedContext: [OTHER] });
  dispatchCtl.updateDraft(other.assignmentId, { objective: "Q", consent: true });
  await dispatchCtl.export(other.assignmentId, "copy");
  dispatchCtl.abandon(other.assignmentId);
  await assert.rejects(returnCtl.stage(returnFor(other, { status: "partial" })), /is abandoned/);
});

test("a second accept while one is in flight is refused", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { returnCtl, record, state } = await exported({
    commit: async (candidate) => {
      await gate;
      Object.assign(state, candidate);
    },
  });
  await returnCtl.stage(complete(record, state));
  const first = returnCtl.accept(record.assignmentId);
  await assert.rejects(returnCtl.accept(record.assignmentId), { message: "Acceptance already in progress" });
  release();
  assert.deepEqual(await first, { revision: 4, renames: [] });
  assert.equal(state.stack.manifest.revision, 4);
});

test("a Return is refused unless its own Stack is the active workspace (Scratch, local copy or another Stack)", async () => {
  const { returnCtl, record, state } = await exported();
  const text = complete(record, state);
  const own = { stack: state.stack, dispatches: state.dispatches };
  // Another Stack is active but (wrongly) still carries the record: the explicit identity guard refuses.
  state.stack = newStack("Stack B");
  await assert.rejects(returnCtl.stage(text), /belongs to Stack .* not the open workspace/);
  assert.equal(record.status, "exported");
  // Scratch / an ordinary copy is active: Dispatch / Return requires an Envoy Stack.
  state.stack = createState().stack;
  await assert.rejects(returnCtl.stage(text), /requires an Envoy Stack/);
  assert.throws(() => returnCtl.review(record.assignmentId), /requires an Envoy Stack/);
  await assert.rejects(returnCtl.accept(record.assignmentId), /requires an Envoy Stack/);
  await assert.rejects(returnCtl.reject(record.assignmentId), /requires an Envoy Stack/);
  assert.equal(record.status, "exported");
  // A linked folder is an ordinary copy too: its link, baseline and observation do not make it a Stack.
  state.stack = new LocalFolder([["notes.md", encode("# n\n")]], [], { title: "Linked" });
  state.link = { handle: {}, consent: { granted: true, remember: false, history: true }, status: "linked", baseline: new Map([["notes.md", {}]]), observed: null };
  await assert.rejects(returnCtl.stage(text), /requires an Envoy Stack/);
  await assert.rejects(returnCtl.accept(record.assignmentId), /requires an Envoy Stack/);
  assert.equal(record.status, "exported");
  state.link = null;
  // Back on its own Stack the same Return stages normally.
  Object.assign(state, own);
  const model = await returnCtl.stage(text);
  assert.equal(model.canAccept, true);
  assert.equal(record.status, "staged");
  state.stack = newStack("Stack C");
  await assert.rejects(returnCtl.accept(record.assignmentId), /not the open workspace/);
  assert.equal(record.status, "staged");
});

test("stage still returns the model when persistence fails, with a warning", async () => {
  let failing = false;
  const { returnCtl, record, state } = await exported({
    persist: async () => {
      if (failing) throw new Error("quota");
    },
  });
  failing = true;
  const model = await returnCtl.stage(complete(record, state));
  assert.equal(model.warning, "Staged Return not saved — it will be lost on reload.");
  assert.equal(model.canAccept, true);
  assert.equal(record.status, "staged");
});

test("review rebuilds the same model after a serialize/restore round trip", async () => {
  const { returnCtl, record, state } = await exported();
  const staged = await returnCtl.stage(complete(record, state));
  const reloaded = restore(structuredClone(serialize(state)));
  const again = createReturnController({
    state: reloaded,
    persist: async () => {},
    commit: async (candidate) => Object.assign(reloaded, candidate),
    download: () => {},
  });
  const model = again.review(record.assignmentId);
  assert.deepEqual(model, staged);
  assert.notEqual(model.dispatch, record, "the restored record is a copy");
  assert.deepEqual(await again.accept(record.assignmentId), { revision: 4, renames: [] });
  assert.equal(reloaded.stack.manifest.revision, 4);
  assert.equal(state.stack.manifest.revision, 3, "the original workspace is untouched");
  assert.throws(() => again.review(record.assignmentId), /no staged Return/);
});

test("continueFrom after acceptance seeds the created report", async () => {
  const { returnCtl, dispatchCtl, record, state } = await exported();
  await returnCtl.stage(complete(record, state));
  await returnCtl.accept(record.assignmentId);
  const next = dispatchCtl.continueFrom(record.assignmentId);
  assert.deepEqual(next.draft.context, [NOTE, OTHER, REPORT]);
  assert.equal(next.baseRevision, 4);
  assert.equal(next.draft.preset, "report");
  assert.deepEqual(dispatchCtl.issues(next.assignmentId).map((i) => i.step), [0]);
});

for (const fail of [false, true]) test(`Return rename preserves workspace atomically with delayed persistence (${fail ? "failure" : "success"})`, async () => {
  const to = "entries/renamed.md", renames = [[NOTE, to]];
  let state, release, started, cached;
  const began = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const fixture = await exported({ rename:renames, preset:"question", metadata:false, commit: candidate => commitState(state, {}, candidate, async (_db, value) => {
    started(); await blocked; if (fail) throw Error("quota"); cached = structuredClone(value);
  }) });
  state = fixture.state;
  const { workspaceState } = await import("../src/carbon/workspace.js");
  state.documents = workspaceState(state.stack, NOTE, { stackId:state.stack.manifest.id, editors:[OTHER,NOTE], viewers:[NOTE,OTHER], viewer:NOTE, shown:true, scroll:{[NOTE]:450} });
  await fixture.returnCtl.stage(returnFor(fixture.record, {renames}));
  const before = serialize(state);
  const accepting = fixture.returnCtl.accept(fixture.id);
  await began;
  const delayed = persistState(state, {}, async (_db, value) => { cached = structuredClone(value); });
  release();
  if (fail) await assert.rejects(accepting, /Not saved/); else assert.deepEqual(await accepting, {revision:4,renames});
  await delayed;
  const restored = restore(cached);
  if (fail) {
    assert.deepEqual(serialize(restored), before);
    assert.equal(restored.dispatches[0].status, "staged");
  } else {
    assert.equal(restored.current, to);
    assert.deepEqual(restored.documents.editors, [OTHER,to]);
    assert.deepEqual(restored.documents.viewers, [to,OTHER]);
    assert.equal(restored.documents.viewer, to);
    assert.equal(restored.documents.scroll[to], 450);
    assert.equal(restored.dispatches[0].status, "accepted");
    assert.equal(restored.dispatches[0].staged, null);
    assert.equal(restored.history.items.length, 1);
    assert.ok(restored.stack.files.has(to));
  }
});
