import test from "node:test";
import assert from "node:assert/strict";
import { LocalFolder } from "../src/carbon/local-files.js";
import { encode, equal } from "../src/core/validate.js";
import { fakeFolder } from "./linked-fake-fs.js";
import {
  CAPTURE_LIMIT, SOURCE_STATES, acceptMove, baselineBytes, forgetDeleted, importIncoming, importedBaseline, keepBoth, keepBothName,
  keepMine, observe, observedBytes, packSource, restoreDeleted, sourceBytes, sourceRows, sourceState, sourceSummary, syncedBaseline, takeDisk,
  trackBaseline, validSource, withBytes, shadowInHistory, knownFolder,
} from "../src/carbon/source.js";
import { History } from "../src/core/stack.js";

const folder = (files, directories = []) => new LocalFolder(Object.entries(files).map(([p, v]) => [p, encode(v)]), directories, { id: "local-test", title: "T" });
/** A link as a folder open creates it: every file is the baseline, observed as of the open. */
async function opened(files, handleFiles = files) {
  const fs = fakeFolder(handleFiles);
  const stack = folder(files);
  const link = { handle: fs.root, baseline: importedBaseline(stack), observed: null };
  link.observed = await observe(fs.root, link, stack, { now: () => new Date("2026-10-26T00:00:00Z") });
  return { fs, stack, link };
}
const states = (link, stack) => Object.fromEntries(sourceRows(link, stack).map((r) => [r.path, r.state]));
const commit = (link, before, after) => ({ ...link, baseline: trackBaseline(link.baseline, before, after) });

test("state table: every row of rev 3 §1 plus matched, from files, baseline and observed", async () => {
  const { fs, stack, link } = await opened({ "a.md": "# a\n", "b.md": "# b\n", "c.md": "# c\n", "d.md": "# d\n", "e.md": "# e\n", "f.md": "# f\n" });
  assert.deepEqual(new Set(Object.values(states(link, stack))), new Set(["synced"]));
  // virtual: created in Carbon, never on disk
  let next = stack.change({ writes: new Map([["new.txt", encode("x")]]) });
  let l = commit(link, stack, next);
  assert.equal(sourceState(l, next, "new.txt"), "virtual");
  assert.equal(baselineBytes(l, next, "new.txt"), undefined);
  // modified: edited in Carbon; the shadow is the baseline
  next = next.change({ writes: new Map([["a.md", encode("# a2\n")]]) });
  l = commit(l, stack, next);
  assert.equal(sourceState(l, next, "a.md"), "modified");
  assert.equal(new TextDecoder().decode(baselineBytes(l, next, "a.md")), "# a\n");
  // deletedInCarbon: shadow kept, no virtual file
  next = next.change({ deletes: ["b.md"] });
  l = commit(l, stack, next);
  assert.equal(sourceState(l, next, "b.md"), "deletedInCarbon");
  // disk changes: c externally (externalChange), a externally too (conflict), d removed (missing), g new (incoming),
  // e edited to the same bytes on both sides (matched), f edited on disk to equal Carbon's edit... f: Carbon edits, disk identical -> matched
  fs.put("c.md", "# c-disk\n");
  fs.put("a.md", "# a-disk\n");
  fs.remove("d.md");
  fs.put("g.md", "# g\n");
  next = next.change({ writes: new Map([["e.md", encode("# e2\n")]]) });
  l = commit(l, stack, next);
  fs.put("e.md", "# e2\n");
  l = { ...l, observed: await observe(fs.root, l, next) };
  assert.deepEqual(states(l, next), {
    "a.md": "conflict", "b.md": "deletedInCarbon", "c.md": "externalChange", "d.md": "missing", "e.md": "matched", "f.md": "synced", "g.md": "incoming", "new.txt": "virtual",
  });
  // a virtual path that also appeared on disk is a collision (conflict) unless the bytes agree
  fs.put("new.txt", "y");
  l = { ...l, observed: await observe(fs.root, l, next) };
  assert.equal(sourceState(l, next, "new.txt"), "conflict");
  fs.put("new.txt", "x");
  l = { ...l, observed: await observe(fs.root, l, next) };
  assert.equal(sourceState(l, next, "new.txt"), "matched");
  // without any observation only synced / modified / virtual are possible
  const blind = { ...l, observed: null };
  assert.deepEqual(new Set(Object.values(states(blind, next))), new Set(["synced", "modified", "virtual", "deletedInCarbon"]));
  for (const state of Object.values(states(l, next))) assert.ok(state in SOURCE_STATES);
  const summary = sourceSummary(l, next);
  assert.equal(summary.unsynced, 4); // a (conflict), b (deleted in Carbon), e and new.txt (matched: not recorded as synced)
});

test("trackBaseline: first divergence is kept, a revert drops the shadow, paths are never added or removed", () => {
  const stack = folder({ "a.md": "one\n", "b.md": "two\n" });
  const baseline = importedBaseline(stack);
  const edited = stack.change({ writes: new Map([["a.md", encode("one!\n")], ["c.md", encode("new\n")]]) });
  const b1 = trackBaseline(baseline, stack, edited);
  assert.notEqual(b1, baseline);
  assert.equal(new TextDecoder().decode(b1.get("a.md").shadow), "one\n");
  assert.equal(b1.has("c.md"), false);
  // a second edit keeps the first shadow
  const edited2 = edited.change({ writes: new Map([["a.md", encode("one!!\n")]]) });
  const b2 = trackBaseline(b1, edited, edited2);
  assert.equal(new TextDecoder().decode(b2.get("a.md").shadow), "one\n");
  // back to the baseline bytes: no shadow
  const reverted = edited2.change({ writes: new Map([["a.md", encode("one\n")]]) });
  const b3 = trackBaseline(b2, edited2, reverted);
  assert.deepEqual(b3.get("a.md"), {});
  // nothing changed: the same Map object
  assert.equal(trackBaseline(b3, reverted, reverted), b3);
  // delete and rename keep shadows under the old paths
  const moved = reverted.change({ moves: [["b.md", "d.md"]], deletes: ["a.md"] });
  const b4 = trackBaseline(b3, reverted, moved);
  assert.equal(new TextDecoder().decode(b4.get("a.md").shadow), "one\n");
  assert.equal(new TextDecoder().decode(b4.get("b.md").shadow), "two\n");
  assert.equal(b4.has("d.md"), false);
  assert.deepEqual(states({ baseline: b4, observed: null }, moved), { "a.md": "deletedInCarbon", "b.md": "deletedInCarbon", "c.md": "virtual", "d.md": "virtual" });
});

test("observe reads the folder read-only, captures bytes only where the disk differs, and respects the capture budget", async () => {
  const { fs, stack, link } = await opened({ "a.md": "# a\n", "big.txt": "x".repeat(1000) });
  assert.equal(link.observed.entries.get("a.md").same, true);
  assert.equal(link.observed.entries.get("a.md").bytes, undefined);
  assert.equal(link.observed.entries.get("a.md").captured, true);
  assert.equal(link.observed.entries.get("a.md").modified, fs.at("a.md").node.modified);
  fs.put("a.md", "# A\n");
  fs.put("big.txt", "y".repeat(1000));
  fs.mkdir("empty");
  const small = await observe(fs.root, link, stack, { limit: 500 });
  assert.deepEqual(small.directories, ["empty"]);
  assert.equal(new TextDecoder().decode(small.entries.get("a.md").bytes), "# A\n");
  assert.equal(small.entries.get("big.txt").captured, false);
  assert.equal(small.entries.get("big.txt").bytes, undefined);
  assert.equal(small.entries.get("big.txt").size, 1000);
  assert.equal(fs.ctl.writes.length, 0);
  // the budget counts existing shadows
  const shadowed = { ...link, baseline: new Map([["a.md", { shadow: new Uint8Array(CAPTURE_LIMIT) }], ["big.txt", {}]]) };
  const none = await observe(fs.root, shadowed, stack);
  assert.equal(none.entries.get("a.md").captured, false);
  assert.equal(none.entries.get("big.txt").captured, false);
  assert.throws(() => keepMine({ ...shadowed, baseline: new Map([["big.txt", { shadow: encode("old") }]]), observed: none }, stack, "big.txt"), /not captured/);
});

test("sourceRows pairs a missing path with the incoming file that holds exactly its baseline bytes (Accept move), once", async () => {
  const { fs, stack, link } = await opened({ "a.md": "same\n", "b.md": "same\n", "c.md": "other\n" });
  fs.remove("a.md");
  fs.remove("b.md");
  fs.put("moved.md", "same\n");
  fs.put("near.md", "same!\n");
  const l = { ...link, observed: await observe(fs.root, link, stack) };
  const rows = Object.fromEntries(sourceRows(l, stack).map((r) => [r.path, r]));
  assert.equal(rows["a.md"].moveTo, "moved.md");
  assert.equal(rows["moved.md"].movedFrom, "a.md");
  assert.equal(rows["b.md"].moveTo, undefined); // the same target is claimed once
  assert.equal(rows["near.md"].movedFrom, undefined); // one byte off is not a move
  const { stack: next, link: after } = acceptMove(l, stack, "a.md", "moved.md");
  assert.equal(next.files.has("a.md"), false);
  assert.equal(new TextDecoder().decode(next.files.get("moved.md")), "same\n");
  assert.deepEqual(states(after, next), { "b.md": "missing", "c.md": "synced", "moved.md": "synced", "near.md": "incoming" });
  assert.throws(() => acceptMove(l, stack, "b.md", "near.md"), /bytes must match exactly/);
  assert.equal(fs.ctl.writes.length, 0);
});

test("import incoming adds files with a fresh baseline and creates parents; collisions are refused with both names", async () => {
  const { fs, stack, link } = await opened({ "Notes.md": "# n\n" }, { "Notes.md": "# n\n" });
  fs.put("sub/dir/x.txt", "x");
  fs.put("notes.md", "# collides\n");
  const l = { ...link, observed: await observe(fs.root, link, stack) };
  assert.deepEqual(states(l, stack), { "Notes.md": "synced", "notes.md": "incoming", "sub/dir/x.txt": "incoming" });
  const { stack: next, link: after } = importIncoming(l, stack, ["sub/dir/x.txt"]);
  assert.ok(next.directories.has("sub/dir"));
  assert.equal(sourceState(after, next, "sub/dir/x.txt"), "synced");
  assert.equal(after.observed.entries.get("sub/dir/x.txt").same, true);
  assert.throws(() => importIncoming(l, stack, ["notes.md"]), /notes\.md collides with Notes\.md/);
  assert.throws(() => importIncoming(l, stack, ["Notes.md"]), /not a new file/);
  // a file where Carbon has a folder of that name
  const withDir = folder({ "Notes.md": "# n\n" }, ["sub"]);
  fs.put("sub", "file now");
  // the fake keeps "sub" as a directory with children; emulate by observing a separate folder
  const fs2 = fakeFolder({ "Notes.md": "# n\n", "SUB": "file" });
  const l2 = { ...link, handle: fs2.root, baseline: importedBaseline(withDir), observed: null };
  l2.observed = await observe(fs2.root, l2, withDir);
  assert.throws(() => importIncoming(l2, withDir, ["SUB"]), /SUB collides with sub/);
  assert.equal(fs.ctl.writes.length + fs2.ctl.writes.length, 0);
});

test("take disk replaces the virtual bytes and re-baselines; keep mine acknowledges the disk version; keep both keeps a copy", async () => {
  const { fs, stack, link } = await opened({ "a.md": "base\n" });
  const edited = stack.change({ writes: new Map([["a.md", encode("mine\n")]]) });
  let l = commit(link, stack, edited);
  fs.put("a.md", "theirs\n");
  l = { ...l, observed: await observe(fs.root, l, edited) };
  assert.equal(sourceState(l, edited, "a.md"), "conflict");
  // take disk
  const taken = takeDisk(l, edited, "a.md", fs.bytes("a.md"), 77);
  assert.equal(new TextDecoder().decode(taken.stack.files.get("a.md")), "theirs\n");
  assert.equal(sourceState(taken.link, taken.stack, "a.md"), "synced");
  assert.equal(taken.link.observed.entries.get("a.md").modified, 77);
  assert.equal(taken.stack.manifest.revision, edited.manifest.revision + 1);
  // identical bytes: no new revision
  assert.equal(takeDisk(taken.link, taken.stack, "a.md", encode("theirs\n")).stack, taken.stack);
  // keep mine: virtual bytes unchanged, baseline = disk, state modified; a later disk change is a conflict again (G6)
  const kept = keepMine(l, edited, "a.md");
  assert.equal(kept.stack, undefined);
  assert.equal(new TextDecoder().decode(edited.files.get("a.md")), "mine\n");
  assert.equal(new TextDecoder().decode(baselineBytes(kept.link, edited, "a.md")), "theirs\n");
  assert.equal(sourceState(kept.link, edited, "a.md"), "modified");
  fs.put("a.md", "theirs again\n");
  const again = { ...kept.link, observed: await observe(fs.root, kept.link, edited) };
  assert.equal(sourceState(again, edited, "a.md"), "conflict");
  assert.throws(() => keepMine(kept.link, edited, "a.md"), /no conflict/);
  // keep both
  const both = keepBoth(l, edited, "a.md");
  assert.equal(both.path, "a.folder.md");
  assert.equal(new TextDecoder().decode(both.stack.files.get("a.folder.md")), "theirs\n");
  assert.deepEqual(states(both.link, both.stack), { "a.md": "modified", "a.folder.md": "virtual" });
  assert.equal(keepBothName(both.stack, "a.md"), "a.folder2.md");
  assert.equal(keepBothName(stack, "Makefile"), "Makefile.folder");
  assert.equal(keepBothName(stack, "d/.env"), "d/.env.folder");
  assert.equal(fs.ctl.writes.length, 0);
});

test("delete in Carbon keeps a shadow; restore brings the baseline bytes back; forget drops the shadow; the folder is never touched", async () => {
  const { fs, stack, link } = await opened({ "a.md": "base\n", "b.md": "b\n" });
  const deleted = stack.change({ deletes: ["a.md"] });
  let l = commit(link, stack, deleted);
  assert.deepEqual(states(l, deleted), { "a.md": "deletedInCarbon", "b.md": "synced" });
  assert.equal(sourceRows(l, deleted).find((r) => r.path === "a.md").gone, undefined);
  fs.remove("a.md");
  l = { ...l, observed: await observe(fs.root, l, deleted) };
  assert.equal(sourceRows(l, deleted).find((r) => r.path === "a.md").gone, true);
  const restored = restoreDeleted(l, deleted, "a.md");
  assert.equal(new TextDecoder().decode(restored.stack.files.get("a.md")), "base\n");
  assert.equal(sourceState(restored.link, restored.stack, "a.md"), "missing"); // the folder no longer has it
  fs.put("a.md", "base\n");
  const back = { ...restored.link, observed: await observe(fs.root, restored.link, restored.stack) };
  assert.equal(sourceState(back, restored.stack, "a.md"), "synced");
  // restore refused when a virtual file took the name (case-insensitively)
  const taken = deleted.change({ writes: new Map([["A.md", encode("other\n")]]) });
  const lt = commit(l, deleted, taken);
  assert.throws(() => restoreDeleted(lt, taken, "a.md"), /a\.md collides with A\.md/);
  const forgotten = forgetDeleted(l, deleted, "a.md");
  assert.equal(forgotten.link.baseline.has("a.md"), false);
  assert.deepEqual(states(forgotten.link, deleted), { "b.md": "synced" });
  assert.throws(() => forgetDeleted(forgotten.link, deleted, "a.md"), /not deleted/);
  assert.equal(fs.ctl.writes.length, 0);
});

test("syncedBaseline records a verified write: shadow dropped, observation says the folder holds the bytes", async () => {
  const { stack, link } = await opened({ "a.md": "base\n" });
  const next = stack.change({ writes: new Map([["a.md", encode("mine\n")], ["n.txt", encode("new")]]) });
  const l = commit(link, stack, next);
  assert.deepEqual(states(l, next), { "a.md": "modified", "n.txt": "virtual" });
  const s1 = syncedBaseline(l, "a.md", next.files.get("a.md"), 5, next.files.get("a.md"));
  assert.equal(sourceState(s1, next, "a.md"), "synced");
  assert.equal(s1.observed.entries.get("a.md").modified, 5);
  const s2 = syncedBaseline(s1, "n.txt", next.files.get("n.txt"), null, next.files.get("n.txt"));
  assert.equal(sourceState(s2, next, "n.txt"), "synced");
  assert.equal(s2.observed.entries.get("n.txt").size, 3);
  // Carbon's copy changed (or went) while the Sync awaited the folder: the written bytes become the shadow.
  const later = next.change({ writes: new Map([["a.md", encode("later\n")]]), deletes: ["n.txt"] });
  const s3 = syncedBaseline(l, "a.md", next.files.get("a.md"), null, later.files.get("a.md"));
  assert.equal(sourceState(s3, later, "a.md"), "modified");
  assert.deepEqual(baselineBytes(s3, later, "a.md"), encode("mine\n"));
  const s4 = syncedBaseline(l, "n.txt", next.files.get("n.txt"), null, later.files.get("n.txt"));
  assert.equal(sourceState(s4, later, "n.txt"), "deletedInCarbon");
  assert.deepEqual(baselineBytes(s4, later, "n.txt"), encode("new"));
});

test("pack / valid round trip; malformed members are dropped non-destructively; sourceBytes counts shadows and captures", async () => {
  const { fs, stack, link } = await opened({ "a.md": "base\n", "b.md": "b\n", "c.md": "c\n" });
  const next = stack.change({ writes: new Map([["a.md", encode("mine\n")]]), deletes: ["c.md"] });
  let l = commit(link, stack, next);
  fs.put("b.md", "B\n");
  fs.put("d.md", "d\n");
  l = { ...l, observed: await observe(fs.root, l, next) };
  const packed = packSource(l);
  assert.ok(packed.baseline.every(([p, s]) => typeof p === "string" && (s === null || s instanceof Uint8Array)));
  assert.equal(sourceBytes(packed), 5 + 2 + 2 + 2); // shadows of a.md (5) and the deleted c.md (2), captured B (2) and d (2)
  const cloned = structuredClone(packed);
  const { baseline, observed } = validSource(cloned, next);
  assert.deepEqual(states({ baseline, observed }, next), states(l, next));
  assert.equal(observed.at, l.observed.at);
  assert.deepEqual([...baseline.keys()].sort(), ["a.md", "b.md", "c.md"]);
  // malformed members
  const bad = {
    baseline: [["a.md", null], ["../x", null], ["c.md", "not bytes"], ["gone.md", null], 7, ["z.md", new Uint8Array(1)]],
    observed: { at: "t", directories: ["ok", "../no"], entries: [["b.md", { size: -1, same: false }], ["d.md", { size: 2, same: false, bytes: "x" }], ["e.md", { size: 2, modified: "x", same: false, bytes: new Uint8Array([1, 2]) }], ["a.md", { size: 5, same: true }]] },
  };
  const v = validSource(bad, next);
  assert.deepEqual([...v.baseline.keys()], ["a.md", "z.md"]); // gone.md has no virtual file and no shadow: dropped
  assert.deepEqual(v.observed.directories, ["ok"]);
  assert.deepEqual([...v.observed.entries.keys()], ["e.md", "a.md"]);
  assert.equal(v.observed.entries.get("e.md").modified, null);
  // a.md lost its shadow: reads synced (non-destructive: nothing claims a difference it cannot show)
  assert.equal(sourceState(v, next, "a.md"), "synced");
  // z.md: shadow without a virtual file = deleted in Carbon; e.md incoming
  assert.equal(sourceState(v, next, "z.md"), "deletedInCarbon");
  assert.equal(sourceState(v, next, "e.md"), "incoming");
  // a malformed whole yields an empty baseline and no observation: everything is virtual
  const empty = validSource({ baseline: "x", observed: [] }, next);
  assert.deepEqual(states(empty, next), { "a.md": "virtual", "b.md": "virtual" });
  assert.equal(empty.observed, null);
  assert.deepEqual(packSource({ baseline: new Map(), observed: null }), { baseline: [], observed: null });
});

test("observedBytes-based actions refuse when the Refresh did not capture the disk version", async () => {
  const { fs, stack, link } = await opened({ "a.md": "base\n" });
  const edited = stack.change({ writes: new Map([["a.md", encode("mine\n")]]) });
  let l = commit(link, stack, edited);
  fs.put("a.md", "theirs\n");
  l = { ...l, observed: await observe(fs.root, l, edited, { limit: 0 }) };
  assert.equal(sourceState(l, edited, "a.md"), "conflict");
  assert.equal(sourceRows(l, edited)[0].captured, false);
  assert.throws(() => keepMine(l, edited, "a.md"), /not captured/);
  assert.throws(() => keepBoth(l, edited, "a.md"), /not captured/);
  fs.put("new.md", "n\n");
  l = { ...l, observed: await observe(fs.root, l, edited, { limit: 0 }) };
  assert.throws(() => importIncoming(l, edited, ["new.md"]), /not captured/);
  assert.ok(equal(edited.files.get("a.md"), encode("mine\n")));
});

test("Forget on a deleted file the folder still holds unchanged moves its bytes into the observation: Import works without a Refresh", async () => {
  const { fs, stack, link } = await opened({ "a.md": "base\n", "b.md": "b\n" });
  const next = stack.change({ deletes: ["a.md"] });
  let l = commit(link, stack, next);
  l = { ...l, observed: await observe(fs.root, l, next) };
  assert.equal(l.observed.entries.get("a.md").same, true);
  assert.equal(l.observed.entries.get("a.md").bytes, undefined);
  const { link: forgot } = forgetDeleted(l, next, "a.md");
  assert.equal(sourceState(forgot, next, "a.md"), "incoming");
  assert.deepEqual(observedBytes(forgot, "a.md"), encode("base\n"));
  const row = sourceRows(forgot, next).find((r) => r.path === "a.md");
  assert.notEqual(row.captured, false);
  const { stack: imported, link: after } = importIncoming(forgot, next, ["a.md"]);
  assert.deepEqual(imported.files.get("a.md"), encode("base\n"));
  assert.equal(sourceState(after, imported, "a.md"), "synced");
});

test("withBytes carries bytes that are not Markdown text read-only, which an Editor write (change) refuses", () => {
  const stack = folder({ "a.md": "# a\n", "b.md": "b\n" });
  const bad = new Uint8Array([0x23, 0xff, 0x00]);
  assert.throws(() => stack.change({ writes: new Map([["a.md", bad]]) }));
  const next = withBytes(stack, "a.md", bad);
  assert.deepEqual(next.files.get("a.md"), bad);
  assert.equal(next.manifest.revision, stack.manifest.revision + 1);
  assert.deepEqual(next.files.get("b.md"), stack.files.get("b.md"));
  assert.throws(() => withBytes(stack, "../x.md", bad));
});

test("move detection pairs only exact bytes and stays linear for many same-size candidates; counts skip it", async () => {
  const n = 300, size = 8 * 1024;
  const make = (i, tail) => { const b = new Uint8Array(size).fill(0x61); b[size - 2] = i % 256; b[size - 3] = (i >> 8) & 255; b[size - 1] = tail; return b; };
  const files = new Map(), disk = new Map();
  for (let i = 0; i < n; i++) {
    files.set(`old/${i}.bin`, make(i, 1));
    disk.set(`new/${i}.bin`, make(i, 2)); // same size, differs only in the last byte
  }
  disk.set("new/moved.bin", make(7, 1)); // exactly old/7.bin
  const stack = new LocalFolder([...files], [], { id: "local-test", title: "T" });
  const link = { baseline: importedBaseline(stack), observed: null };
  link.observed = { at: "x", directories: [], entries: new Map([...disk].map(([p, b]) => [p, { size: b.length, modified: 1, same: false, captured: true, bytes: b }])) };
  const t0 = performance.now();
  const rows = sourceRows(link, stack);
  const elapsed = performance.now() - t0;
  const moved = rows.filter((r) => r.moveTo);
  assert.deepEqual(moved.map((r) => [r.path, r.moveTo]), [["old/7.bin", "new/moved.bin"]]);
  assert.ok(elapsed < 1500, `sourceRows took ${Math.round(elapsed)} ms`);
  assert.equal(sourceSummary(link, stack).counts.missing, n);
});

test("a missing file edited in Carbon counts as unsynced as well as external", async () => {
  const { fs, stack, link } = await opened({ "a.md": "base\n", "b.md": "b\n" });
  const next = stack.change({ writes: new Map([["a.md", encode("mine\n")]]) });
  let l = commit(link, stack, next);
  fs.remove("a.md");
  fs.remove("b.md");
  l = { ...l, observed: await observe(fs.root, l, next) };
  assert.equal(sourceState(l, next, "a.md"), "missing");
  assert.equal(sourceState(l, next, "b.md"), "missing");
  const { unsynced, external } = sourceSummary(l, next);
  assert.equal(unsynced, 1, "a.md's edit never reached the folder; b.md is unchanged in Carbon");
  assert.equal(external, 2);
});

test("validSource drops a 'same' observation whose baseline was dropped as damaged", async () => {
  const { fs, stack, link } = await opened({ "a.md": "base\n", "b.md": "b\n" });
  const next = stack.change({ deletes: ["a.md"] });
  let l = commit(link, stack, next);
  l = { ...l, observed: await observe(fs.root, l, next) };
  const packed = packSource(l);
  packed.baseline = packed.baseline.map(([p, s]) => (p === "a.md" ? [p, "damaged"] : [p, s]));
  const restored = validSource(packed, next);
  assert.equal(restored.baseline.has("a.md"), false);
  assert.equal(restored.observed.entries.has("a.md"), false, "no folder bytes are advertised that Carbon does not have");
  assert.equal(restored.observed.entries.get("b.md").same, true);
  assert.equal(sourceRows({ ...restored }, next).some((r) => r.path === "a.md"), false);
});

test("shadowInHistory: a Keep mine shadow (the folder's version) is not in History; an ordinary deletion's is", async () => {
  const { stack, link } = await opened({ "a.md": "base\n" });
  const history = new History();
  history.push(stack, "before delete");
  const gone = stack.change({ deletes: ["a.md"] });
  const l = commit(link, stack, gone);
  assert.equal(shadowInHistory(l, history, "a.md"), true);
  const theirs = { ...l, baseline: new Map([["a.md", { shadow: encode("theirs\n") }]]) };
  assert.equal(shadowInHistory(theirs, history, "a.md"), false);
  assert.equal(shadowInHistory(l, history, "none.md"), false);
});

test("knownFolder keeps the larger of the observed and the baseline size for every path", () => {
  const stack = folder({ "a.bin": "a", "b.bin": "b", "c.bin": "c", "d.bin": "d" });
  const big = 7 * 1024 ** 2;
  const link = { baseline: importedBaseline(stack), observed: { at: "x", directories: [], entries: new Map([...stack.files.keys()].map((p) => [p, { size: big, modified: 1, same: false, captured: false }])) } };
  // The four files grew outside Carbon to 28 MiB (seen by Refresh, not captured): an 8 MiB new file would pass 32 MiB.
  assert.equal(knownFolder(link, stack).bytes, 4 * big);
  assert.equal(knownFolder(link, stack, new Map([["n.bin", 8 * 1024 ** 2]])).bytes > 32 * 1024 ** 2, true);
});

test("Take folder version, Keep mine and Keep both refuse past the folder limits as Carbon knows it", () => {
  // 1,999 files deleted only in Carbon (shadows) and gone from the folder, plus one file only in Carbon whose
  // path the folder now also holds (a conflict): taking or acknowledging it would add a 2,001st entry.
  const names = Array.from({ length: 1999 }, (_, i) => `f${i}.txt`);
  const stack = folder({ "v.md": "mine\n" });
  const baseline = new Map(names.map((p) => [p, { shadow: encode("x") }]));
  baseline.set("w.md", { shadow: encode("w") });
  const theirs = encode("theirs\n");
  const link = { baseline, observed: { at: "x", directories: [], entries: new Map([["v.md", { size: theirs.length, modified: 1, same: false, captured: true, bytes: theirs }]]) } };
  assert.equal(sourceState(link, stack, "v.md"), "conflict");
  assert.throws(() => takeDisk(link, stack, "v.md", theirs), /Taking the folder's version of v\.md would take the folder.*past Carbon's folder limits.*Nothing was taken\./);
  assert.throws(() => keepMine(link, stack, "v.md"), /Keeping your version of v\.md would take the folder.*Nothing was changed\./);
  assert.throws(() => keepBoth(link, stack, "v.md"), /Keeping your version of v\.md/);
  // Forgetting one deleted file makes room for each.
  const room = forgetDeleted(link, stack, "f0.txt").link;
  assert.equal(takeDisk(room, stack, "v.md", theirs).stack.text("v.md"), "theirs\n");
  assert.equal(sourceState(keepMine(room, stack, "v.md").link, stack, "v.md"), "modified");
});

test("sourceSummary is memoised on the stack, baseline and observation identities", async () => {
  const { fs, stack, link } = await opened({ "a.md": "base\n" });
  const first = sourceSummary(link, stack);
  assert.equal(sourceSummary(link, stack), first, "a render without a committed change reuses the counts");
  assert.equal(sourceSummary({ ...link }, stack), first, "a new link object with the same records too");
  fs.put("a.md", "theirs\n");
  const observed = await observe(fs.root, link, stack);
  const next = sourceSummary({ ...link, observed }, stack);
  assert.notEqual(next, first);
  assert.equal(next.counts.externalChange, 1);
  const edited = stack.change({ writes: new Map([["a.md", encode("mine\n")]]) });
  const l2 = { ...link, observed, baseline: trackBaseline(link.baseline, stack, edited) };
  assert.equal(sourceSummary(l2, edited).counts.conflict, 1);
});
