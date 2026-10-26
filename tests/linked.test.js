import test from "node:test";
import assert from "node:assert/strict";
import { fakeFolder } from "./linked-fake-fs.js";
import { LocalFolder, canEdit, restoreFolder, archiveWorkspace } from "../src/carbon/local-files.js";
import { readTarFiles } from "../src/archives/tar.js";
import { History } from "../src/core/stack.js";
import { encode, decode, equal, LIMITS } from "../src/core/validate.js";
import { readDirectoryFiles } from "../src/carbon/fs.js";
import { createState, serialize, restore, commit } from "../src/carbon/state.js";
import { recordBytes } from "../src/carbon/vfs.js";
import {
  newLink, syncFile, takeDiskVersion, readFolderVersion, refreshFolder, linkedStatus, verifyLink, reconnectLink, createFolderMemory, forgetConsent, readDisk,
} from "../src/carbon/linked.js";
import { sourceState, sourceRows, baselineBytes, trackBaseline, importIncoming, forgetDeleted } from "../src/carbon/source.js";
import { sample } from "./helpers.js";
import { openDiskHistory } from "../src/carbon/history/disk.js";

const FILES = { "notes/a.md": "# A\n", "b.md": "# B\n", "data.csv": "x,y\n" };

/**
 * A linked workspace over a fake folder, read and linked the way the app does it (`stageFolder`),
 * with recording deps. `deps.commit` carries the baseline forward exactly as app.js does.
 */
async function setup({ consent = { granted: true, remember: false, history: true }, files = FILES, history = "ok", answer = null } = {}) {
  const fs = fakeFolder(files, { name: "Research" });
  const read = await readDirectoryFiles(fs.root);
  const state = createState();
  state.stack = new LocalFolder(read.files, read.directories, { title: "Research" });
  state.link = { ...newLink(fs.root, null, state.stack, read), consent };
  state.copyState = "imported";
  state.unexported = false;
  state.current = "notes/a.md";
  const preserved = [], notices = [], modals = [], remembered = [], commits = [];
  const deps = {
    state,
    commit: (candidate) => {
      if (state.link && candidate?.stack && candidate.stack !== state.stack && !("link" in candidate)) {
        const baseline = trackBaseline(state.link.baseline, state.stack, candidate.stack);
        if (baseline !== state.link.baseline) candidate = { ...candidate, link: { ...state.link, baseline } };
      }
      commits.push(Object.keys(candidate).sort());
      return commit(state, null, candidate);
    },
    notify: (m, kind = "info", actions = []) => notices.push({ m, kind, actions }),
    modal: async (title) => { modals.push(title); return answer; },
    confirm: async () => true,
    render: () => {},
    folderMemory: { remember: async (h, c) => remembered.push(c) },
    diskHistory: history === "ok"
      ? async () => ({ preserve: async (p, b, o) => { preserved.push([p, decode(b), o]); return { id: "h1" }; } })
      : history === "throw"
        ? async () => ({ preserve: async () => { throw new Error("disk full"); } })
        : null,
    now: () => new Date("2026-10-26T10:00:00Z"),
  };
  /** Save in Carbon, as the Editor does: one commit of the new revision, History first. */
  const save = async (path, text) => {
    const next = state.stack.change({ writes: new Map([[path, encode(text)]]) });
    const h = new History([...state.history.items]);
    h.push(state.stack, `Before saving ${path}`);
    const drafts = new Map(state.drafts);
    drafts.delete(path);
    await deps.commit({ stack: next, history: h, drafts, unexported: true, copyState: "pending" });
  };
  const st = (p) => sourceState(state.link, state.stack, p);
  return { fs, state, deps, preserved, notices, modals, remembered, commits, save, st };
}
/** Every fake-handle operation that could create or write anything. */
const writeAttempts = (fs) => fs.ctl.writes.length + fs.ctl.creates;

// ---- Save, structure and History are virtual: zero writes --------------------------------------------

test("opening links every imported file as the baseline and observes the folder from the same read; nothing is written", async () => {
  const s = await setup();
  assert.deepEqual([...s.state.link.baseline.keys()].sort(), ["b.md", "data.csv", "notes/a.md"]);
  assert.ok(s.state.link.observed);
  assert.equal(s.state.link.observed.entries.get("notes/a.md").same, true);
  assert.equal(typeof s.state.link.observed.entries.get("notes/a.md").modified, "number");
  assert.deepEqual(new Set(sourceRows(s.state.link, s.state.stack).map((r) => r.state)), new Set(["synced"]));
  assert.equal(s.state.link.lastSync, null);
  assert.equal(writeAttempts(s.fs), 0);
  assert.equal(s.fs.ctl.requests, 0);
});

test("Save keeps the edit in Carbon only: the folder is byte-identical, no handle is written or created, even with access denied", async () => {
  const s = await setup();
  s.fs.ctl.perm.read = "denied";
  s.fs.ctl.perm.readwrite = "denied";
  s.state.link.status = "permission";
  const reads = s.fs.ctl.reads;
  await s.save("notes/a.md", "# A edited\n");
  assert.equal(s.state.stack.text("notes/a.md"), "# A edited\n");
  assert.equal(s.fs.text("notes/a.md"), "# A\n");
  assert.equal(writeAttempts(s.fs), 0);
  assert.equal(s.fs.ctl.reads, reads, "Save does not even read the folder");
  assert.equal(s.fs.ctl.requests + s.fs.ctl.queries, 0);
  assert.equal(s.st("notes/a.md"), "modified");
  assert.equal(decode(baselineBytes(s.state.link, s.state.stack, "notes/a.md")), "# A\n", "the shadow holds the folder's bytes");
  assert.equal(s.state.history.items.at(-1).label, "Before saving notes/a.md");
  assert.equal(s.state.link.status, "permission", "the link is untouched");
  // The same workspace status is reported for a folder that is unavailable.
  s.state.link.status = "unavailable";
  await s.save("b.md", "# B2\n");
  assert.equal(s.st("b.md"), "modified");
  assert.equal(writeAttempts(s.fs), 0);
});

test("New file, rename, delete and History restore are virtual revisions that keep the link and track the baseline", async () => {
  const s = await setup();
  const { state, deps } = s;
  const link = state.link;
  const opened = state.stack;
  // New file (never on disk): virtual.
  await deps.commit({ stack: state.stack.change({ writes: new Map([["new.txt", encode("hello")]]) }), history: new History(), unexported: true, copyState: "pending" });
  assert.equal(state.link, link, "a commit without link changes leaves the link object alone");
  assert.equal(s.st("new.txt"), "virtual");
  // Rename: the old path keeps the folder's bytes as a shadow (deleted in Carbon), the new path is virtual.
  await deps.commit({ stack: state.stack.change({ moves: [["b.md", "c.md"]] }) });
  assert.equal(s.st("b.md"), "deletedInCarbon");
  assert.equal(s.st("c.md"), "virtual");
  assert.equal(decode(baselineBytes(state.link, state.stack, "b.md")), "# B\n");
  // Delete.
  await deps.commit({ stack: state.stack.change({ deletes: ["data.csv"] }) });
  assert.equal(s.st("data.csv"), "deletedInCarbon");
  assert.equal(state.link.handle, link.handle);
  assert.deepEqual(state.link.consent, link.consent);
  // History restore brings the files back as a new revision: the shadows match again and are dropped.
  const h = new History([...state.history.items]);
  h.push(state.stack, "Before restoring History");
  await deps.commit({ stack: restoreFolder(state.stack, h, opened), history: h, unexported: true, copyState: "pending" });
  assert.deepEqual(Object.fromEntries(sourceRows(state.link, state.stack).map((r) => [r.path, r.state])), { "b.md": "synced", "data.csv": "synced", "notes/a.md": "synced" });
  assert.equal(writeAttempts(s.fs), 0);
  assert.equal(s.fs.ctl.reads, 3, "only the open read the folder");
});

// ---- Sync file to folder ------------------------------------------------------------------------------

test("sync writes the committed bytes of one file, verifies them, backs up the previous version, then records the baseline", async () => {
  const s = await setup();
  await s.save("notes/a.md", "# A edited\n");
  const revision = s.state.stack.manifest.revision;
  assert.deepEqual(s.commits.at(-1), ["copyState", "drafts", "history", "link", "stack", "unexported"]);
  const r = await syncFile(s.deps, "notes/a.md");
  assert.deepEqual({ ...r }, { ok: true, path: "notes/a.md", backedUp: true, written: true });
  assert.equal(s.fs.text("notes/a.md"), "# A edited\n");
  assert.deepEqual(s.preserved.map(([p, t]) => [p, t]), [["notes/a.md", "# A\n"]]);
  assert.equal(typeof s.preserved[0][2].modified, "number");
  assert.equal(s.state.stack.manifest.revision, revision, "Sync is not a revision: the virtual bytes were already committed");
  assert.deepEqual(s.commits.at(-1), ["link"], "Sync commits the link only");
  assert.equal(s.st("notes/a.md"), "synced");
  assert.deepEqual(s.state.link.lastSync, { path: "notes/a.md", at: "2026-10-26T10:00:00.000Z" });
  assert.equal(s.state.link.observed.entries.get("notes/a.md").same, true);
  assert.equal(s.state.link.op, null);
  assert.match(s.notices.at(-1).m, /^Synced Research\/notes\/a\.md \(written and read back\)\. The previous version is in local history\.$/);
  assert.equal(linkedStatus(s.state, "notes/a.md").kind, "synced");
  assert.equal(s.fs.has("stack.yaml"), false);
  assert.equal(s.fs.text("b.md"), "# B\n");
  assert.deepEqual(s.fs.ctl.writes.map(([p]) => p), ["notes/a.md"]);
});

test("a file created in Carbon is synced as a new file: the disk must be absent, no backup is made, parents are created", async () => {
  const s = await setup();
  await s.deps.commit({ stack: s.state.stack.change({ writes: new Map([["deep/dir/new.txt", encode("hello")]]) }) });
  assert.equal(s.st("deep/dir/new.txt"), "virtual");
  const r = await syncFile(s.deps, "deep/dir/new.txt");
  assert.deepEqual({ ...r }, { ok: true, path: "deep/dir/new.txt", backedUp: false, written: true });
  assert.equal(s.fs.text("deep/dir/new.txt"), "hello");
  assert.equal(s.preserved.length, 0);
  assert.equal(s.st("deep/dir/new.txt"), "synced");
  // A second sync of the same bytes writes nothing.
  const again = await syncFile(s.deps, "deep/dir/new.txt");
  assert.equal(again.written, false);
  assert.equal(s.fs.ctl.writes.length, 1);
  // A virtual path that meanwhile appeared on disk with other bytes is refused, nothing overwritten.
  await s.deps.commit({ stack: s.state.stack.change({ writes: new Map([["other.txt", encode("mine")]]) }) });
  s.fs.put("other.txt", "theirs");
  const refused = await syncFile(s.deps, "other.txt");
  assert.deepEqual(refused, { ok: false, reason: "conflict" });
  assert.equal(s.fs.text("other.txt"), "theirs");
  assert.match(s.notices.at(-1).m, /already exists in the folder but was never imported into Carbon/);
  assert.deepEqual(s.notices.at(-1).actions.map((a) => a.label), ["Refresh from folder"]);
  assert.equal(linkedStatus(s.state, "other.txt").kind, "conflict");
});

test("sync refuses while the file has a draft: the saved copy, never the draft, is what reaches the disk", async () => {
  const s = await setup();
  s.state.drafts.set("notes/a.md", "typing\n");
  await assert.rejects(() => syncFile(s.deps, "notes/a.md"), /Save or discard the draft of notes\/a\.md first: Sync writes the saved copy, never a draft\. Nothing was written\./);
  assert.equal(writeAttempts(s.fs), 0);
  assert.equal(s.fs.ctl.queries + s.fs.ctl.requests, 0, "refused before any permission check");
  assert.equal(s.state.drafts.get("notes/a.md"), "typing\n");
});

test("sync refuses when the folder differs from the baseline: nothing written, Refresh offered; after Refresh the row is a conflict", async () => {
  const s = await setup();
  await s.save("notes/a.md", "# mine\n");
  s.fs.put("notes/a.md", "# A changed elsewhere\n");
  const r = await syncFile(s.deps, "notes/a.md");
  assert.deepEqual(r, { ok: false, reason: "conflict" });
  assert.equal(s.fs.text("notes/a.md"), "# A changed elsewhere\n");
  assert.equal(s.fs.ctl.writes.length, 0);
  assert.equal(s.preserved.length, 0);
  assert.equal(s.state.stack.text("notes/a.md"), "# mine\n", "Carbon's copy is untouched");
  assert.equal(linkedStatus(s.state, "notes/a.md").kind, "conflict");
  assert.equal(linkedStatus(s.state, "notes/a.md").label, "Sync refused");
  const notice = s.notices.at(-1);
  assert.equal(notice.kind, "error");
  assert.match(notice.m, /changed in the folder since Carbon last read it\. Nothing was overwritten/);
  assert.deepEqual(notice.actions.map((a) => a.label), ["Refresh from folder"]);
  await notice.actions[0].onClick();
  assert.equal(s.state.link.op, null, "Refresh clears the sync status");
  assert.equal(s.st("notes/a.md"), "conflict");
  assert.equal(linkedStatus(s.state, "notes/a.md").label, "Changed in folder and in Carbon");
  assert.equal(s.state.stack.text("notes/a.md"), "# mine\n");
  assert.equal(writeAttempts(s.fs), 0);
});

test("a baseline file removed outside Carbon is not recreated silently: Sync refuses and offers Recreate, which writes without a backup", async () => {
  const s = await setup();
  await s.save("notes/a.md", "# mine\n");
  s.fs.remove("notes/a.md");
  const r = await syncFile(s.deps, "notes/a.md");
  assert.equal(r.reason, "conflict");
  assert.match(s.notices.at(-1).m, /no longer in the folder \(removed or renamed outside Carbon\)\. Nothing was written/);
  assert.equal(s.fs.has("notes/a.md"), false);
  assert.deepEqual(s.notices.at(-1).actions.map((a) => a.label), ["Recreate in folder", "Refresh from folder"]);
  await assert.rejects(() => takeDiskVersion(s.deps, "notes/a.md"), /no longer in the folder/);
  await s.notices.at(-1).actions[0].onClick();
  assert.equal(s.fs.text("notes/a.md"), "# mine\n");
  assert.equal(s.preserved.length, 0);
  assert.equal(s.st("notes/a.md"), "synced");
});

test("a disk already holding the virtual bytes (matched) is recorded as synced without a write", async () => {
  const s = await setup();
  await s.save("notes/a.md", "# same\n");
  s.fs.put("notes/a.md", "# same\n"); // copied by hand outside Carbon
  s.state.link.observed = null;
  await refreshFolder(s.deps);
  assert.equal(s.st("notes/a.md"), "matched");
  assert.equal(linkedStatus(s.state, "notes/a.md").label, "Same as folder, not recorded as synced");
  const r = await syncFile(s.deps, "notes/a.md");
  assert.deepEqual({ ...r }, { ok: true, path: "notes/a.md", backedUp: false, written: false });
  assert.equal(s.fs.ctl.writes.length, 0);
  assert.equal(s.preserved.length, 0);
  assert.equal(s.st("notes/a.md"), "synced");
  assert.match(s.notices.at(-1).m, /already held these bytes; recorded as synced, nothing written/);
});

test("write permission: prompt then granted syncs; denied refuses, keeps the copy and reports permission status until Reconnect", async () => {
  const s = await setup();
  await s.save("notes/a.md", "ok\n");
  s.fs.ctl.perm.readwrite = "prompt";
  await syncFile(s.deps, "notes/a.md");
  assert.equal(s.fs.ctl.requests, 1);
  assert.equal(s.fs.text("notes/a.md"), "ok\n");

  const d = await setup();
  await d.save("notes/a.md", "no\n");
  d.fs.ctl.perm.readwrite = "prompt";
  d.fs.ctl.request = "denied";
  await assert.rejects(() => syncFile(d.deps, "notes/a.md"), /Folder write permission denied; nothing was written\. Your copy is kept in Carbon/);
  assert.equal(d.fs.text("notes/a.md"), "# A\n");
  assert.equal(d.fs.ctl.writes.length, 0);
  assert.equal(d.state.stack.text("notes/a.md"), "no\n");
  assert.equal(d.state.link.status, "permission");
  assert.equal(linkedStatus(d.state, "notes/a.md").kind, "permission");
  await assert.rejects(() => syncFile(d.deps, "notes/a.md"), /Reconnect folder/);
  // Editing goes on meanwhile.
  await d.save("notes/a.md", "still editing\n");
  assert.equal(d.st("notes/a.md"), "modified");
  d.fs.ctl.request = "granted";
  assert.equal(await reconnectLink(d.deps), "linked");
  assert.match(d.notices.at(-1).m, /Nothing was read or written/);
  assert.deepEqual(d.notices.at(-1).actions.map((a) => a.label), ["Refresh from folder"]);
  await syncFile(d.deps, "notes/a.md");
  assert.equal(d.fs.text("notes/a.md"), "still editing\n");
});

test("first-sync consent: cancel modifies nothing and asks no permission; accept records consent (and remembers when asked)", async () => {
  const s = await setup({ consent: { granted: false, remember: false, history: true }, answer: null });
  await s.save("notes/a.md", "x\n");
  assert.deepEqual(await syncFile(s.deps, "notes/a.md"), { ok: false, reason: "cancelled" });
  assert.deepEqual(s.modals, ["Sync to the original folder?"]);
  assert.equal(s.fs.ctl.queries + s.fs.ctl.requests, 0);
  assert.equal(writeAttempts(s.fs), 0);
  assert.equal(s.state.link.consent.granted, false);
  assert.equal(s.state.stack.text("notes/a.md"), "x\n");

  const a = await setup({ consent: { granted: false, remember: false, history: true }, answer: { history: false, remember: true } });
  await a.save("notes/a.md", "y\n");
  await syncFile(a.deps, "notes/a.md");
  assert.deepEqual(a.state.link.consent, { granted: true, remember: true, history: false });
  assert.deepEqual(a.remembered, [{ granted: true, remember: true, history: false }]);
  assert.equal(a.preserved.length, 0); // history declined: no diskHistory call
  assert.equal(a.fs.text("notes/a.md"), "y\n");
  await a.save("notes/a.md", "z\n");
  await syncFile(a.deps, "notes/a.md");
  assert.equal(a.modals.length, 1, "consent given: the dialog is not shown again");
});

test("remembered consent still queries browser permission on every sync", async () => {
  const s = await setup();
  await s.save("notes/a.md", "1\n");
  await syncFile(s.deps, "notes/a.md");
  await s.save("notes/a.md", "2\n");
  await syncFile(s.deps, "notes/a.md");
  assert.equal(s.fs.ctl.queries >= 2, true);
  assert.equal(s.modals.length, 0);
  assert.deepEqual(s.preserved.map(([, t]) => t), ["# A\n", "1\n"], "the second sync backs up the verified first write: no false conflict");
});

test("a failing backup stops the sync: the file is unchanged, an explicit no-history option is offered", async () => {
  const s = await setup({ history: "throw" });
  await s.save("notes/a.md", "new\n");
  await assert.rejects(
    () => syncFile(s.deps, "notes/a.md"),
    (e) => /Sync stopped: the backup could not be written \(disk full\)\. The original file is unchanged\./.test(e.message) && e.actions[0].label === "Sync without history…",
  );
  assert.equal(s.fs.text("notes/a.md"), "# A\n");
  assert.equal(s.fs.ctl.writes.length, 0);
  assert.equal(s.state.stack.text("notes/a.md"), "new\n");
  assert.equal(linkedStatus(s.state, "notes/a.md").kind, "syncFailed");
  const err = await syncFile(s.deps, "notes/a.md").catch((e) => e);
  await err.actions[0].onClick();
  assert.equal(s.fs.text("notes/a.md"), "new\n");
  assert.match(s.notices.at(-1).m, /Synced without history\./);
  assert.equal(s.st("notes/a.md"), "synced");
});

test("history enabled but unavailable stops the sync; history disabled never calls the history module", async () => {
  const s = await setup({ history: null });
  await s.save("notes/a.md", "new\n");
  await assert.rejects(() => syncFile(s.deps, "notes/a.md"), /Sync stopped: the backup could not be written \(local history is not available in this build\)/);
  assert.equal(s.fs.text("notes/a.md"), "# A\n");
  const off = await setup({ consent: { granted: true, remember: false, history: false }, history: null });
  await off.save("notes/a.md", "new\n");
  await syncFile(off.deps, "notes/a.md");
  assert.equal(off.fs.text("notes/a.md"), "new\n");
  assert.match(off.notices.at(-1).m, /^Synced Research\/notes\/a\.md \(written and read back\)\.$/);
});

test("a write error aborts the writable and leaves the original intact; close errors and verification mismatches are failures, not syncs", async () => {
  const s = await setup();
  await s.save("notes/a.md", "new\n");
  s.fs.ctl.failWrite = new Error("quota exceeded");
  await assert.rejects(() => syncFile(s.deps, "notes/a.md"), /Sync failed: the folder could not be written \(quota exceeded\)\. The original file is unchanged\./);
  assert.equal(s.fs.ctl.aborts, 1);
  assert.equal(s.fs.text("notes/a.md"), "# A\n");
  assert.equal(s.state.stack.text("notes/a.md"), "new\n");
  assert.equal(s.state.link.lastSync, null);
  assert.equal(s.st("notes/a.md"), "modified", "the baseline still names the folder's old bytes");
  s.fs.ctl.failWrite = null;
  s.fs.ctl.failClose = new Error("device gone");
  await assert.rejects(() => syncFile(s.deps, "notes/a.md"), /device gone/);
  assert.equal(s.fs.ctl.aborts, 2);
  assert.equal(s.fs.text("notes/a.md"), "# A\n");
  s.fs.ctl.failClose = null;
  s.fs.ctl.corruptOnClose = true;
  await assert.rejects(() => syncFile(s.deps, "notes/a.md"), /Sync could not be verified/);
  assert.equal(s.state.link.lastSync, null);
  assert.equal(linkedStatus(s.state, "notes/a.md").kind, "syncFailed");
  assert.equal(s.notices.some((n) => /^Synced/.test(n.m)), false);
  // The corrupted bytes are now on disk: the next Refresh shows the conflict rather than hiding it.
  s.fs.ctl.corruptOnClose = false;
  await refreshFolder(s.deps);
  assert.equal(s.st("notes/a.md"), "conflict");
});

test("a file that changes while the backup is being made is refused: nothing is written", async () => {
  const s = await setup();
  await s.save("notes/a.md", "# mine\n");
  s.deps.diskHistory = async () => ({
    preserve: async (p, b) => {
      s.preserved.push([p, decode(b)]);
      s.fs.put("notes/a.md", "# changed during backup\n");
      return { id: "h1" };
    },
  });
  const r = await syncFile(s.deps, "notes/a.md");
  assert.deepEqual(r, { ok: false, reason: "conflict" });
  assert.equal(s.fs.text("notes/a.md"), "# changed during backup\n");
  assert.equal(s.fs.ctl.writes.length, 0);
  assert.equal(s.state.stack.text("notes/a.md"), "# mine\n");
  assert.equal(s.state.link.lastSync, null);
  assert.match(s.notices.at(-1).m, /changed outside Carbon while the sync was being prepared/);
  assert.equal(s.notices.some((n) => /^Synced/.test(n.m)), false);

  const removed = await setup();
  await removed.save("notes/a.md", "# mine\n");
  removed.deps.diskHistory = async () => ({ preserve: async () => { removed.fs.remove("notes/a.md"); return { id: "h" }; } });
  const r2 = await syncFile(removed.deps, "notes/a.md");
  assert.equal(r2.reason, "conflict");
  assert.equal(removed.fs.has("notes/a.md"), false);
  assert.match(removed.notices.at(-1).m, /removed or renamed outside Carbon while the sync was being prepared/);
});

test("another tab's newer revision is detected before the disk is touched: the stale window writes nothing", async () => {
  const s = await setup();
  await s.save("notes/a.md", "stale\n");
  s.deps.checkRevision = async () => { throw Object.assign(new Error("This workspace changed in another Carbon tab"), { code: "VFS_CONFLICT" }); };
  const reads = s.fs.ctl.reads;
  await assert.rejects(() => syncFile(s.deps, "notes/a.md"), /another Carbon tab/);
  assert.equal(s.fs.ctl.reads, reads, "the folder was not even read");
  assert.equal(writeAttempts(s.fs), 0);
  assert.equal(s.fs.text("notes/a.md"), "# A\n");
  assert.equal(linkedStatus(s.state, "notes/a.md").kind, "syncFailed");
});

test("export of a linked workspace is Carbon's copy byte for byte: virtual edits and deletions, no shadows, no observed disk bytes", async () => {
  const bin = new Uint8Array([0, 255, 13, 10, 13, 0x80]);
  const s = await setup({ files: { ...FILES, "img/raw.bin": bin, "crlf.txt": "\ufeffa\r\nb\rc\n" } });
  await s.save("notes/a.md", "# A edited\n");
  await s.deps.commit({ stack: s.state.stack.change({ deletes: ["b.md"] }) });
  s.fs.put("data.csv", "changed on disk\n");
  s.fs.put("incoming.md", "# only on disk\n");
  await refreshFolder(s.deps);
  assert.equal(s.st("b.md"), "deletedInCarbon");
  const tar = readTarFiles(archiveWorkspace(s.state.stack));
  const files = new Map(tar.files);
  assert.deepEqual([...files.keys()].sort(), [...s.state.stack.files.keys()].sort());
  for (const [p, bytes] of s.state.stack.files) assert.deepEqual(files.get(p), bytes, p);
  assert.deepEqual(files.get("img/raw.bin"), bin);
  assert.deepEqual(files.get("crlf.txt"), encode("\ufeffa\r\nb\rc\n"));
  assert.equal(files.get("data.csv") && decode(files.get("data.csv")), "x,y\n", "Carbon's copy, not the observed disk version");
  assert.equal(files.has("b.md") || files.has("incoming.md"), false, "no shadow and no incoming file is exported");
  assert.equal(writeAttempts(s.fs), 0);
});

test("Sync refuses a new file whose name differs from a folder entry only by case (case-sensitive folders), at any depth", async () => {
  const s = await setup({ files: { "Notes.txt": "one\n", "docs/a.md": "# a\n" } });
  // Renamed in Carbon by case only; the folder (case-sensitive here) still has Notes.txt.
  await s.deps.commit({ stack: s.state.stack.change({ moves: [["Notes.txt", "notes.txt"]] }) });
  assert.equal(s.st("notes.txt"), "virtual");
  const r = await syncFile(s.deps, "notes.txt");
  assert.deepEqual(r, { ok: false, reason: "conflict" });
  assert.match(s.notices.at(-1).m, /already has Notes\.txt, which differs from notes\.txt only by case.*nothing was written/);
  // A new file under a directory whose name differs only by case.
  // The folder gained docs/ outside Carbon (not refreshed); Carbon has its own Docs/b.md.
  const t = await setup({ files: { "x.md": "# x\n" } });
  t.fs.put("docs/a.md", "# a\n");
  await t.deps.commit({ stack: t.state.stack.change({ writes: new Map([["Docs/b.md", encode("# b\n")]]) }) });
  assert.equal((await syncFile(t.deps, "Docs/b.md")).reason, "conflict");
  assert.match(t.notices.at(-1).m, /already has docs, which differs from Docs\/b\.md only by case/);
  assert.equal(t.fs.has("Docs/b.md"), false);
  assert.equal(writeAttempts(s.fs) + writeAttempts(t.fs), 0);
  assert.equal(s.fs.has("notes.txt"), false);
  assert.equal(s.fs.text("Notes.txt"), "one\n");
  // An exact-case new file is still created.
  await t.deps.commit({ stack: t.state.stack.change({ writes: new Map([["new.md", encode("# new\n")]]) }) });
  assert.equal((await syncFile(t.deps, "new.md")).ok, true);
  assert.equal(t.fs.text("new.md"), "# new\n");
});

test("on a case-insensitive folder a rename by case only is refused, also when the bytes are unchanged (no write)", async () => {
  const fs = fakeFolder({ "Notes.txt": "one\n" }, { name: "Mac", caseInsensitive: true });
  const read = await readDirectoryFiles(fs.root);
  const state = createState();
  state.stack = new LocalFolder(read.files, read.directories, { title: "Mac" });
  state.link = { ...newLink(fs.root, null, state.stack, read), consent: { granted: true, remember: false, history: true } };
  const notices = [];
  const deps = {
    state,
    commit: (candidate) => {
      if (candidate?.stack && candidate.stack !== state.stack && !("link" in candidate))
        candidate = { ...candidate, link: { ...state.link, baseline: trackBaseline(state.link.baseline, state.stack, candidate.stack) } };
      return commit(state, null, candidate);
    },
    notify: (m) => notices.push(m), modal: async () => null, render: () => {},
    diskHistory: async () => ({ preserve: async () => ({ id: "h" }) }),
  };
  assert.deepEqual((await readDisk(fs.root, "notes.txt")).bytes, encode("one\n"), "the fake resolves the other spelling, as the OS would");
  await deps.commit({ stack: state.stack.change({ moves: [["Notes.txt", "notes.txt"]] }) });
  const r = await syncFile(deps, "notes.txt");
  assert.deepEqual(r, { ok: false, reason: "conflict" });
  assert.match(notices.at(-1), /already has Notes\.txt, which differs from notes\.txt only by case/);
  assert.equal(sourceState(state.link, state.stack, "notes.txt"), "virtual", "not recorded as synced");
  // With changed bytes too: nothing is written under either spelling.
  await deps.commit({ stack: state.stack.change({ writes: new Map([["notes.txt", encode("two\n")]]) }) });
  assert.equal((await syncFile(deps, "notes.txt")).reason, "conflict");
  assert.equal(fs.text("Notes.txt"), "one\n");
  assert.equal(fs.ctl.writes.length, 0);
});

test("a .CARBON-HISTORY alias on a case-insensitive folder is never written: Sync with history refuses (owner gate P1)", async () => {
  const fs = fakeFolder({ "notes.md": "old\n", ".CARBON-HISTORY/README.txt": "someone else's\n" }, { name: "Mac", caseInsensitive: true });
  const read = await readDirectoryFiles(fs.root);
  const state = createState();
  state.stack = new LocalFolder(read.files, read.directories, { title: "Mac" });
  state.link = { ...newLink(fs.root, null, state.stack, read), consent: { granted: true, remember: false, history: true } };
  const deps = {
    state,
    commit: (candidate) => {
      if (candidate?.stack && candidate.stack !== state.stack && !("link" in candidate))
        candidate = { ...candidate, link: { ...state.link, baseline: trackBaseline(state.link.baseline, state.stack, candidate.stack) } };
      return commit(state, null, candidate);
    },
    notify: () => {}, modal: async () => null, render: () => {},
    diskHistory: (h) => openDiskHistory(h),
  };
  await deps.commit({ stack: state.stack.change({ writes: new Map([["notes.md", encode("mine\n")]]) }) });
  await assert.rejects(() => syncFile(deps, "notes.md"), /backup could not be written.*"\.CARBON-HISTORY", which differs from \.carbon-history only by case.*wrote nothing.*The original file is unchanged/);
  assert.equal(fs.text(".CARBON-HISTORY/README.txt"), "someone else's\n");
  assert.equal(fs.text("notes.md"), "old\n");
  assert.equal(writeAttempts(fs), 0);
});

test("the history alias check uses the same case fold as the path rules: .carbon-hiſtory (long s) with a valid manifest is refused", async () => {
  const manifest = JSON.stringify({ format: "carbon-history/1", created: "2026-01-01T00:00:00.000Z", retention: { days: 30, maxBytes: 1024 } });
  const fs = fakeFolder({ "notes.md": "old\n", ".carbon-hi\u017Ftory/carbon-history.json": manifest }, { name: "NTFS", caseInsensitive: true });
  await assert.rejects(() => openDiskHistory(fs.root), /differs from \.carbon-history only by case/);
  assert.equal(fs.ctl.creates + fs.ctl.writes.length, 0);
  assert.equal(fs.text(".carbon-hi\u017Ftory/carbon-history.json"), manifest);
});

test("Sync of a new file keeps the folder, as Carbon knows it, within the folder limits (files deleted only in Carbon count)", async () => {
  const big = () => new Uint8Array(LIMITS.file).fill(0x61);
  const s = await setup({ files: { "a.bin": big(), "b.bin": big(), "c.bin": big() } });
  await s.deps.commit({ stack: s.state.stack.change({ deletes: ["a.bin", "b.bin", "c.bin"], writes: new Map([["n1.bin", big()]]) }) });
  assert.equal(s.st("a.bin"), "deletedInCarbon");
  assert.equal((await syncFile(s.deps, "n1.bin")).ok, true, "24 MiB kept + 8 MiB new is exactly the limit");
  await s.deps.commit({ stack: s.state.stack.change({ writes: new Map([["n2.txt", encode("x")]]) }) });
  const writes = s.fs.ctl.writes.length;
  await assert.rejects(() => syncFile(s.deps, "n2.txt"), /past Carbon's folder limits.*Nothing was written\. Forget deleted files/);
  assert.equal(s.fs.ctl.writes.length, writes);
  assert.equal(s.fs.has("n2.txt"), false);
  // A file already in the baseline that grows past what is left is refused too (Copilot review round 2).
  const g = await setup({ files: { "a.bin": big(), "b.bin": big(), "c.bin": big(), "d.txt": "small", "e.txt": "other" } });
  await g.deps.commit({ stack: g.state.stack.change({ deletes: ["a.bin", "b.bin", "c.bin"], writes: new Map([["d.txt", big()]]) }) });
  await assert.rejects(() => syncFile(g.deps, "d.txt"), /past Carbon's folder limits/);
  assert.equal(g.fs.text("d.txt"), "small");
  assert.equal(writeAttempts(g.fs), 0);
  // Forget alone does not make room while the folder still holds the file (it is still on disk); once it is
  // gone from the folder (Refresh) and forgotten in Carbon, it is.
  s.state.link = forgetDeleted(s.state.link, s.state.stack, "a.bin").link;
  await assert.rejects(() => syncFile(s.deps, "n2.txt"), /past Carbon's folder limits/);
  s.fs.remove("a.bin");
  await refreshFolder(s.deps);
  assert.equal((await syncFile(s.deps, "n2.txt")).ok, true);
});

test("the folder-limit check counts directories as the folder reader does, and the parents a Sync creates", async () => {
  // 1,998 empty directories + a.txt = 1,999 entries. Renaming a.txt to b.txt in Carbon keeps a.txt in the
  // baseline (deleted in Carbon, still on disk): syncing b.txt makes 2,000 entries, the limit.
  const fs = fakeFolder({ "a.txt": "a" }, { name: "Dirs" });
  for (let i = 0; i < 1998; i++) await fs.root.getDirectoryHandle(`d${i}`, { create: true });
  fs.ctl.creates = 0;
  const read = await readDirectoryFiles(fs.root);
  const state = createState();
  state.stack = new LocalFolder(read.files, read.directories, { title: "Dirs" });
  state.link = { ...newLink(fs.root, null, state.stack, read), consent: { granted: true, remember: false, history: false } };
  const deps = {
    state,
    commit: (candidate) => {
      if (candidate?.stack && candidate.stack !== state.stack && !("link" in candidate))
        candidate = { ...candidate, link: { ...state.link, baseline: trackBaseline(state.link.baseline, state.stack, candidate.stack) } };
      return commit(state, null, candidate);
    },
    notify: () => {}, modal: async () => null, render: () => {},
  };
  await deps.commit({ stack: state.stack.change({ moves: [["a.txt", "b.txt"]] }) });
  assert.equal((await syncFile(deps, "b.txt")).ok, true, "exactly 2,000 entries");
  await readDirectoryFiles(fs.root); // still readable
  // One more file is refused, and so is a new file whose new parent directory would be the 2,001st entry.
  await deps.commit({ stack: state.stack.change({ writes: new Map([["c.txt", encode("c")]]) }) });
  await assert.rejects(() => syncFile(deps, "c.txt"), /2000 files and folders.*Nothing was written/);
  assert.equal(fs.has("c.txt"), false);
});

test("Import refuses when the baseline records (files deleted only in Carbon included) would pass the folder limits", async () => {
  const names = Array.from({ length: LIMITS.files }, (_, i) => `f${i}.txt`);
  const s = await setup({ files: Object.fromEntries(names.map((p) => [p, "x"])) });
  await s.deps.commit({ stack: s.state.stack.change({ deletes: names }) });
  // Outside Carbon the 2,000 files are replaced by one new file; Refresh sees it as incoming.
  for (const p of names) s.fs.remove(p);
  s.fs.put("new.txt", "new\n");
  await refreshFolder(s.deps);
  assert.equal(s.st("new.txt"), "incoming");
  const stack = s.state.stack;
  assert.throws(() => importIncoming(s.state.link, s.state.stack, ["new.txt"]), /Importing new\.txt would take the folder.*past Carbon's folder limits.*Nothing was imported\. Forget deleted files/);
  assert.equal(s.state.stack, stack);
  // Forgetting one deleted file makes room.
  s.state.link = forgetDeleted(s.state.link, s.state.stack, "f0.txt").link;
  const { stack: next } = importIncoming(s.state.link, s.state.stack, ["new.txt"]);
  assert.equal(next.text("new.txt"), "new\n");
});

test("the workspace summary never says every file matches while the folder holds differences", async () => {
  const s = await setup();
  assert.match(linkedStatus(s.state, null).tooltip, /Every file matches Research/);
  s.fs.put("b.md", "# B elsewhere\n");
  s.fs.put("extra.md", "new\n");
  await refreshFolder(s.deps);
  const info = linkedStatus(s.state, null);
  assert.doesNotMatch(info.tooltip, /Every file matches/);
  assert.match(info.tooltip, /^No edits in Carbon waiting to sync\. 2 folder changes to look at \(Folder changes…\)\./);
  assert.equal(info.glyph, "●");
});

test("the stored revision is probed again right before the write: another tab committing during the backup writes nothing", async () => {
  const s = await setup();
  await s.save("notes/a.md", "mine\n");
  let probes = 0;
  s.deps.checkRevision = async () => {
    if (++probes === 2) throw Object.assign(new Error("This workspace changed in another Carbon tab"), { code: "VFS_CONFLICT" });
  };
  await assert.rejects(() => syncFile(s.deps, "notes/a.md"), /another Carbon tab/);
  assert.equal(probes, 2);
  assert.equal(s.preserved.length, 1, "the backup was made before the second probe (an extra copy only)");
  assert.equal(s.fs.ctl.writes.length, 0);
  assert.equal(s.fs.text("notes/a.md"), "# A\n");
  assert.equal(s.st("notes/a.md"), "modified");
});

test("a folder change while the last revision probe is pending is seen: the final re-read comes after it, nothing is overwritten", async () => {
  const s = await setup();
  await s.save("notes/a.md", "mine\n");
  let probes = 0;
  s.deps.checkRevision = async () => {
    if (++probes === 2) s.fs.put("notes/a.md", "# saved by another editor during the probe\n");
  };
  const r = await syncFile(s.deps, "notes/a.md");
  assert.equal(probes, 2);
  assert.deepEqual(r, { ok: false, reason: "conflict" });
  assert.equal(s.fs.text("notes/a.md"), "# saved by another editor during the probe\n");
  assert.equal(s.fs.ctl.writes.length, 0);
  assert.match(s.notices.at(-1).m, /changed outside Carbon while the sync was being prepared/);
});

test("a case-variant name appearing during the last revision probe is refused before the write (case-sensitive folder)", async () => {
  const s = await setup();
  await s.deps.commit({ stack: s.state.stack.change({ writes: new Map([["Notes.txt", encode("mine\n")]]) }) });
  let probes = 0;
  s.deps.checkRevision = async () => {
    if (++probes === 2) s.fs.put("notes.txt", "another editor\n");
  };
  const r = await syncFile(s.deps, "Notes.txt");
  assert.equal(probes, 2);
  assert.deepEqual(r, { ok: false, reason: "conflict" });
  assert.match(s.notices.at(-1).m, /already has notes\.txt, which differs from Notes\.txt only by case/);
  assert.equal(s.fs.has("Notes.txt"), false);
  assert.equal(s.fs.text("notes.txt"), "another editor\n");
  assert.equal(s.fs.ctl.writes.length, 0);
});

test("a write by another program after Sync's last read is caught before close(): the writable is aborted, nothing is overwritten", async () => {
  const s = await setup();
  await s.save("notes/a.md", "mine\n");
  let creates = null;
  s.deps.checkRevision = async () => { creates = s.fs.ctl.creates; }; // the last await before the write
  let done = false;
  s.fs.ctl.beforeGetFile = (p) => {
    // After createWritable (a create) the next read of the target is writeDisk's pre-close check.
    if (p === "notes/a.md" && creates !== null && s.fs.ctl.creates > creates && !done) {
      done = true;
      // Another program saves the same file in place (the node this read is about to return).
      const node = s.fs.at("notes/a.md").node;
      node.bytes = encode("# another editor saved just now\n");
      node.modified += 1;
    }
  };
  const r = await syncFile(s.deps, "notes/a.md");
  assert.ok(done, "the external write happened after Sync's final read");
  assert.deepEqual(r, { ok: false, reason: "conflict" });
  assert.equal(s.fs.text("notes/a.md"), "# another editor saved just now\n", "the external version survives");
  assert.equal(s.fs.ctl.writes.length, 0, "nothing was committed");
  assert.ok(s.fs.ctl.aborts >= 1, "the writable was aborted");
  assert.match(s.notices.at(-1).m, /changed outside Carbon while it was being written.*Nothing was overwritten/);
  assert.equal(s.st("notes/a.md"), "modified");
  // A new file (absent before) still syncs: the just-created target reads empty before close().
  await s.deps.commit({ stack: s.state.stack.change({ writes: new Map([["fresh.md", encode("# fresh\n")]]) }) });
  s.fs.ctl.beforeGetFile = null;
  assert.equal((await syncFile(s.deps, "fresh.md")).ok, true);
  assert.equal(s.fs.text("fresh.md"), "# fresh\n");
});

test("a failed write of a new file leaves no empty file behind, so the retry syncs (integration review P3)", async () => {
  const s = await setup();
  await s.deps.commit({ stack: s.state.stack.change({ writes: new Map([["sub/n.md", encode("# new\n")]]) }) });
  s.fs.ctl.failWrite = Object.assign(new Error("disk error"), { name: "InvalidStateError" });
  await assert.rejects(() => syncFile(s.deps, "sub/n.md"), /Sync failed: the folder could not be written \(disk error\)\. Nothing was left in the folder at that path\./);
  assert.equal(s.fs.has("sub/n.md"), false, "the empty file getFileHandle(create) made is removed");
  s.fs.ctl.failWrite = null;
  assert.equal((await syncFile(s.deps, "sub/n.md")).ok, true, "the retry is not refused as 'already exists'");
  assert.equal(s.fs.text("sub/n.md"), "# new\n");
  // Another program's non-empty file at that path is never removed.
  await s.deps.commit({ stack: s.state.stack.change({ writes: new Map([["other.md", encode("# mine\n")]]) }) });
  s.fs.ctl.failWrite = new Error("disk error");
  let creates = null;
  s.deps.checkRevision = async () => { creates = s.fs.ctl.creates; };
  s.fs.ctl.beforeGetFile = (p) => {
    if (p === "other.md" && creates !== null && s.fs.ctl.creates > creates) s.fs.at("other.md").node.bytes = encode("theirs\n");
  };
  await assert.rejects(() => syncFile(s.deps, "other.md"), /may now exist in the folder as an empty or partial file/);
  assert.equal(s.fs.text("other.md"), "theirs\n");
  // A directory now at that path is not "nothing left": the cautious wording is used.
  s.fs.ctl.beforeGetFile = null;
  await s.deps.commit({ stack: s.state.stack.change({ writes: new Map([["d.md", encode("# d\n")]]) }) });
  s.fs.ctl.failWrite = null;
  s.fs.mkdir("d.md");
  await assert.rejects(() => syncFile(s.deps, "d.md"), /may now exist in the folder as an empty or partial file/);
});

test("a Save, Delete or move in this window while the Sync awaits the folder is not recorded as synced", async () => {
  for (const change of ["save", "delete", "move"]) {
    const s = await setup();
    await s.save("notes/a.md", "synced bytes\n");
    s.deps.checkRevision = async () => {
      // Runs once Sync has captured the bytes to write and is awaiting the folder (step 3).
      if (s.changed) return;
      s.changed = true;
      if (change === "save") await s.save("notes/a.md", "newer, not synced\n");
      else {
        const next = s.state.stack.change(change === "delete" ? { deletes: ["notes/a.md"] } : { moves: [["notes/a.md", "notes/moved.md"]] });
        await s.deps.commit({ stack: next });
      }
    };
    const r = await syncFile(s.deps, "notes/a.md");
    assert.equal(r.ok, true, change);
    assert.equal(s.fs.text("notes/a.md"), "synced bytes\n", `${change}: the folder holds the bytes Sync captured`);
    assert.deepEqual(baselineBytes(s.state.link, s.state.stack, "notes/a.md"), encode("synced bytes\n"), `${change}: the baseline is what was written`);
    assert.equal(s.st("notes/a.md"), change === "save" ? "modified" : "deletedInCarbon", change);
    if (change === "save") assert.equal(s.state.stack.text("notes/a.md"), "newer, not synced\n");
    if (change === "move") assert.equal(s.st("notes/moved.md"), "virtual");
    assert.match(s.notices.at(-1).m, /^Synced Research\/notes\/a\.md \(written and read back\)\..* Carbon's copy of notes\/a\.md changed while it was syncing; that newer version is not in the folder yet\.$/, change);
  }
});

test("take folder version refuses when Carbon's copy or the folder record changed while the folder was being read", async () => {
  const s = await setup();
  s.fs.put("notes/a.md", "# theirs\n");
  await refreshFolder(s.deps);
  s.fs.ctl.beforeGetFile = (p) => {
    if (p !== "notes/a.md" || s.saved) return;
    s.saved = true;
    // A Save of another file in this window lands between the permission check and the read.
    s.state.stack = s.state.stack.change({ writes: new Map([["b.md", encode("# B newer\n")]]) });
  };
  const stack = () => s.state.stack;
  await assert.rejects(() => takeDiskVersion(s.deps, "notes/a.md"), /changed in Carbon while the folder was being read\. Nothing was changed/);
  assert.equal(stack().text("notes/a.md"), "# A\n");
  assert.equal(stack().text("b.md"), "# B newer\n", "the newer save is not overwritten by a stale candidate");
  assert.equal(s.state.history.items.length, 0);
});

test("take folder version of an uncaptured version is bound to confirmed bytes, never to size and time (G2)", async () => {
  // A real capture-budget exhaustion: an 8 MiB file deleted in Carbon keeps an 8 MiB shadow, so the next
  // Refresh cannot capture the changed notes/a.md.
  const s = await setup({ files: { ...FILES, "big.bin": new Uint8Array(LIMITS.file).fill(0x61) } });
  await s.deps.commit({ stack: s.state.stack.change({ deletes: ["big.bin"] }) });
  s.fs.put("notes/a.md", "# version A, seen\n");
  await refreshFolder(s.deps);
  const seen = s.state.link.observed.entries.get("notes/a.md");
  assert.equal(seen.captured, false, "over the capture budget");
  assert.equal(seen.bytes, undefined);
  // Replaced outside Carbon by different bytes of the same length, keeping the modified time.
  s.fs.ctl.modified = seen.modified;
  s.fs.put("notes/a.md", "# version B, new!\n");
  assert.equal(s.fs.bytes("notes/a.md").length, seen.size);
  const stack = s.state.stack, baseline = s.state.link.baseline;
  await assert.rejects(() => takeDiskVersion(s.deps, "notes/a.md"), /did not keep the folder's version of notes\/a\.md.*cannot confirm.*Nothing was changed/);
  // A confirmation bound to version A refuses version B.
  await assert.rejects(() => takeDiskVersion(s.deps, "notes/a.md", { expected: encode("# version A, seen\n") }), /changed in the folder since you confirmed it/);
  assert.equal(s.state.stack, stack, "no revision");
  assert.equal(s.state.link.baseline, baseline, "no re-baseline");
  assert.equal(s.state.history.items.length, 0);
  // The preview reads the current version; confirming exactly those bytes takes them.
  const preview = await readFolderVersion(s.deps, "notes/a.md");
  assert.deepEqual(preview, encode("# version B, new!\n"));
  await takeDiskVersion(s.deps, "notes/a.md", { expected: preview });
  assert.equal(s.state.stack.text("notes/a.md"), "# version B, new!\n");
  assert.equal(s.st("notes/a.md"), "synced");
  assert.equal(writeAttempts(s.fs), 0);
});

test("when the verified write succeeds but the store write fails, the window adopts the baseline and says both things", async () => {
  const s = await setup();
  await s.save("notes/a.md", "new\n");
  let disabled = 0;
  const real = s.deps.commit;
  s.deps.commit = async () => { throw new Error("IDB broken"); };
  s.deps.disableCache = () => disabled++;
  const r = await syncFile(s.deps, "notes/a.md");
  assert.equal(r.ok, true);
  assert.equal(disabled, 1);
  assert.equal(s.fs.text("notes/a.md"), "new\n");
  assert.equal(s.st("notes/a.md"), "synced", "in memory the baseline is the verified disk");
  assert.equal(s.notices.at(-1).kind, "error");
  assert.match(s.notices.at(-1).m, /^Synced Research\/notes\/a\.md \(written and read back\)\..*Browser storage did not record the sync \(IDB broken\)/);
  s.deps.commit = real;
});

for (const kind of ["quota", "conflict"]) test(`a ${kind} in the store after a verified write keeps the store on, adopts the baseline, offers recovery; a reload reads 'matched', never a conflict`, async () => {
  const s = await setup();
  await s.save("notes/a.md", "on disk\n");
  const stored = serialize(s.state); // what the store still holds after the failed commit
  let disabled = 0;
  const recover = { label: "Download recovery copy", onClick: () => {} };
  const real = s.deps.commit;
  s.deps.commit = async () => {
    throw Object.assign(new Error(kind === "quota" ? "Injected quota" : "changed in another Carbon tab"),
      kind === "quota" ? { name: "QuotaExceededError", actions: [recover] } : { code: "VFS_CONFLICT", actions: [recover] });
  };
  s.deps.disableCache = () => disabled++;
  const r = await syncFile(s.deps, "notes/a.md");
  assert.equal(r.ok, true);
  assert.equal(s.fs.text("notes/a.md"), "on disk\n", "the folder holds the verified bytes");
  assert.equal(disabled, 0, "a recoverable store failure never disables storage for every workspace");
  assert.equal(s.st("notes/a.md"), "synced");
  const notice = s.notices.at(-1);
  assert.equal(notice.kind, "error");
  assert.match(notice.m, /^Synced Research\/notes\/a\.md \(written and read back\)\./);
  assert.match(notice.m, kind === "quota" ? /did not record the sync: it is full/ : /did not record the sync: this workspace changed in another Carbon tab/);
  assert.deepEqual(notice.actions, [recover]);
  // A later sync from this window writes only what changed.
  s.deps.commit = real;
  await s.save("notes/a.md", "second\n");
  const again = await syncFile(s.deps, "notes/a.md");
  assert.equal(again.ok, true);
  assert.equal(s.fs.text("notes/a.md"), "second\n");
  assert.deepEqual(s.preserved.map(([, t]) => t), ["# A\n", "on disk\n"]);
  // A reload of the stored record (old baseline) against the disk written meanwhile: no false conflict, no blind write.
  const reloaded = restore(stored);
  reloaded.link.handle = s.fs.root;
  s.fs.put("notes/a.md", "on disk\n");
  const deps2 = { ...s.deps, state: reloaded, commit: (c) => commit(reloaded, null, c), checkRevision: undefined };
  reloaded.link.status = "linked";
  await refreshFolder(deps2);
  assert.equal(sourceState(reloaded.link, reloaded.stack, "notes/a.md"), "matched");
  const r3 = await syncFile(deps2, "notes/a.md");
  assert.equal(r3.written, false);
  assert.equal(sourceState(reloaded.link, reloaded.stack, "notes/a.md"), "synced");
});

test("a disk file larger than the file limit is refused without being read, for sync and take", async () => {
  const s = await setup();
  await s.save("notes/a.md", "mine\n");
  s.fs.put("notes/a.md", new Uint8Array(LIMITS.file + 1).fill(97));
  let read = 0;
  s.fs.ctl.beforeGetFile = () => read++;
  await assert.rejects(() => syncFile(s.deps, "notes/a.md"), /larger than Carbon's 8 MiB file limit/);
  await assert.rejects(() => takeDiskVersion(s.deps, "notes/a.md"), /larger than Carbon's 8 MiB file limit/);
  await assert.rejects(() => refreshFolder(s.deps), /Could not read the folder/);
  assert.equal(s.fs.ctl.writes.length, 0);
  assert.equal(s.state.stack.text("notes/a.md"), "mine\n");
});

test("a failed render cannot leave the sync stuck in 'saving'; a sync in progress refuses a second one", async () => {
  const s = await setup();
  await s.save("notes/a.md", "x\n");
  let n = 0;
  s.deps.render = () => { if (++n === 1) throw new Error("render exploded"); };
  await assert.rejects(() => syncFile(s.deps, "notes/a.md"), /render exploded/);
  assert.notEqual(s.state.link.op?.kind, "saving");
  assert.equal(s.fs.ctl.writes.length, 0);
  s.deps.render = () => {};
  await syncFile(s.deps, "notes/a.md");
  assert.equal(s.fs.text("notes/a.md"), "x\n");
  s.state.link.op = { kind: "saving", path: "b.md" };
  await assert.rejects(() => syncFile(s.deps, "notes/a.md"), /already in progress/);
  await assert.rejects(() => refreshFolder(s.deps), /already in progress/);
});

test("the permission errors carry a Reconnect action; an unreachable handle is reported as unavailable", async () => {
  const d = await setup();
  await d.save("notes/a.md", "no\n");
  d.fs.ctl.perm.readwrite = "prompt";
  d.fs.ctl.request = "denied";
  const denied = await syncFile(d.deps, "notes/a.md").catch((e) => e);
  assert.equal(denied.actions[0].label, "Reconnect folder…");
  const blocked = await syncFile(d.deps, "notes/a.md").catch((e) => e);
  assert.equal(blocked.actions[0].label, "Reconnect folder…");
  d.fs.ctl.request = "granted";
  await blocked.actions[0].onClick();
  assert.equal(d.state.link.status, "linked");
  d.state.link.status = "unavailable";
  const gone = await syncFile(d.deps, "notes/a.md").catch((e) => e);
  assert.equal(gone.actions[0].label, "Reconnect folder…");
  for (const [perm, status] of [["granted", "linked"], ["prompt", "permission"], ["denied", "permission"]]) {
    d.fs.ctl.perm.read = perm;
    await verifyLink(d.state);
    assert.equal(d.state.link.status, status);
  }
  d.state.link.handle = { ...d.fs.root, queryPermission: async () => { throw new Error("handle revoked"); } };
  await verifyLink(d.state);
  assert.equal(d.state.link.status, "unavailable");
  await assert.rejects(() => syncFile(d.deps, "notes/a.md"), /cannot be reached \(handle revoked\)/);
  assert.equal(linkedStatus(d.state, "notes/a.md").label, "Folder unavailable");
  assert.equal(d.st("notes/a.md"), "modified", "editing state is unaffected by access");
});

// ---- Refresh from folder: observation only ---------------------------------------------------------------

const snapshot = (s) => ({
  files: [...s.state.stack.files].map(([p, b]) => [p, b.slice()]),
  dirs: [...s.state.stack.directories],
  drafts: [...s.state.drafts],
  current: s.state.current,
  revision: s.state.stack.manifest.revision,
  history: s.state.history.items.length,
  stack: s.state.stack,
});
const unchanged = (before, s) => {
  const after = snapshot(s);
  assert.equal(after.stack, before.stack, "the workspace object is the same");
  assert.deepEqual(after.files.map(([p]) => p), before.files.map(([p]) => p));
  for (const [i, [p, b]] of before.files.entries()) assert.ok(equal(b, after.files[i][1]), `${p} bytes unchanged`);
  assert.deepEqual(after.dirs, before.dirs);
  assert.deepEqual(after.drafts, before.drafts);
  assert.equal(after.current, before.current);
  assert.equal(after.revision, before.revision);
  assert.equal(after.history, before.history);
};

test("refresh records every kind of difference and changes nothing in Carbon: not a byte, draft, tab, revision or History entry", async () => {
  const s = await setup({ files: { "a.md": "# a\n", "b.md": "# b\n", "c.md": "# c\n", "d.md": "# d\n", "e.md": "# e\n", "data.csv": "x,y\n" } });
  s.state.current = "a.md";
  await s.save("a.md", "# a mine\n");
  await s.save("b.md", "# b mine\n");
  s.state.drafts.set("c.md", "# c draft\n");
  s.fs.put("a.md", "# a theirs\n"); // conflict
  s.fs.put("c.md", "# c theirs\n"); // external change (draft kept)
  s.fs.remove("d.md"); // missing
  s.fs.put("moved.md", "# e\n"); // e.md moved
  s.fs.remove("e.md");
  s.fs.put("new/incoming.txt", "hello"); // incoming in a new folder
  s.fs.mkdir("empty");
  const before = snapshot(s);
  const r = await refreshFolder(s.deps);
  unchanged(before, s);
  assert.deepEqual(s.commits.at(-1), ["link"]);
  assert.deepEqual(r.counts, { conflict: 1, modified: 1, externalChange: 1, missing: 2, incoming: 2, synced: 1 });
  assert.deepEqual(r.foldersAdded, ["new", "empty"]);
  assert.deepEqual(r.foldersMissing, []);
  const rows = Object.fromEntries(sourceRows(s.state.link, s.state.stack).map((row) => [row.path, row]));
  assert.equal(rows["e.md"].moveTo, "moved.md");
  assert.equal(rows["moved.md"].movedFrom, "e.md");
  assert.equal(decode(s.state.link.observed.entries.get("a.md").bytes), "# a theirs\n", "the disk version is captured for Compare");
  assert.equal(s.state.link.observed.entries.get("data.csv").bytes, undefined, "unchanged files are not captured");
  const notice = s.notices.at(-1);
  assert.match(notice.m, /^Read Research: 2 new in folder, 1 changed in folder, 1 changed in folder and in Carbon, 2 missing from folder, 2 folders differ\. Nothing in Carbon was changed; 2 files not synced to the folder\.$/);
  assert.equal(notice.kind, "ok");
  assert.equal(writeAttempts(s.fs), 0);
  // A second refresh with nothing new replaces the observation and still changes nothing.
  await refreshFolder(s.deps);
  unchanged(before, s);
  assert.equal(s.state.link.observed.at, "2026-10-26T10:00:00.000Z");
});

test("refresh with no difference says so; a workspace that changed while the folder was being read is refused", async () => {
  const s = await setup();
  const before = snapshot(s);
  await refreshFolder(s.deps);
  unchanged(before, s);
  assert.match(s.notices.at(-1).m, /^Read Research: no difference from Carbon's copy\. Nothing in Carbon was changed\.$/);
  // An edit saved only in Carbon: the folder still has the old bytes, so the copies do not "match".
  await s.save("b.md", "# B mine\n");
  await refreshFolder(s.deps);
  assert.match(s.notices.at(-1).m, /^Read Research: no folder changes to resolve\. Nothing in Carbon was changed; 1 file not synced to the folder\.$/);
  s.fs.ctl.beforeGetFile = () => { s.state.stack = s.state.stack.change({ writes: new Map([["b.md", encode("race")]]) }); };
  await assert.rejects(() => refreshFolder(s.deps), /changed while the folder was being read; refresh again/);
});

test("refresh needs a connected link: permission problems go through Reconnect and change nothing", async () => {
  const s = await setup();
  s.fs.put("x.md", "new");
  const before = snapshot(s);
  s.state.link.status = "permission";
  const e1 = await refreshFolder(s.deps).catch((e) => e);
  assert.match(e1.message, /Reconnect folder…; Carbon's copy and your drafts are unchanged/);
  assert.equal(e1.actions[0].label, "Reconnect folder…");
  s.state.link.status = "linked";
  s.fs.ctl.perm.read = "prompt";
  s.fs.ctl.request = "denied";
  const e2 = await refreshFolder(s.deps).catch((e) => e);
  assert.match(e2.message, /Folder access was not granted/);
  assert.equal(s.state.link.status, "permission");
  unchanged(before, s);
  assert.equal(s.state.link.observed.entries.has("x.md"), false, "nothing was observed");
  s.state.link.status = "linked";
  s.fs.ctl.perm.read = "granted";
  const handle = s.state.link.handle;
  s.state.link.handle = { ...handle, entries: async function* () { throw Object.assign(new Error("gone"), { name: "NotFoundError" }); } };
  const e3 = await refreshFolder(s.deps).catch((e) => e);
  assert.match(e3.message, /cannot be reached \(gone\)/);
  assert.equal(s.state.link.status, "unavailable");
  unchanged(before, s);
});

test("a store failure during refresh keeps the previous observation", async () => {
  const s = await setup();
  s.fs.put("x.md", "new");
  const observed = s.state.link.observed;
  s.deps.commit = async () => { throw new Error("IDB broken"); };
  await assert.rejects(() => refreshFolder(s.deps), /IDB broken/);
  assert.equal(s.state.link.observed, observed);
});

// ---- Take the folder's version --------------------------------------------------------------------------

test("take disk version adopts the folder's bytes as a new revision with History, re-baselines and keeps a draft", async () => {
  const s = await setup();
  s.fs.put("notes/a.md", "# A changed elsewhere\n");
  await refreshFolder(s.deps);
  assert.equal(s.st("notes/a.md"), "externalChange");
  s.state.drafts.set("notes/a.md", "# draft\n");
  const revision = s.state.stack.manifest.revision;
  await takeDiskVersion(s.deps, "notes/a.md");
  assert.equal(s.state.stack.text("notes/a.md"), "# A changed elsewhere\n");
  assert.equal(s.state.stack.manifest.revision, revision + 1);
  assert.equal(s.state.history.items.at(-1).label, "Before taking notes/a.md from the folder");
  assert.equal(s.state.drafts.get("notes/a.md"), "# draft\n");
  assert.equal(s.st("notes/a.md"), "synced");
  assert.equal(s.state.copyState, "pending", "a changed revision is not in any archive yet");
  assert.equal(s.state.unexported, true);
  assert.match(s.notices.at(-1).m, /Took the folder's version of notes\/a\.md\. The previous version is in History\. Your unsaved draft is still here\./);
  assert.equal(writeAttempts(s.fs), 0);
  // A draft equal to the adopted bytes is cleared; identical bytes make no revision.
  s.state.drafts.set("notes/a.md", "# A changed elsewhere\n");
  s.state.copyState = "requested"; // an export awaiting confirmation: identical bytes make no revision and keep it
  await takeDiskVersion(s.deps, "notes/a.md");
  assert.equal(s.state.copyState, "requested");
  assert.equal(s.state.drafts.has("notes/a.md"), false);
  assert.equal(s.state.stack.manifest.revision, revision + 1);
});

test("take disk version refuses when the folder changed since the last Refresh, or holds bytes the Editor cannot open while a draft exists", async () => {
  const s = await setup();
  s.fs.put("notes/a.md", "# v1\n");
  await refreshFolder(s.deps);
  s.fs.put("notes/a.md", "# v2\n");
  const stack = s.state.stack;
  await assert.rejects(() => takeDiskVersion(s.deps, "notes/a.md"), /changed in the folder since the last Refresh.*Refresh from folder and look again/);
  assert.equal(s.state.stack, stack);
  for (const [label, bytes] of [["NUL", new Uint8Array([0x61, 0, 0x62])], ["invalid UTF-8", new Uint8Array([0xff, 0xfe])], ["over 1 MiB", new Uint8Array(LIMITS.text + 1).fill(0x61)]]) {
    const t = await setup({ files: { "notes.txt": "one\n" } });
    t.state.current = "notes.txt";
    t.state.drafts.set("notes.txt", "one\nmine\n");
    t.fs.put("notes.txt", bytes);
    await refreshFolder(t.deps);
    await assert.rejects(() => takeDiskVersion(t.deps, "notes.txt"), /can no longer be edited as text.*not taken: Carbon's copy and your draft are unchanged/, label);
    assert.equal(canEdit(t.state.stack, "notes.txt"), true, label);
    assert.equal(t.state.drafts.get("notes.txt"), "one\nmine\n", label);
  }
  // Without a draft the bytes are adopted (read-only from then on).
  const u = await setup({ files: { "notes.txt": "one\n" } });
  u.fs.put("notes.txt", new Uint8Array([0x61, 0]));
  await refreshFolder(u.deps);
  await takeDiskVersion(u.deps, "notes.txt");
  assert.deepEqual(u.state.stack.files.get("notes.txt"), new Uint8Array([0x61, 0]));
  assert.equal(canEdit(u.state.stack, "notes.txt"), false);
  // Keep mine then a later disk change: Sync is refused (G6), nothing written.
  const g = await setup();
  await g.save("notes/a.md", "# mine\n");
  g.fs.put("notes/a.md", "# theirs\n");
  await refreshFolder(g.deps);
  g.state.link.baseline.set("notes/a.md", { shadow: encode("# theirs\n") }); // Keep mine (ui/source.js keepMine)
  g.fs.put("notes/a.md", "# theirs again\n");
  assert.equal((await syncFile(g.deps, "notes/a.md")).reason, "conflict");
  assert.equal(g.fs.text("notes/a.md"), "# theirs again\n");
});

// ---- status, persistence, consent memory -----------------------------------------------------------------

test("linkedStatus precedence and labels: access, then a sync in progress or refused, then the file's source state; text and glyph always", async () => {
  const s = await setup();
  const k = (p = "notes/a.md") => linkedStatus(s.state, p);
  assert.equal(k().kind, "synced");
  assert.equal(k().glyph, "✓");
  await s.save("notes/a.md", "d\n");
  assert.equal(k().kind, "modified");
  assert.equal(k().label, "Edited in Carbon, not synced");
  s.state.link.op = { kind: "saving", path: "notes/a.md" };
  assert.equal(k().kind, "saving");
  s.state.link.op = { kind: "conflict", path: "notes/a.md" };
  assert.equal(k().kind, "conflict");
  assert.equal(k("b.md").kind, "synced", "the op belongs to another path");
  s.state.link.op = { kind: "syncFailed", path: "notes/a.md" };
  assert.equal(k().kind, "syncFailed");
  s.state.link.op = null;
  s.state.link.status = "permission";
  assert.equal(k().kind, "permission");
  s.state.link.status = "linked";
  const workspace = linkedStatus(s.state, null);
  assert.equal(workspace.kind, "linked");
  assert.match(workspace.tooltip, /1 file not synced to Research/);
  for (const row of sourceRows(s.state.link, s.state.stack)) {
    const x = linkedStatus(s.state, row.path);
    assert.ok(x.glyph && x.label && x.tooltip.length > 20, row.path);
  }
  assert.equal(linkedStatus(createState(), null), null);
  const copy = createState();
  copy.stack = new LocalFolder([["a.md", encode("# a")]], [], { title: "Imported" });
  assert.equal(linkedStatus(copy, "a.md").kind, "imported");
  await assert.rejects(() => syncFile({ state: copy, notify() {}, modal: async () => assert.fail("no modal") }, "a.md"), /not a linked folder/);
});

test("link serializes handle, consent, lastSync, baseline and observed; restores with validation; bad shapes become no link or lose only the damaged part", async () => {
  const s = await setup();
  await s.save("notes/a.md", "# mine\n");
  s.fs.put("b.md", "# B theirs\n");
  s.fs.put("c.md", "new");
  await refreshFolder(s.deps);
  s.state.link.lastSync = { path: "b.md", at: "2026-10-22T10:00:00.000Z" };
  const rec = serialize(s.state);
  assert.deepEqual(Object.keys(rec.link).sort(), ["baseline", "consent", "handle", "lastSync", "observed"]);
  assert.equal(rec.link.handle, s.fs.root);
  assert.equal(recordBytes({ ...rec, rev: 1 }) > recordBytes({ ...rec, rev: 1, link: null }), true, "shadows and captured bytes count towards the workspace size");
  // Real directory handles are structured-clonable; the fake carries functions, so clone around it.
  const cloned = structuredClone({ ...rec, link: { ...rec.link, handle: null } });
  cloned.link.handle = s.fs.root;
  const back = restore(cloned);
  assert.equal(back.link.status, "permission"); // provisional until verifyLink
  assert.deepEqual(back.link.lastSync, { path: "b.md", at: "2026-10-22T10:00:00.000Z" });
  assert.deepEqual(Object.fromEntries(sourceRows(back.link, back.stack).map((r) => [r.path, r.state])), Object.fromEntries(sourceRows(s.state.link, s.state.stack).map((r) => [r.path, r.state])));
  assert.equal(back.link.op, null);

  const bad = [
    undefined, null, 5, "x", [], {},
    { handle: s.fs.root },
    { handle: s.fs.root, consent: null },
    { handle: s.fs.root, consent: { granted: "yes", remember: false, history: true } },
    { handle: s.fs.root, consent: { granted: true, remember: false } },
    { handle: {}, consent: rec.link.consent },
    { handle: { kind: "file", getFileHandle() {} }, consent: rec.link.consent },
    { handle: "folder", consent: rec.link.consent },
  ];
  for (const link of bad) assert.equal(restore({ ...rec, link }).link, null, JSON.stringify(link));
  // A bad lastSync is dropped; damaged source records degrade: no baseline reads as virtual (Sync then needs an absent disk).
  const damaged = restore({ ...rec, link: { ...rec.link, lastSync: { path: 7 }, baseline: "x", observed: 3 } });
  assert.equal(damaged.link.lastSync, null);
  assert.deepEqual(Object.fromEntries(sourceRows(damaged.link, damaged.stack).map((r) => [r.path, r.state])), { "b.md": "virtual", "data.csv": "virtual", "notes/a.md": "virtual" });
  // A link on a Stack is never honoured.
  const stackRec = serialize({ ...createState(), stack: sample(), link: s.state.link });
  assert.equal(restore(stackRec).link, null);
});

test(".carbon-history at the folder root is skipped on read and never observed; nested ones and lookalike files are ordinary", async () => {
  const fs = fakeFolder({ "a.md": "# a", ".carbon-history/index.json": "{}", ".carbon-history/x/1.md": "old", "sub/.carbon-history/n.md": "keep", ".carbon-history.md": "file" });
  const { files, directories, modified } = await readDirectoryFiles(fs.root);
  assert.deepEqual(files.map(([p]) => p).sort(), [".carbon-history.md", "a.md", "sub/.carbon-history/n.md"]);
  assert.equal(directories.some((d) => d.startsWith(".carbon-history")), false);
  assert.equal(modified.size, 3);
  assert.equal(await readDisk(fs.root, "nope/x.md"), null);
});

test("folder memory matches handles with isSameEntry, not by name", async () => {
  const a = fakeFolder({}, { name: "Same name" }), b = fakeFolder({}, { name: "Same name" });
  const store = [];
  const mem = createFolderMemory(() => ({}), {
    read: async () => store.map((value, key) => ({ key, value })),
    write: async (_db, value, key) => { if (key === undefined) store.push(value); else store[key] = value; },
  });
  assert.equal(await mem.find(a.root), null);
  await mem.remember(a.root, { granted: true, remember: true, history: false });
  assert.equal((await mem.find(a.root)).value.history, false);
  assert.equal(await mem.find(b.root), null);
  await mem.remember(a.root, { granted: true, remember: true, history: true });
  assert.equal(store.length, 1);
  assert.equal(store[0].history, true);
  const link = newLink(a.root, store[0]);
  assert.deepEqual(link.consent, { granted: true, remember: true, history: true });
  assert.deepEqual(newLink(b.root, null).consent, { granted: false, remember: false, history: true });
  assert.equal(await createFolderMemory(() => null).find(a.root), null);
});

test("forgetting remembered consent deletes the folder's record, withdraws consent and asks again on the next sync", async () => {
  const a = await setup({ consent: { granted: true, remember: true, history: true } });
  const other = fakeFolder({}, { name: "Other" });
  const store = [];
  const mem = createFolderMemory(() => ({}), {
    read: async () => store.map((value, key) => ({ key, value })).filter((r) => r.value),
    write: async (_db, value, key) => { if (key === undefined) store.push(value); else store[key] = value; },
    remove: async (_db, key) => { store[key] = null; },
  });
  await mem.remember(a.fs.root, { granted: true, remember: true, history: true });
  await mem.remember(other.root, { granted: true, remember: true, history: true });
  a.deps.folderMemory = mem;
  a.deps.modal = async (t) => (a.modals.push(t), { history: true, remember: false });
  const asked = [];
  a.deps.confirm = async (t) => (asked.push(t), false);
  await forgetConsent(a.deps); // declined: nothing changes
  assert.equal(a.state.link.consent.remember, true);
  assert.equal(store.filter(Boolean).length, 2);
  a.deps.confirm = async (t) => (asked.push(t), true);
  await forgetConsent(a.deps);
  assert.equal(store.filter(Boolean).length, 1);
  assert.equal(await mem.find(a.fs.root), null);
  assert.ok(await mem.find(other.root), "other folders' consent is untouched");
  assert.deepEqual({ ...a.state.link.consent }, { granted: false, remember: false, history: true });
  assert.match(a.notices.at(-1).m, /Forgot remembered consent/);
  assert.equal(writeAttempts(a.fs), 0);
  await a.save("notes/a.md", "x\n");
  await syncFile(a.deps, "notes/a.md");
  assert.deepEqual(a.modals, ["Sync to the original folder?"]);

  const b = await setup({ consent: { granted: true, remember: true, history: true } });
  b.deps.folderMemory = createFolderMemory(() => ({}), {
    read: async () => [{ key: 0, value: { handle: b.fs.root } }],
    remove: async () => { throw new Error("store locked"); },
  });
  await assert.rejects(() => forgetConsent(b.deps), /Could not forget the remembered consent \(store locked\)\. It is still remembered\./);
  assert.equal(b.state.link.consent.remember, true);
});
