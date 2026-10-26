/**
 * Integration: REAL syncFile (src/carbon/linked.js) over REAL openDiskHistory
 * (src/carbon/history/disk.js) on ONE shared in-memory directory tree.
 *
 * Handle implementation: `FakeFs` (tests/fake-fs.mjs). It has the failure injection the history
 * module needs (`failOn`, `truncateOn`) but, unlike tests/linked-fake-fs.js, no
 * `queryPermission` / `requestPermission` (which syncFile calls on every sync). `permissive()`
 * below adds them to the root handle of the same tree. Nothing else was needed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FakeFs } from "./fake-fs.mjs";
import { LocalFolder, canEdit } from "../src/carbon/local-files.js";
import { History } from "../src/core/stack.js";
import { encode, decode } from "../src/core/validate.js";
import { readDirectoryFiles } from "../src/carbon/fs.js";
import { readTarFiles } from "../src/archives/tar.js";
import { createState, commit } from "../src/carbon/state.js";
import { newLink, syncFile, linkedStatus, refreshFolder, restoreSnapshot } from "../src/carbon/linked.js";
import { keepMine, sourceState, trackBaseline } from "../src/carbon/source.js";
import { openDiskHistory, HISTORY_DIR } from "../src/carbon/history/disk.js";

const FILES = { "notes/a.md": "v0\n", "b.md": "# B\n" };
const T0 = Date.UTC(2026, 9, 22, 10, 0, 0, 0);

/** FakeFs root + the permission methods of a real FileSystemDirectoryHandle. */
function permissive(fs) {
  const perm = { queries: 0, requests: 0 };
  Object.assign(fs.root, {
    queryPermission: async () => (perm.queries++, "granted"),
    requestPermission: async () => (perm.requests++, "granted"),
  });
  return perm;
}

/** A linked workspace read the way the app reads it, with `deps.diskHistory` and `deps.commit` wired as in app.js. */
async function setup({ files = FILES, history = true } = {}) {
  const fs = new FakeFs({ clock: () => 1_700_000_000_000 });
  for (const [p, v] of Object.entries(files)) fs.seed(p, v);
  const perm = permissive(fs);
  const read = await readDirectoryFiles(fs.root);
  const state = createState();
  state.stack = new LocalFolder(read.files, read.directories, { title: "Research" });
  state.link = { ...newLink(fs.root, null, state.stack, read), consent: { granted: true, remember: false, history } };
  state.copyState = "imported";
  state.unexported = false;
  state.current = "notes/a.md";
  const clock = { t: T0, now: () => clock.t };
  const notices = [];
  const deps = {
    state,
    commit: (candidate) => {
      if (state.link && candidate?.stack && candidate.stack !== state.stack && !("link" in candidate)) {
        const baseline = trackBaseline(state.link.baseline, state.stack, candidate.stack);
        if (baseline !== state.link.baseline) candidate = { ...candidate, link: { ...state.link, baseline } };
      }
      return commit(state, null, candidate);
    },
    notify: (m, kind = "info", actions = []) => notices.push({ m, kind, actions }),
    modal: async () => assert.fail("consent was pre-granted; the modal must not open"),
    render: () => {},
    // app.js: (handle) => openDiskHistory(handle). Only the clock is injected for determinism.
    diskHistory: (handle) => openDiskHistory(handle, { now: clock.now }),
    now: () => new Date(clock.t),
  };
  /** Save in Carbon (a virtual revision), as the Editor does. */
  const edit = async (text, path = "notes/a.md") => {
    const next = state.stack.change({ writes: new Map([[path, encode(text)]]) });
    const h = new History([...state.history.items]);
    h.push(state.stack, `Before saving ${path}`);
    await deps.commit({ stack: next, history: h, unexported: true, copyState: "pending" });
  };
  /** Save in Carbon, then Sync that file to the folder (the only disk write). */
  const save = async (text, path = "notes/a.md", options) => {
    await edit(text, path);
    clock.t += 1000;
    return syncFile(deps, path, options);
  };
  // restoreFromDisk exactly as app.js wires it: into Carbon's copy, History first; the folder is written only by Sync.
  const restoreFromDisk = (path, bytes) => restoreSnapshot(deps, path, bytes);
  const history$ = () => openDiskHistory(fs.root, { now: clock.now });
  return { fs, perm, state, deps, clock, notices, edit, save, restoreFromDisk, history$ };
}
const snapshotFiles = (fs) => fs.files(`${HISTORY_DIR}/versions/`);
const textOf = (fs, p) => decode(fs.bytes(p));
const versions = async (s, p = "notes/a.md") => {
  const h = await s.history$();
  return Promise.all((await h.list(p)).map(async (v) => decode(await h.read(v.id))));
};

test("sync with history on stores the previous disk bytes as a verified snapshot", async () => {
  const s = await setup();
  const r = await s.save("v1\n");
  assert.deepEqual({ ...r }, { ok: true, path: "notes/a.md", backedUp: true, written: true });
  assert.equal(textOf(s.fs, "notes/a.md"), "v1\n");

  const files = snapshotFiles(s.fs);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\.carbon-history\/versions\/notes\/a\.\d{8}T\d{9}Z\.[0-9a-f]{6}\.m\d{8}T\d{9}Z\.md$/);
  assert.equal(textOf(s.fs, files[0]), "v0\n");

  const h = await s.history$();
  const list = await h.list("notes/a.md");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, files[0]);
  assert.equal(list[0].size, 3);
  assert.equal(list[0].savedAt, T0 + 1000);
  assert.equal(typeof list[0].modified, "number"); // linked.js passes disk.modified through to preserve
  assert.equal(decode(await h.read(list[0].id)), "v0\n");

  assert.equal(s.state.link.historyOk, true);
  assert.match(s.notices.at(-1).m, /The previous version is in local history\./);
  assert.equal(linkedStatus(s.state, "notes/a.md").kind, "synced");
  assert.equal(s.state.stack.text("notes/a.md"), "v1\n");
  // The workspace never writes anything but the file and the history directory.
  assert.deepEqual(s.fs.files().filter((p) => !p.startsWith(HISTORY_DIR)), ["b.md", "notes/a.md"]);
});

test("Save in Carbon alone writes nothing to the folder, not even history; a second sync adds a second snapshot, newest first", async () => {
  const s = await setup();
  await s.edit("v1\n");
  await s.edit("v1b\n");
  assert.equal(textOf(s.fs, "notes/a.md"), "v0\n");
  assert.deepEqual(s.fs.files().filter((p) => p.startsWith(HISTORY_DIR)), []);
  assert.equal(sourceState(s.state.link, s.state.stack, "notes/a.md"), "modified");
  await s.save("v1\n");
  await s.save("v2\n"); // baseline is the verified v1 written by the first sync: no false refusal
  assert.equal(textOf(s.fs, "notes/a.md"), "v2\n");
  const h = await s.history$();
  const list = await h.list("notes/a.md");
  assert.equal(list.length, 2);
  assert.ok(list[0].savedAt > list[1].savedAt);
  assert.deepEqual(await versions(s), ["v1\n", "v0\n"]);
});

test("failure policy: a history write failure stops the sync and leaves the original untouched; skipHistory syncs without backup", async () => {
  const s = await setup();
  const before = s.fs.bytes("notes/a.md").slice();
  s.fs.failOn(/\.carbon-history\/versions\//, { stage: "close" });

  await assert.rejects(
    () => s.save("v1\n"),
    /Sync stopped: the backup could not be written \(.*\)\. The original file is unchanged\./,
  );
  assert.deepEqual(s.fs.bytes("notes/a.md"), before);
  assert.equal(s.state.stack.text("notes/a.md"), "v1\n", "Carbon's copy keeps the edit");
  assert.equal(s.state.link.historyOk, false);
  assert.equal(s.state.link.op.kind, "syncFailed");
  assert.equal(linkedStatus(s.state, "notes/a.md").kind, "syncFailed");
  // No visible snapshot, and no half-written leftover either.
  assert.deepEqual(snapshotFiles(s.fs), []);
  s.fs.clearFailures();
  assert.deepEqual(await (await s.history$()).list("notes/a.md"), []);

  // The user-confirmed one-off: skipHistory.
  s.fs.failOn(/\.carbon-history\/versions\//, { stage: "close" });
  const r = await syncFile(s.deps, "notes/a.md", { skipHistory: true });
  assert.deepEqual({ ...r }, { ok: true, path: "notes/a.md", backedUp: false, written: true });
  assert.equal(textOf(s.fs, "notes/a.md"), "v1\n");
  assert.deepEqual(snapshotFiles(s.fs), []);
});

test("failure policy: a silently truncated backup is caught by history's own verification and stops the sync", async () => {
  const s = await setup();
  s.fs.truncateOn(/\.carbon-history\/versions\//, 1);
  await assert.rejects(() => s.save("v1\n"), /Sync stopped: the backup could not be written \(.*verification failed.*\)\. The original file is unchanged\./);
  assert.equal(textOf(s.fs, "notes/a.md"), "v0\n");
  assert.deepEqual(snapshotFiles(s.fs), []);
});

test("failure policy: history that cannot even be opened stops the sync before any write", async () => {
  const s = await setup();
  s.fs.failOn(/^\.carbon-history$/, { stage: "getDirectory", name: "NotAllowedError" });
  await assert.rejects(() => s.save("v1\n"), /Sync stopped: the backup could not be written \(Local history unavailable/);
  assert.equal(textOf(s.fs, "notes/a.md"), "v0\n");
  assert.equal(s.fs.files(HISTORY_DIR).length, 0);
});

test("history off in consent: no .carbon-history directory is ever created", async () => {
  const s = await setup({ history: false });
  const r = await s.save("v1\n");
  assert.equal(r.backedUp, false);
  assert.deepEqual(s.fs.directories().filter((d) => d.startsWith(HISTORY_DIR)), []);
});

test(".carbon-history is invisible to the workspace read path and to Refresh; exportArchive round-trips through readTarFiles", async () => {
  const s = await setup();
  await s.save("v1\n");
  await s.save("v2\n");
  assert.ok(snapshotFiles(s.fs).length === 2);

  const { files, directories } = await readDirectoryFiles(s.fs.root);
  assert.deepEqual(files.map(([p]) => p).sort(), ["b.md", "notes/a.md"]);
  assert.ok(![...directories].some((d) => d.startsWith(".carbon-history")));
  assert.deepEqual(files.find(([p]) => p === "notes/a.md")[1], encode("v2\n"));
  await refreshFolder(s.deps);
  assert.ok(![...s.state.link.observed.entries.keys()].some((p) => p.startsWith(".carbon-history")));
  assert.match(s.notices.at(-1).m, /no difference from Carbon's copy/);

  const h = await s.history$();
  const tar = readTarFiles(await h.exportArchive());
  const map = new Map(tar.files);
  const rel = (id) => id.slice(HISTORY_DIR.length + 1);
  const list = await h.list("notes/a.md");
  assert.deepEqual([...map.keys()].sort(), ["README.txt", "carbon-history.json", ...list.map((v) => rel(v.id))].sort());
  assert.equal(decode(map.get(rel(list[0].id))), "v1\n");
  assert.equal(decode(map.get(rel(list[1].id))), "v0\n");
  assert.deepEqual(map.get("carbon-history.json"), s.fs.bytes(`${HISTORY_DIR}/carbon-history.json`));
});

test("external modification: Sync is refused (nothing written, no snapshot); after Refresh and Keep mine, Sync backs up the EXTERNAL bytes", async () => {
  const s = await setup();
  await s.save("v1\n");
  const snapshotsBefore = snapshotFiles(s.fs);
  s.fs.seed("notes/a.md", "external\n"); // changed outside Carbon

  s.fs.log.length = 0;
  const r = await s.save("mine\n");
  assert.deepEqual({ ...r }, { ok: false, reason: "conflict" });
  assert.equal(textOf(s.fs, "notes/a.md"), "external\n");
  assert.deepEqual(snapshotFiles(s.fs), snapshotsBefore);
  assert.equal(s.fs.log.filter((l) => l.startsWith("create ")).length, 0, "no writable may be opened on a refusal");
  assert.equal(linkedStatus(s.state, "notes/a.md").kind, "conflict");

  await refreshFolder(s.deps);
  assert.equal(sourceState(s.state.link, s.state.stack, "notes/a.md"), "conflict");
  await s.deps.commit(keepMine(s.state.link, s.state.stack, "notes/a.md"));
  assert.equal(sourceState(s.state.link, s.state.stack, "notes/a.md"), "modified");
  s.clock.t += 1000;
  const r2 = await syncFile(s.deps, "notes/a.md");
  assert.deepEqual({ ...r2 }, { ok: true, path: "notes/a.md", backedUp: true, written: true });
  assert.equal(textOf(s.fs, "notes/a.md"), "mine\n");
  // v1 was replaced by the external edit before Carbon could see it, so it is not (and cannot be) in history.
  assert.deepEqual(await versions(s), ["external\n", "v0\n"]);
});

test("a path inside .carbon-history is refused before any write", async () => {
  const s = await setup();
  // 1) Through the normal path: the workspace never contains it, so syncFile refuses up front.
  await s.save("v1\n"); // creates the history directory
  const snap = snapshotFiles(s.fs)[0];
  s.fs.log.length = 0;
  await assert.rejects(() => syncFile(s.deps, snap), /Not a file in Carbon/);
  await assert.rejects(() => syncFile(s.deps, `${HISTORY_DIR}/README.txt`), /Not a file in Carbon/);
  assert.equal(s.fs.log.filter((l) => l.startsWith("create ")).length, 0);

  // 2) A workspace that DOES contain such a file (New file in Carbon, or a restored cache): Sync refuses
  //    it up front, before consent or any folder access, whatever the history settings.
  const fs = new FakeFs();
  fs.seed("ok.md", "ok");
  fs.seed(`${HISTORY_DIR}/notes.md`, "inside history");
  permissive(fs);
  const state = createState();
  state.stack = new LocalFolder([["ok.md", encode("ok")], [`${HISTORY_DIR}/notes.md`, encode("inside history")]], [], { title: "T" });
  state.link = { ...newLink(fs.root, null, state.stack, null), consent: { granted: true, remember: false, history: true } };
  state.copyState = "imported";
  const deps = {
    state,
    commit: (c) => commit(state, null, c),
    notify: () => {},
    modal: async () => assert.fail("no modal expected"),
    diskHistory: (h) => openDiskHistory(h),
  };
  await deps.commit({ stack: state.stack.change({ writes: new Map([[`${HISTORY_DIR}/notes.md`, encode("new")]]) }), link: { ...state.link, baseline: new Map([["ok.md", {}], [`${HISTORY_DIR}/notes.md`, { shadow: encode("inside history") }]]) } });
  fs.log.length = 0;
  for (const [p, consent] of [[`${HISTORY_DIR}/notes.md`, true], [`${HISTORY_DIR}/carbon-history.json`, false]]) {
    if (!state.stack.files.has(p)) await deps.commit({ stack: state.stack.change({ writes: new Map([[p, encode("")]]) }) });
    state.link = { ...state.link, consent: { granted: consent, remember: false, history: consent } };
    await assert.rejects(() => syncFile(deps, p), /inside \.carbon-history\/, which Carbon reserves for local file history.*Nothing was written/, p);
    await assert.rejects(() => syncFile(deps, p, { skipHistory: true }), /reserves for local file history/, p);
  }
  assert.equal(textOf(fs, `${HISTORY_DIR}/notes.md`), "inside history");
  assert.deepEqual(fs.log, [], "no folder access at all (the modal would also have failed the test)");

  // That .carbon-history/ was not created by Carbon (no manifest): opening it for writing refuses and changes nothing.
  fs.log.length = 0;
  await assert.rejects(() => openDiskHistory(fs.root), /already exists in the folder but was not created by Carbon \(no carbon-history\.json; it holds notes\.md\)/);
  assert.equal(fs.log.filter((l) => l.startsWith("create ") || l.startsWith("write ")).length, 0);
  // preserve() itself, and the other history entry points, refuse such paths too (on a history Carbon created).
  const own = new FakeFs();
  permissive(own);
  const h = await openDiskHistory(own.root);
  await assert.rejects(() => h.preserve(`${HISTORY_DIR}/versions/x.md`, encode("x")), /cannot snapshot its own folder/);
  await assert.rejects(() => h.preserve("../x.md", encode("x")));
  await assert.rejects(() => h.read("notes/a.md"), /Not a local history snapshot/);
});

test("Sync never writes into a .carbon-history/ Carbon did not create; an empty one or an interrupted Carbon one is initialised (owner gate P1)", async () => {
  // Foreign: a README with someone's notes and no manifest. History is on (the default).
  const s = await setup({ files: { ...FILES, [`${HISTORY_DIR}/README.txt`]: "unrelated user notes\n" } });
  await s.edit("mine\n");
  s.fs.log.length = 0;
  await assert.rejects(
    () => syncFile(s.deps, "notes/a.md"),
    /Sync stopped: the backup could not be written \(Local history unavailable: \.carbon-history\/ already exists in the folder but was not created by Carbon \(no carbon-history\.json; it holds README\.txt\)\. Carbon does not write into it and changed nothing.*\)\. The original file is unchanged\./,
  );
  assert.equal(textOf(s.fs, `${HISTORY_DIR}/README.txt`), "unrelated user notes\n", "the foreign README is byte-identical");
  assert.equal(textOf(s.fs, "notes/a.md"), "v0\n", "the source file is not written");
  assert.equal(s.fs.log.filter((l) => /^(create|write|close|remove) /.test(l)).length, 0, "no write of any kind");
  assert.deepEqual(s.notices.at(-1)?.actions?.map((a) => a.label) ?? [], [], "refused by a throw, not reported as synced");
  assert.equal(sourceState(s.state.link, s.state.stack, "notes/a.md"), "modified");

  // An empty .carbon-history/ (e.g. created by hand) is initialised and used normally.
  const e = await setup();
  await e.fs.root.getDirectoryHandle(HISTORY_DIR, { create: true });
  await e.save("v1\n");
  assert.equal(textOf(e.fs, "notes/a.md"), "v1\n");
  assert.deepEqual(await versions(e), ["v0\n"]);

  // Carbon's own README alone (an initialisation interrupted before the manifest) is completed, not refused.
  const probe = new FakeFs();
  permissive(probe);
  await openDiskHistory(probe.root);
  const readme = textOf(probe, `${HISTORY_DIR}/README.txt`);
  const i = await setup({ files: { ...FILES, [`${HISTORY_DIR}/README.txt`]: readme } });
  await i.save("v1\n");
  assert.equal(textOf(i.fs, "notes/a.md"), "v1\n");
  assert.deepEqual(await versions(i), ["v0\n"]);
});

test("a normal sibling whose name merely starts with .carbon-history is still synced with history", async () => {
  // Only a first segment named exactly ".carbon-history" is reserved; readDirectoryFiles hides the
  // same exact directory, so ".carbon-history-notes.md" is an ordinary file in both modules.
  const s = await setup({ files: { ".carbon-history-notes.md": "n0\n", "x.md": "x" } });
  const result = await s.save("n1\n", ".carbon-history-notes.md");
  assert.equal(result.backedUp, true);
  assert.equal(textOf(s.fs, ".carbon-history-notes.md"), "n1\n");
  const h = await openDiskHistory(s.fs.root, { now: () => T0 });
  assert.equal((await h.list(".carbon-history-notes.md")).length, 1);
});

test("two syncs in the same millisecond (fresh DiskHistory per sync, as in app.js) both survive", async () => {
  const s = await setup();
  s.deps.diskHistory = (handle) => openDiskHistory(handle, { now: () => T0 });
  await s.edit("v1\n");
  await syncFile(s.deps, "notes/a.md");
  await s.edit("v2\n");
  await syncFile(s.deps, "notes/a.md");
  const h = await openDiskHistory(s.fs.root, { now: () => T0 });
  const list = await h.list("notes/a.md");
  assert.equal(list.length, 2);
  // Order within one millisecond is only defined by the tie-break (id), not by recency: not asserted.
  assert.deepEqual((await Promise.all(list.map(async (v) => decode(await h.read(v.id))))).sort(), ["v0\n", "v1\n"]);
});

test("restore as app.js wires it: the old bytes go into Carbon's copy (History first); the folder changes only when synced, with a backup", async () => {
  const s = await setup();
  await s.save("v1\n");
  await s.save("v2\n");
  const h = await s.history$();
  const oldest = (await h.list("notes/a.md")).at(-1);
  const oldBytes = await h.read(oldest.id);
  assert.equal(decode(oldBytes), "v0\n");

  const revision = s.state.stack.manifest.revision;
  await s.restoreFromDisk("notes/a.md", oldBytes);
  assert.equal(s.state.stack.text("notes/a.md"), "v0\n");
  assert.equal(s.state.stack.manifest.revision, revision + 1);
  assert.equal(s.state.history.items.at(-1).label, "Before restoring notes/a.md from local history");
  assert.equal(textOf(s.fs, "notes/a.md"), "v2\n", "the folder is not written by a restore");
  assert.equal((await (await s.history$()).list("notes/a.md")).length, 2);
  assert.equal(sourceState(s.state.link, s.state.stack, "notes/a.md"), "modified");

  s.clock.t += 1000;
  await syncFile(s.deps, "notes/a.md");
  assert.equal(textOf(s.fs, "notes/a.md"), "v0\n");
  assert.deepEqual(await versions(s), ["v2\n", "v1\n", "v0\n"]); // newest first; v2 is the pre-restore version
  // Restoring does not spend the snapshot it was restored from.
  assert.ok((await (await s.history$()).list("notes/a.md")).some((v) => v.id === oldest.id));
});

test("a draft blocks the restore; a restored version over an externally changed file is refused by Sync until the conflict is resolved", async () => {
  const s = await setup();
  await s.save("v1\n");
  const h = await s.history$();
  const oldBytes = await h.read((await h.list("notes/a.md")).at(-1).id);
  assert.equal(decode(oldBytes), "v0\n");

  s.state.drafts.set("notes/a.md", "typing\n");
  await assert.rejects(() => s.restoreFromDisk("notes/a.md", oldBytes), /Save or discard the draft first/);
  s.state.drafts.clear();

  s.fs.seed("notes/a.md", "external\n");
  const before = snapshotFiles(s.fs);
  const result = await s.restoreFromDisk("notes/a.md", oldBytes);
  assert.deepEqual(result, { ok: true, path: "notes/a.md" });
  assert.equal(s.state.stack.text("notes/a.md"), "v0\n");
  assert.equal(textOf(s.fs, "notes/a.md"), "external\n");
  assert.deepEqual(snapshotFiles(s.fs), before);
  const refused = await syncFile(s.deps, "notes/a.md");
  assert.deepEqual({ ...refused }, { ok: false, reason: "conflict" });
  assert.equal(textOf(s.fs, "notes/a.md"), "external\n");
  assert.deepEqual(s.notices.at(-1).actions.map((a) => a.label), ["Refresh from folder"]);
  await refreshFolder(s.deps);
  await s.deps.commit(keepMine(s.state.link, s.state.stack, "notes/a.md"));
  s.clock.t += 1000;
  await syncFile(s.deps, "notes/a.md");
  assert.equal(textOf(s.fs, "notes/a.md"), "v0\n");
  assert.ok((await versions(s)).includes("external\n"), "the external version was backed up before being replaced");
});

test("browsing opens existing history read-only without any consent flags (app.js openHistory)", async () => {
  const s = await setup();
  await s.save("v1\n");
  // Reopened folder, consent forgotten / never granted / future backups off: browsing must still work.
  for (const consent of [{ granted: false, remember: false, history: false }, { granted: true, remember: false, history: false }]) {
    s.state.link = { ...s.state.link, consent };
    s.fs.failOn(/./, { stage: "create" });
    s.fs.failOn(/./, { stage: "remove" });
    const h = await openDiskHistory(s.state.link.handle, { now: s.clock.now, create: false });
    s.fs.clearFailures();
    const list = await h.list("notes/a.md");
    assert.equal(list.length, 1);
    assert.equal(decode(await h.read(list[0].id)), "v0\n");
  }
});

test("a restore needs no folder access at all: it succeeds with every write failing, and the later Sync follows the folder's consent", async () => {
  const s = await setup();
  await s.save("v1\n");
  const h = await s.history$();
  const oldBytes = await h.read((await h.list("notes/a.md")).at(-1).id);
  s.state.link = { ...s.state.link, consent: { granted: true, remember: false, history: false }, status: "permission" };
  s.fs.failOn(/./, { stage: "create" });
  s.fs.failOn(/./, { stage: "close" });
  await s.restoreFromDisk("notes/a.md", oldBytes);
  assert.equal(s.state.stack.text("notes/a.md"), "v0\n");
  assert.equal(textOf(s.fs, "notes/a.md"), "v1\n");
  s.fs.clearFailures();
  s.state.link.status = "linked";
  s.clock.t += 1000;
  const r = await syncFile(s.deps, "notes/a.md");
  assert.deepEqual({ ...r }, { ok: true, path: "notes/a.md", backedUp: false, written: true });
  assert.equal(textOf(s.fs, "notes/a.md"), "v0\n");
  assert.deepEqual(await versions(s), ["v0\n"], "history off: the sync wrote no backup");
});

test("disk-history Restore of a Markdown snapshot that is not text restores it read-only (Copilot review round 2)", async () => {
  const s = await setup();
  await s.edit("mine\n"); // saved in Carbon, not synced
  const bad = new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x00, 0x0a]);
  s.fs.seed("notes/a.md", bad); // replaced outside Carbon by bytes the Editor cannot open
  await refreshFolder(s.deps);
  await s.deps.commit(keepMine(s.state.link, s.state.stack, "notes/a.md"));
  s.clock.t += 1000;
  await syncFile(s.deps, "notes/a.md"); // backs the unreadable version up into .carbon-history
  const h = await s.history$();
  const snap = (await h.list("notes/a.md")).find((v) => v.size === bad.length);
  const bytes = await h.read(snap.id);
  assert.deepEqual(bytes, bad);
  await s.restoreFromDisk("notes/a.md", bytes);
  assert.deepEqual(s.state.stack.files.get("notes/a.md"), bad);
  assert.equal(canEdit(s.state.stack, "notes/a.md"), false, "read-only, with its reason, like any unreadable file");
  assert.equal(s.state.history.items.at(-1).label, "Before restoring notes/a.md from local history");
  assert.equal(s.state.copyState, "pending");
  assert.equal(textOf(s.fs, "notes/a.md"), "mine\n", "the folder is not written by a restore");
});
