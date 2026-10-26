import test from "node:test";
import assert from "node:assert/strict";
import {
  createState,
  blankState,
  mountRecord,
  serialize,
  restore,
  persist,
  commit,
} from "../src/carbon/state.js";
import { History, sameStack } from "../src/core/stack.js";
import { sample } from "./helpers.js";
import { dispatch } from "../src/core/handoff.js";

function draftRecord(overrides = {}) {
  return {
    assignmentId: "cast-1",
    seq: 1,
    status: "draft",
    stackId: "stk-test",
    baseRevision: 3,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    draft: {
      preset: "question",
      objective: "Ask.",
      mission: null,
      criteria: [],
      context: ["entries/other.md"],
      assets: [],
      scope: "selected",
      playbooks: [{ name: "Research", source: "builtin:research", content: "# Research\n" }],
      permissions: { create: [], replace: [], metadata: [], delete: [], rename: [] },
      target: "text",
      consent: false,
      step: 0,
    },
    exported: null,
    staged: null,
    receipts: [],
    acceptedRevision: null,
    ...overrides,
  };
}
function workspace() {
  const state = blankState();
  const base = sample();
  state.history.push(state.stack, "Before import");
  state.stack = base;
  state.current = "entries/other.md";
  state.drafts.set("entries/other.md", "# Draft");
  state.selected.add("entries/other.md");
  state.trusted = dispatch(base, ["entries/other.md"]);
  state.unexported = false;
  state.copyState = "imported";
  state.dispatches = [draftRecord()];
  state.lastArchiveRevision = 3;
  return state;
}
function fakeDb(fail = false) {
  const writes = [];
  const write = async (db, value) => {
    assert.equal(db, handle);
    if (fail) throw new Error("quota exceeded");
    writes.push(structuredClone(value));
  };
  const handle = { writes, write };
  return handle;
}
test("createState opens Scratch with one empty, editable Markdown note (WorkspaceState contract)", () => {
  const state = createState(new Date(2026, 9, 23, 12));
  assert.deepEqual(Object.keys(state).sort(), [
    "copyState",
    "current",
    "dispatches",
    "documents",
    "drafts",
    "history",
    "lastArchiveRevision",
    "link",
    "selected",
    "stack",
    "trusted",
    "unexported",
  ]);
  assert.ok(state.history instanceof History);
  assert.deepEqual(state.dispatches, []);
  assert.equal(state.lastArchiveRevision, -1);
  assert.equal(state.copyState, "pending");
  assert.equal(state.unexported, false, "a pristine Scratch never prompts on close");
  assert.equal(state.stack.kind, "folder");
  assert.equal(state.stack.manifest.id, "local-scratch");
  assert.equal(state.stack.manifest.title, "Scratch");
  assert.deepEqual([...state.stack.files.keys()], ["2026-10-23.md"]);
  assert.equal(state.stack.files.get("2026-10-23.md").length, 0);
  assert.equal(state.current, "2026-10-23.md");
  assert.equal(state.link, null);
  // The blank state for a new mount is the old empty-Stack contract.
  const blank = blankState();
  assert.deepEqual(Object.keys(blank).sort(), Object.keys(state).sort());
  assert.equal(blank.stack.kind, undefined);
  assert.equal(blank.unexported, true);
  assert.equal(blank.current, null);
});
test("mountRecord adds stable identity, kind and title to the serialized state", () => {
  const scratch = mountRecord(createState(), new Date("2026-10-23T00:00:00Z"));
  assert.equal(scratch.id, "local-scratch");
  assert.equal(scratch.kind, "scratch");
  assert.equal(scratch.title, "Scratch");
  assert.equal(scratch.updatedAt, "2026-10-23T00:00:00.000Z");
  assert.equal("rev" in scratch, false, "the store assigns rev");
  const live = workspace(), stack = mountRecord(live);
  assert.equal(stack.kind, "stack");
  assert.equal(stack.id, live.stack.manifest.id);
  const { id, kind, title, updatedAt, ...rest } = stack;
  assert.deepEqual(rest, serialize(live));
});
test("serialize/restore round trip preserves every persisted field", () => {
  const state = workspace();
  const record = structuredClone(serialize(state));
  const back = restore(record);
  assert.ok(sameStack(back.stack, state.stack));
  assert.equal(back.history.items.length, 1);
  assert.ok(sameStack(back.history.items[0].stack, state.history.items[0].stack));
  assert.equal(back.history.items[0].label, "Before import");
  assert.equal(back.current, "entries/other.md");
  assert.deepEqual([...back.drafts], [["entries/other.md", "# Draft"]]);
  assert.equal(back.selected.size, 0, "selection is session-only");
  assert.ok(sameStack(back.trusted.base, state.trusted.base));
  assert.equal(back.trusted.text, state.trusted.text);
  assert.deepEqual(back.trusted.included, state.trusted.included);
  assert.equal(back.unexported, false);
  assert.equal(back.copyState, "imported");
  assert.deepEqual(back.dispatches, state.dispatches);
  assert.equal(back.lastArchiveRevision, 3);
});
test("restore tolerates older cache records and invalid values", () => {
  const state = workspace();
  const legacy = serialize(state);
  delete legacy.dispatches;
  delete legacy.lastArchiveRevision;
  delete legacy.copyState;
  legacy.unexported = false;
  legacy.current = "entries/missing.md";
  legacy.drafts = [
    ["entries/missing.md", "x"],
    ["entries/other.md", "# Kept"],
  ];
  legacy.trusted = null;
  const back = restore(legacy);
  assert.deepEqual(back.dispatches, []);
  assert.equal(back.lastArchiveRevision, -1);
  assert.equal(back.copyState, "pending");
  assert.equal(back.unexported, true, "records without copyState need export");
  assert.equal(back.current, null);
  assert.deepEqual([...back.drafts], [["entries/other.md", "# Kept"]]);
  assert.equal(back.trusted, null);
  const odd = serialize(state);
  odd.copyState = "bogus";
  odd.lastArchiveRevision = "7";
  odd.dispatches = "not a list";
  assert.equal(restore(odd).copyState, "pending");
  assert.equal(restore(odd).lastArchiveRevision, -1);
  assert.deepEqual(restore(odd).dispatches, []);
  const damaged = serialize(state);
  damaged.stack = { files: [["../escape.md", new Uint8Array()]], directories: [] };
  assert.throws(() => restore(damaged));
});
test("persist writes the serialized state in order and resolves without a cache", async () => {
  const state = workspace();
  const db = fakeDb();
  await persist(state, null, db.write);
  assert.equal(db.writes.length, 0);
  const first = persist(state, db, db.write);
  state.current = null;
  const second = persist(state, db, db.write);
  await Promise.all([first, second]);
  assert.equal(db.writes.length, 2);
  assert.equal(db.writes[0].current, null, "queued persistence snapshots live state at execution");
  assert.equal(db.writes[1].current, null);
  const failing = fakeDb(true);
  await assert.rejects(() => persist(state, failing, failing.write), /quota/);
});
test("commit writes the candidate first and swaps only on success", async () => {
  const state = workspace();
  const db = fakeDb();
  const next = sample().change({ directories: new Set(["added"]) });
  await commit(
    state,
    db,
    { stack: next, copyState: "pending", unexported: true, lastArchiveRevision: 9 },
    db.write,
  );
  assert.equal(db.writes.length, 1);
  assert.deepEqual(db.writes[0].stack.directories, [...next.directories]);
  assert.equal(db.writes[0].lastArchiveRevision, 9);
  assert.equal(db.writes[0].current, "entries/other.md", "untouched fields are merged");
  assert.equal(state.stack, next);
  assert.equal(state.copyState, "pending");
  assert.equal(state.lastArchiveRevision, 9);
});
test("commit failure leaves the state untouched and rejects", async () => {
  const state = workspace();
  const before = { ...state };
  const failing = fakeDb(true);
  await assert.rejects(
    () => commit(state, failing, { copyState: "pending", current: null }, failing.write),
    /quota/,
  );
  assert.equal(state.copyState, "imported");
  assert.equal(state.current, "entries/other.md");
  assert.equal(state.stack, before.stack);
  assert.equal(state.history, before.history);
});
test("commit without a cache assigns immediately", async () => {
  const state = workspace();
  let called = false;
  await commit(state, null, { copyState: "folder" }, async () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(state.copyState, "folder");
});

test("restore skips malformed or duplicate Dispatch records and still recovers the Stack", async () => {
  const { readFileSync } = await import("node:fs");
  const { createDispatchController } = await import("../src/carbon/controller/dispatch.js");
  const { createReturnController } = await import("../src/carbon/controller/return.js");
  const { parseCast, encodeReturn } = await import("../cast-kit/src/kit.mjs");
  const assets = JSON.parse(readFileSync(new URL("../src/carbon/castkit-assets.json", import.meta.url), "utf8"));
  // Real records from the controllers: one draft, one exported, one staged.
  const state = createState();
  state.stack = sample();
  const deps = { state, persist: async () => {}, commit: async () => {}, assets, download: () => {}, clipboard: async () => {} };
  const dispatchCtl = createDispatchController(deps),
    returnCtl = createReturnController(deps);
  const draft = dispatchCtl.startDraft({ seedContext: ["entries/other.md"] });
  dispatchCtl.updateDraft(draft.assignmentId, { objective: "Still a draft." });
  const exported = dispatchCtl.startDraft({ seedContext: ["entries/other.md"] });
  dispatchCtl.updateDraft(exported.assignmentId, { objective: "Exported.", consent: true });
  await dispatchCtl.export(exported.assignmentId, "copy");
  const staged = dispatchCtl.startDraft({ seedContext: ["entries/other.md"] });
  dispatchCtl.updateDraft(staged.assignmentId, { objective: "Staged.", consent: true });
  await dispatchCtl.export(staged.assignmentId, "copy");
  const c = parseCast(staged.exported.castSource);
  await returnCtl.stage(
    encodeReturn(
      {
        format: "envoy.return/v0.1", assignment_id: c.assignment_id, dispatch_id: c.dispatch_id, stack_id: c.stack_id,
        base_revision: c.base_revision, checkpoint_id: "checkpoint-state-1", parent_checkpoint: null, status: "blocked",
        summary: "Need more.", objective: c.objective, accepted: [], evidence: [], decisions: [], completed: [],
        questions: [], blockers: ["Missing data."], next: [], verification: [], errors: [], capabilities: ["text"],
        operations_performed: [], creates: [], replaces: [], deletes: [], renames: [], boundary: "state-test-boundary-0001",
      },
      new Map(),
    ),
  );
  const good = serialize(state).dispatches;
  assert.deepEqual(good.map((r) => r.status), ["draft", "exported", "staged"]);
  // Draft variants get fresh ids; exported/staged variants keep the real id so each is rejected
  // for its own corruption alone (validation runs before de-duplication, so the good copy
  // listed later still survives).
  const variant = (from, change, freshId = false) => {
    const copy = structuredClone(from);
    if (freshId) copy.assignmentId = `cast-variant-${(variant.n = (variant.n || 0) + 1)}`;
    change(copy);
    return copy;
  };
  const [d, x, st] = good;
  const cached = serialize(state);
  cached.dispatches = [
    {},
    null,
    "cast-9",
    variant(d, (r) => (r.draft.objective = 7), true),
    variant(d, (r) => (r.status = "sent"), true),
    variant(x, (r) => (r.exported.base = { files: [["stack.yaml", new TextEncoder().encode("format: nope\n")]], directories: [] })),
    // Shape-correct records whose protocol payloads are truncated or disagree with the record:
    { ...structuredClone(x), assignmentId: x.assignmentId + "-copy" },
    variant(x, (r) => (r.exported.castSource = r.exported.castSource.slice(0, 40))),
    variant(x, (r) => (r.exported.handoff = r.exported.handoff.slice(0, -20))),
    variant(x, (r) => (r.exported.returnTemplate = "# Envoy Cast Return\n")),
    variant(x, (r) => (r.exported.dispatchId = "dispatch-other")),
    variant(st, (r) => (r.staged.source = r.staged.source.slice(0, -30))),
    ...good,
    structuredClone(d),
  ];
  const warnings = [];
  const restored = restore(cached, (m) => warnings.push(m));
  assert.deepEqual(restored.dispatches.map((r) => r.assignmentId), good.map((r) => r.assignmentId));
  assert.ok(sameStack(restored.stack, sample()));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^13 damaged Dispatch record\(s\) .* were skipped/);
  // A clean record set produces no warning.
  const quiet = [];
  restore(serialize(workspace()), (m) => quiet.push(m));
  assert.deepEqual(quiet, []);
});

for (const fail of [false, true]) test(`delayed persistence cannot overwrite a ${fail ? "failed" : "successful"} atomic commit`, async () => {
  const state = workspace(), before = serialize(state), writes = [];
  const next = state.stack.change({ directories: new Set(["accepted"]) });
  const history = new History([...state.history.items]); history.push(state.stack, "Before accepted change");
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const candidate = {stack: next, history, current:"entries/nested/note.md", drafts:new Map(), dispatches:[], trusted:null};
  const committing = commit(state, {}, candidate, async (_db, value) => {
    started(); await blocked;
    if (fail) throw Error("quota");
    writes.push(structuredClone(value));
  });
  await began;
  const delayed = persist(state, {}, async (_db, value) => writes.push(structuredClone(value)));
  release();
  if (fail) await assert.rejects(committing, /quota/); else await committing;
  await delayed;
  const recovered = restore(writes.at(-1));
  assert.ok(sameStack(recovered.stack, fail ? restore(before).stack : next));
  assert.equal(recovered.history.items.length, fail ? before.history.length : history.items.length);
  assert.equal(recovered.current, fail ? before.current : candidate.current);
  assert.deepEqual([...recovered.drafts], fail ? before.drafts : []);
  assert.deepEqual(recovered.dispatches, fail ? before.dispatches : []);
  const { id, kind, title, updatedAt, ...written } = writes.at(-1);
  assert.equal(id, state.stack.manifest.id);
  assert.deepEqual(written, serialize(state));
});
