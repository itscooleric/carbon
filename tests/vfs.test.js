import test from "node:test";
import assert from "node:assert/strict";
import { MemoryVfs, VfsConflictError, planTransaction, indexEntry, isConflict, isQuota, recordBytes } from "../src/carbon/vfs.js";
import { activate, loadMount, mountTarget, removeMount, mountRows, MAX_MOUNTS } from "../src/carbon/mounts.js";
import { createState, blankState, mountRecord, serialize, persist, commit } from "../src/carbon/state.js";
import { LocalFolder, SCRATCH_ID, scratchNoteName } from "../src/carbon/local-files.js";
import { newStack } from "../src/core/stack.js";
import { encode } from "../src/core/validate.js";
import { sample } from "./helpers.js";

const record = (id, extra = {}) => ({ id, kind: "folder", title: id, stack: { files: [["a.md", encode("x")]], directories: [] }, history: [], drafts: [], updatedAt: "t", ...extra });

test("planTransaction checks every expected revision before anything is written", () => {
  const found = new Map([["a", 3]]);
  const ok = planTransaction(found, {}, { expect: new Map([["a", 3], ["b", 0]]), put: new Map([["a", record("a")], ["b", record("b")]]) });
  assert.equal(ok.writes.get("a").rev, 4);
  assert.equal(ok.writes.get("b").rev, 1);
  assert.deepEqual([...ok.revs], [["a", 4], ["b", 1]]);
  assert.equal(ok.index.a.rev, 4);
  assert.equal(ok.index.b.files, 1);
  // One stale expectation fails the whole plan, including the valid write.
  assert.throws(() => planTransaction(found, {}, { expect: new Map([["b", 0], ["a", 2]]), put: new Map([["b", record("b")], ["a", record("a")]]) }), VfsConflictError);
  // "Must not exist" refuses an existing body; an unreadable rev is never overwritten.
  assert.throws(() => planTransaction(found, {}, { expect: new Map([["a", 0]]), put: new Map([["a", record("a")]]) }), (e) => isConflict(e) && e.mountId === "a");
  assert.throws(() => planTransaction(new Map([["a", NaN]]), {}, { expect: new Map([["a", 1]]), put: new Map([["a", record("a")]]) }), VfsConflictError);
  // Unchecked expectation is for removal only.
  const removed = planTransaction(new Map([["a", NaN]]), { a: {}, b: {} }, { expect: new Map([["a", null]]), remove: ["a"] });
  assert.deepEqual(Object.keys(removed.index), ["b"]);
  assert.throws(() => planTransaction(found, {}, { expect: new Map([["a", null]]), put: new Map([["a", record("a")]]) }), /without an expected revision/);
  assert.throws(() => planTransaction(found, {}, { put: new Map([["c", record("c")]]) }), /without an expected revision/);
  assert.throws(() => planTransaction(new Map(), {}, { expect: new Map([["c", 0]]), put: new Map([["c", record("d")]]) }), /id mismatch/);
});

test("index entries describe a body without its contents; bytes include History", () => {
  const body = record("a", { rev: 2, drafts: [["a.md", "y"]], history: [{ stack: { files: [["a.md", encode("old!")]] } }], unexported: true });
  const e = indexEntry(body);
  assert.deepEqual({ ...e }, { kind: "folder", title: "a", rev: 2, bytes: 5, files: 1, drafts: 1, unexported: true, updatedAt: "t" });
  assert.equal(recordBytes(body), 5);
  assert.equal("stack" in e, false);
});

test("error classification: quota and conflicts are recoverable states", () => {
  assert.ok(isQuota(Object.assign(new Error("x"), { name: "QuotaExceededError" })));
  assert.ok(isQuota(new DOMException("Simulated quota failure", "QuotaExceededError")));
  assert.ok(!isQuota(new Error("Persistent quota fixture")), "only the browser's own error name counts");
  assert.ok(!isQuota(new Error("disk")));
  assert.ok(isConflict(new VfsConflictError("a", 1, 2)));
  assert.match(new VfsConflictError("a", 1, 2).message, /another Carbon tab/);
});

test("MemoryVfs: write expects the last seen revision; a second window gets a conflict, not an overwrite", async () => {
  // Two windows over one store: same bodies, independently remembered revisions.
  const shared = new MemoryVfs(), tabB = new MemoryVfs();
  tabB.bodies = shared.bodies;
  await shared.write(record("a"));
  assert.equal(shared.bodies.get("a").rev, 1);
  await tabB.read("a");
  await tabB.write(record("a", { title: "from B" }));
  assert.equal(shared.bodies.get("a").rev, 2);
  await assert.rejects(shared.write(record("a", { title: "from A" })), VfsConflictError);
  assert.equal(shared.bodies.get("a").title, "from B", "the newer copy is untouched");
});

test("state.persist/commit write the active mount through the store with revision checks", async () => {
  const store = new MemoryVfs();
  store.durable = true; // behave like the durable store
  const state = createState(new Date(2026, 9, 23));
  await persist(state, store);
  assert.equal(store.bodies.get(SCRATCH_ID).rev, 1);
  assert.equal(store.bodies.get(SCRATCH_ID).kind, "scratch");
  const next = state.stack.change({ writes: new Map([[state.current, encode("# Note")]]) });
  await commit(state, store, { stack: next });
  assert.equal(store.bodies.get(SCRATCH_ID).rev, 2);
  // Another window wrote meanwhile: the commit is refused and the state is untouched.
  store.bodies.set(SCRATCH_ID, { ...store.bodies.get(SCRATCH_ID), rev: 7 });
  const before = serialize(state);
  await assert.rejects(commit(state, store, { stack: next.change({ deletes: [state.current] }) }), VfsConflictError);
  assert.deepEqual(serialize(state), before);
  // A non-durable store never receives writes (memory-only window).
  const memory = new MemoryVfs();
  await persist(state, memory);
  assert.equal(memory.bodies.size, 0);
});

test("activate parks the active workspace and opens the target atomically; failure changes nothing", async () => {
  const store = new MemoryVfs();
  const state = createState();
  state.drafts.set(state.current, "unsaved scratch text");
  const stack = sample();
  await activate(store, state, { ...blankState(stack), copyState: "imported" }, { create: true });
  assert.equal(state.stack.manifest.id, stack.manifest.id);
  assert.equal(state.drafts.size, 0);
  assert.equal(store.active, stack.manifest.id);
  const parked = store.bodies.get(SCRATCH_ID);
  assert.deepEqual(parked.drafts, [[scratchNoteName(), "unsaved scratch text"]]);
  // Back to Scratch: draft, path and identity intact.
  const { target, create } = await mountTarget(store, SCRATCH_ID);
  assert.equal(create, false);
  await activate(store, state, target);
  assert.equal(state.stack.manifest.id, SCRATCH_ID);
  assert.equal(state.drafts.get(state.current), "unsaved scratch text");
  assert.equal(store.bodies.get(stack.manifest.id).copyState, "imported");
  // An interrupted switch (the store throws mid-transaction) leaves window and store as they were.
  const before = serialize(state), bodies = new Map(store.bodies);
  const failing = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
    transact: async () => { throw Object.assign(new Error("Simulated quota failure"), { name: "QuotaExceededError" }); },
  });
  const other = await loadMount(store, stack.manifest.id);
  await assert.rejects(activate(failing, state, other), /quota/);
  assert.deepEqual(serialize(state), before);
  assert.deepEqual(store.bodies, bodies);
  assert.equal(store.active, SCRATCH_ID);
});

test("independent mount identity: same-titled folders stay separate; an existing id is never recreated", async () => {
  const store = new MemoryVfs();
  const state = createState();
  const one = new LocalFolder([["a.md", encode("one")]], [], { title: "Notes" });
  const two = new LocalFolder([["a.md", encode("two")]], [], { title: "Notes" });
  await activate(store, state, blankState(one), { create: true });
  await activate(store, state, blankState(two), { create: true });
  assert.notEqual(one.manifest.id, two.manifest.id);
  assert.equal((await loadMount(store, one.manifest.id)).stack.text("a.md"), "one");
  assert.equal((await loadMount(store, two.manifest.id)).stack.text("a.md"), "two");
  // Creating a workspace whose id another window already stored is a conflict, not an overwrite.
  await assert.rejects(activate(store, state, blankState(new LocalFolder([], [], { id: one.manifest.id })), { create: true }), VfsConflictError);
  assert.equal((await loadMount(store, one.manifest.id)).stack.text("a.md"), "one");
  // A damaged or mismatched record is reported and left untouched.
  store.bodies.set("local-bad", { ...store.bodies.get(one.manifest.id), id: "local-bad" });
  await assert.rejects(loadMount(store, "local-bad"), /could not be restored.*left untouched/);
  assert.ok(store.bodies.has("local-bad"));
  await assert.rejects(loadMount(store, "local-missing"), /no longer stored/);
});

test("mount cap, removal rules and switcher rows", async () => {
  const store = new MemoryVfs();
  const state = createState();
  for (let i = 0; i < MAX_MOUNTS - 1; i++) await activate(store, state, blankState(newStack(`S${i}`)), { create: true });
  assert.equal(Object.keys(store.index).length, MAX_MOUNTS, "Scratch plus eight Stacks");
  await assert.rejects(activate(store, state, blankState(newStack("one too many")), { create: true }), /up to 9 workspaces/);
  const active = state.stack.manifest.id;
  await assert.rejects(removeMount(store, state, active), /Switch to another workspace/);
  await assert.rejects(removeMount(store, state, SCRATCH_ID), /Scratch is always kept/);
  const victim = Object.keys(store.index).find((id) => id !== active && id !== SCRATCH_ID);
  await removeMount(store, state, victim);
  assert.equal(store.bodies.has(victim), false);
  assert.equal(victim in store.index, false);
  await activate(store, state, blankState(newStack("fits now")), { create: true });
  const rows = mountRows(store.index, state);
  assert.equal(rows[0].active, true);
  assert.equal(rows.filter((r) => r.active).length, 1);
});

test("Scratch is recreated only when it was never stored", async () => {
  const store = new MemoryVfs();
  const state = blankState(sample());
  const fresh = await mountTarget(store, SCRATCH_ID);
  assert.equal(fresh.create, true);
  assert.equal(fresh.target.stack.manifest.id, SCRATCH_ID);
  await activate(store, state, fresh.target, { create: true });
  assert.equal(mountRecord(state).kind, "scratch");
});

test("a missing or damaged switcher index is rebuilt from the bodies; unreadable bodies stay listed for removal", async () => {
  const { rebuildIndex } = await import("../src/carbon/vfs.js");
  const index = rebuildIndex(["a", "b", 7], [record("a", { rev: 3 }), { rev: "x" }, record("c", { rev: 1 })]);
  assert.deepEqual(Object.keys(index), ["a", "b"]);
  assert.equal(index.a.rev, 3);
  assert.equal(index.a.title, "a");
  assert.deepEqual({ kind: index.b.kind, rev: index.b.rev, title: index.b.title }, { kind: null, rev: null, title: "b" });
});

test("removal uses the revision from the last listing: a workspace changed in another tab since is not deleted", async () => {
  const store = new MemoryVfs();
  const state = createState();
  const copy = new LocalFolder([["a.md", encode("one")]], [], { title: "Copy" });
  await activate(store, state, blankState(copy), { create: true });
  const { target } = await mountTarget(store, SCRATCH_ID);
  await activate(store, state, target);
  await store.list();
  // Another tab writes the parked copy after this window's listing.
  store.bodies.set(copy.manifest.id, { ...store.bodies.get(copy.manifest.id), rev: 9 });
  await assert.rejects(removeMount(store, state, copy.manifest.id), VfsConflictError);
  assert.ok(store.bodies.has(copy.manifest.id));
  // A "damaged" listing never removes a readable body (a healthy replacement made meanwhile)...
  store.index[copy.manifest.id] = { ...store.index[copy.manifest.id], rev: null };
  await assert.rejects(removeMount(store, state, copy.manifest.id), VfsConflictError);
  assert.ok(store.bodies.has(copy.manifest.id));
  // ...but an unreadable body is removable whatever the listing said, so it cannot get stuck.
  store.bodies.set(copy.manifest.id, { ...store.bodies.get(copy.manifest.id), rev: "x" });
  store.index[copy.manifest.id] = { ...store.index[copy.manifest.id], rev: 9 };
  await removeMount(store, state, copy.manifest.id);
  assert.equal(store.bodies.has(copy.manifest.id), false);
});

test("the workspace cap is enforced against the index read inside the transaction", () => {
  const index = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, { rev: 1 }]));
  assert.throws(
    () => planTransaction(new Map(), index, { expect: new Map([["new", 0]]), put: new Map([["new", record("new")]]), limit: 9, limitMessage: "up to 9" }),
    /up to 9/,
  );
  // Writing an existing workspace or removing one is never refused by the cap.
  assert.doesNotThrow(() => planTransaction(new Map([["s1", 1]]), index, { expect: new Map([["s1", 1]]), put: new Map([["s1", record("s1")]]), limit: 9 }));
});

test("index recovery tolerates damaged members and keeps their readable revision", async () => {
  const { rebuildIndex } = await import("../src/carbon/vfs.js");
  const index = rebuildIndex(["ok", "nulls"], [record("ok", { rev: 2 }), record("nulls", { rev: 4, history: [null], stack: { files: [null] } })]);
  assert.equal(index.ok.rev, 2);
  assert.equal(index.nulls.rev, 4);
  assert.equal(recordBytes({ stack: { files: [null, ["a", null]] }, history: [null, { stack: null }] }), 0);
});

test("removal is pinned to the revision the user saw, even if a later listing is newer", async () => {
  const store = new MemoryVfs();
  const state = createState();
  const copy = new LocalFolder([["a.md", encode("one")]], [], { title: "Copy" });
  await activate(store, state, blankState(copy), { create: true });
  const { target } = await mountTarget(store, SCRATCH_ID);
  await activate(store, state, target);
  const seen = store.index[copy.manifest.id].rev;
  // Another tab writes the copy and this window's index picks the newer revision up.
  store.bodies.set(copy.manifest.id, { ...store.bodies.get(copy.manifest.id), rev: seen + 1 });
  store.index[copy.manifest.id] = { ...store.index[copy.manifest.id], rev: seen + 1 };
  await assert.rejects(removeMount(store, state, copy.manifest.id, seen), VfsConflictError);
  assert.ok(store.bodies.has(copy.manifest.id));
});

test("revisions stay monotonic across removal: a stale window of a removed workspace cannot overwrite its re-creation", async () => {
  const store = new MemoryVfs(), stale = new MemoryVfs();
  stale.bodies = store.bodies;
  await store.write(record("stk-a"));
  await store.write(record("stk-a"));
  await stale.read("stk-a"); // the stale window last saw rev 2
  await store.transact({ expect: new Map([["stk-a", 2]]), remove: ["stk-a"] });
  assert.deepEqual(store.tombstones, { "stk-a": 2 });
  // Re-created: continues after the tombstone instead of restarting at 1.
  const revs = await store.transact({ expect: new Map([["stk-a", 0]]), put: new Map([["stk-a", record("stk-a", { title: "new" })]]) });
  assert.equal(revs.get("stk-a"), 3);
  stale.tombstones = store.tombstones;
  await assert.rejects(stale.write(record("stk-a", { title: "stale" })), VfsConflictError);
  assert.equal(store.bodies.get("stk-a").title, "new");
  // Pure rule: a tombstone never lowers.
  const plan = planTransaction(new Map([["x", 1]]), {}, { expect: new Map([["x", 1]]), remove: ["x"] }, { x: 5 });
  assert.equal(plan.tombstones.x, 5);
});

test("recovery files include drafts, and fall back to separate downloads when drafts cannot join the archive", async () => {
  const { recoveryFiles } = await import("../src/carbon/mounts.js");
  const { readTarFiles } = await import("../src/archives/tar.js");
  const folder = new LocalFolder([["a.md", encode("saved")]], [], { id: "local-rec", title: "R" });
  const one = recoveryFiles(folder, new Map([["a.md", "draft"]]));
  assert.deepEqual(one.map((f) => f.name), ["local-rec-recovery-r0.folder.tar"]);
  assert.equal(new TextDecoder().decode(new Map(readTarFiles(one[0].bytes).files).get("a.md")), "draft");
  // A draft over the Markdown text limit cannot be committed: saved workspace + drafts archive.
  const huge = "x".repeat(1024 * 1024 + 1);
  const two = recoveryFiles(folder, new Map([["a.md", huge]]));
  assert.deepEqual(two.map((f) => f.name), ["local-rec-recovery-r0-saved.folder.tar", "local-rec-recovery-r0-drafts.tar"]);
  assert.equal(new TextDecoder().decode(new Map(readTarFiles(two[0].bytes).files).get("a.md")), "saved");
  assert.equal(new Map(readTarFiles(two[1].bytes).files).get("a.md").length, huge.length);
});

test("removing an unreadable body still leaves a tombstone above any revision a stale window could hold", () => {
  const now = 1_700_000_000_000;
  const removed = planTransaction(new Map([["stk-a", NaN]]), { "stk-a": { rev: null } }, { expect: new Map([["stk-a", null]]), remove: ["stk-a"] }, {}, now);
  assert.equal(removed.tombstones["stk-a"], now);
  // Re-created after the damaged body was removed: it continues above the tombstone...
  const created = planTransaction(new Map(), removed.index, { expect: new Map([["stk-a", 0]]), put: new Map([["stk-a", record("stk-a")]]) }, removed.tombstones);
  assert.equal(created.revs.get("stk-a"), now + 1);
  // ...so a stale window still holding revision 1 conflicts instead of overwriting it.
  assert.throws(
    () => planTransaction(new Map([["stk-a", now + 1]]), created.index, { expect: new Map([["stk-a", 1]]), put: new Map([["stk-a", record("stk-a")]]) }, created.tombstones),
    VfsConflictError,
  );
});

test("a stored body without a valid revision is not restored (it would refuse every save)", async () => {
  const store = new MemoryVfs();
  store.bodies.set("local-x", { ...mountRecord(blankState(new LocalFolder([], [], { id: "local-x" }))), rev: "broken" });
  await assert.rejects(loadMount(store, "local-x"), /storage revision is unreadable.*left untouched/);
});
