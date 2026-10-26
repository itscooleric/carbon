import test from "node:test";
import assert from "node:assert/strict";
import { FakeFs } from "./fake-fs.mjs";
import { openDiskHistory, HISTORY_DIR, FORMAT } from "../src/carbon/history/disk.js";
import { readTarFiles } from "../src/archives/tar.js";
import { encode, decode, LIMITS } from "../src/core/validate.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 2, 15, 14, 25, 30, 123);
const clock = (start = T0) => {
  const c = { t: start, now: () => c.t };
  return c;
};
const open = async (fs = new FakeFs(), c = clock(), options = {}) => ({
  fs,
  c,
  h: await openDiskHistory(fs.root, { now: c.now, ...options }),
});

test("first open creates the history directory, manifest and README", async () => {
  const { fs } = await open();
  assert.deepEqual(fs.files(), [
    `${HISTORY_DIR}/README.txt`,
    `${HISTORY_DIR}/carbon-history.json`,
  ]);
  const manifest = JSON.parse(decode(fs.bytes(`${HISTORY_DIR}/carbon-history.json`)));
  assert.equal(manifest.format, FORMAT);
  assert.equal(manifest.created, new Date(T0).toISOString());
  assert.deepEqual(manifest.retention, { days: 30, maxBytes: 100 * 1024 * 1024 });
  const readme = decode(fs.bytes(`${HISTORY_DIR}/README.txt`));
  assert.match(readme, /COMPLETE earlier version/);
  assert.match(readme, /restore by hand/);
});

test("reopening keeps the existing manifest untouched", async () => {
  const { fs } = await open();
  const before = fs.bytes(`${HISTORY_DIR}/carbon-history.json`);
  await openDiskHistory(fs.root, { retentionDays: 5 });
  assert.deepEqual(fs.bytes(`${HISTORY_DIR}/carbon-history.json`), before);
});

test("unsupported or malformed manifests refuse to open", async () => {
  const fs = new FakeFs();
  fs.seed(`${HISTORY_DIR}/carbon-history.json`, JSON.stringify({ format: "carbon-history/2" }));
  await assert.rejects(openDiskHistory(fs.root), /Unsupported local history format/);
  fs.seed(`${HISTORY_DIR}/carbon-history.json`, "{nope");
  await assert.rejects(openDiskHistory(fs.root), /not valid JSON/);
});

test("open throws when the directory cannot be created", async () => {
  const fs = new FakeFs();
  fs.failOn(HISTORY_DIR, { stage: "getDirectory" });
  await assert.rejects(openDiskHistory(fs.root), /Local history unavailable/);
});

test("preserve writes a verified snapshot, returns metadata and mirrors the path", async () => {
  const { fs, h } = await open();
  const bytes = encode("# previous\n");
  const meta = await h.preserve("notes/plan.md", bytes, { modified: T0 - 5000 });
  assert.equal(meta.path, "notes/plan.md");
  assert.equal(meta.size, bytes.length);
  assert.equal(meta.savedAt, T0);
  assert.match(
    meta.id,
    /^\.carbon-history\/versions\/notes\/plan\.20260315T142530123Z\.[0-9a-f]{6}\.m20260315T142525123Z\.md$/,
  );
  assert.deepEqual(fs.bytes(meta.id), bytes);
  assert.deepEqual(await h.read(meta.id), bytes);
});

test("names without an extension, dotfiles and multi-dot names round trip", async () => {
  const { h } = await open();
  for (const p of ["Makefile", ".env", "a/b.tar.gz", "x.20260101T000000000Z.abcdef"]) {
    const meta = await h.preserve(p, encode(p));
    assert.equal((await h.list(p))[0].id, meta.id, p);
    assert.equal((await h.list(p))[0].path, p);
  }
});

test("list rebuilds from the directory, newest first, ignoring bogus and foreign files", async () => {
  const { fs, c, h } = await open();
  const a = await h.preserve("a.md", encode("one"));
  c.t += 1000;
  const b = await h.preserve("a.md", encode("two"));
  await h.preserve("other.md", encode("x"));
  // Half-written (empty) file with our naming, a stray note, and a sibling with a similar name.
  fs.seed(".carbon-history/versions/a.20260315T150000000Z.123456.md", "");
  fs.seed(".carbon-history/versions/a.md.notes", "hand written");
  fs.seed(".carbon-history/versions/ab.20260315T150000000Z.123456.md", "x");
  const fresh = await openDiskHistory(fs.root, { now: c.now });
  const rows = await fresh.list("a.md");
  assert.deepEqual(rows.map((r) => r.id), [b.id, a.id]);
  assert.equal(rows[0].modified, null);
  assert.deepEqual(await fresh.list("missing/dir.md"), []);
});

test("read returns exact bytes (all 256 values) and detects corruption", async () => {
  const { fs, h } = await open();
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const meta = await h.preserve("bin/data.bin", bytes);
  assert.deepEqual(await h.read(meta.id), bytes);
  fs.seed(meta.id, "tampered");
  await assert.rejects(h.read(meta.id), /corrupt/);
  await assert.rejects(h.read("notes/plan.md"), /Not a local history snapshot/);
  await assert.rejects(h.read(".carbon-history/versions/../x"), /Unsafe path/);
});

test("empty files can be preserved and listed", async () => {
  const { h } = await open();
  const meta = await h.preserve("empty.txt", new Uint8Array());
  assert.equal(meta.size, 0);
  assert.equal((await h.list("empty.txt")).length, 1);
  assert.deepEqual(await h.read(meta.id), new Uint8Array());
});

test("prune by age removes old versions but keeps the newest of each path", async () => {
  const { fs, c, h } = await open();
  const old1 = await h.preserve("a.md", encode("1"));
  c.t += DAY;
  const old2 = await h.preserve("a.md", encode("2"));
  await h.preserve("b/only.md", encode("lonely"));
  c.t += 40 * DAY; // everything is now older than 30 days
  const fresh = await h.preserve("c.md", encode("fresh"));
  // a.md keeps only its newest; b/only.md is old but is the newest of its path, so it stays.
  assert.equal(fs.files(".carbon-history/versions").length, 3);
  assert.deepEqual((await h.list("a.md")).map((r) => r.id), [old2.id]);
  assert.equal((await h.list("b/only.md")).length, 1);
  assert.equal((await h.list("c.md"))[0].id, fresh.id);
  assert.equal(fs.bytes(old1.id), undefined);
});

test("prune by size removes oldest first, never the newest of a path, and sweeps empty dirs", async () => {
  const { fs, c, h } = await open(new FakeFs(), clock(), { maxBytes: 25 });
  const v1 = await h.preserve("dir/a.md", new Uint8Array(10).fill(1));
  c.t += 1;
  const v2 = await h.preserve("dir/a.md", new Uint8Array(10).fill(2));
  c.t += 1;
  const w1 = await h.preserve("other/b.md", new Uint8Array(10).fill(3));
  // 30 bytes > 25: the oldest (v1) went; newest of each path stay.
  assert.deepEqual((await h.list("dir/a.md")).map((r) => r.id), [v2.id]);
  assert.equal(fs.bytes(v1.id), undefined);
  c.t += 1;
  // Even if the budget is too small for the newest versions, they are kept.
  const tiny = await openDiskHistory(fs.root, { now: c.now, maxBytes: 1 });
  assert.deepEqual(await tiny.prune(), { removed: 0 });
  assert.equal((await tiny.list("other/b.md"))[0].id, w1.id);
  assert.equal((await tiny.list("dir/a.md")).length, 1);
});

test("prune removes interrupted empty leftovers and leaves unknown files alone", async () => {
  const { fs, h } = await open();
  fs.seed(".carbon-history/versions/a.20260315T150000000Z.123456.md", "");
  fs.seed(".carbon-history/versions/readme-by-user.txt", "mine");
  const res = await h.prune();
  assert.equal(res.removed, 1);
  assert.deepEqual(fs.files(".carbon-history/versions"), [".carbon-history/versions/readme-by-user.txt"]);
});

test("a write failure throws and leaves no snapshot visible", async () => {
  for (const stage of ["create", "write", "close"]) {
    const { fs, h } = await open();
    fs.failOn("versions/", { stage });
    await assert.rejects(h.preserve("notes/a.md", encode("keep me")), /Local history backup failed/, stage);
    fs.clearFailures();
    assert.deepEqual(await h.list("notes/a.md"), [], stage);
    assert.deepEqual(fs.files(".carbon-history/versions"), [], stage);
  }
});

test("if cleanup also fails the leftover is an empty file that list() hides and prune() removes", async () => {
  const { fs, h } = await open();
  fs.failOn("versions/", { stage: "close" });
  fs.failOn("versions/", { stage: "remove" });
  await assert.rejects(h.preserve("a.md", encode("x")), /backup failed/);
  fs.clearFailures();
  assert.equal(fs.files(".carbon-history/versions").length, 1);
  assert.deepEqual(await h.list("a.md"), []);
  assert.equal((await h.prune()).removed, 1);
  assert.deepEqual(fs.files(".carbon-history/versions"), []);
});

test("a silently truncated write is caught by verification", async () => {
  const { fs, h } = await open();
  fs.truncateOn("versions/", 3);
  await assert.rejects(h.preserve("a.md", encode("long enough")), /verification failed/);
  fs.clearFailures();
  assert.deepEqual(await h.list("a.md"), []);
  assert.deepEqual(fs.files(".carbon-history/versions"), []);
});

test("a prune failure never fails a verified preserve", async () => {
  const { fs, c, h } = await open();
  const old = await h.preserve("a.md", encode("1"));
  c.t += 40 * DAY;
  fs.failOn("versions/", { stage: "remove" });
  const next = await h.preserve("a.md", encode("2"));
  assert.ok(next.id);
  fs.clearFailures();
  assert.equal((await h.list("a.md")).length, 2); // old one survived the failed prune
  assert.deepEqual(await h.prune(), { removed: 1 });
  assert.deepEqual((await h.list("a.md")).map((r) => r.id), [next.id]);
  assert.equal(fs.bytes(old.id), undefined);
});

test("a corrupt leftover is never protected as the newest: the last readable backup survives pruning", async () => {
  for (const pressure of ["age", "size"]) {
    const { fs, c, h } = await open(new FakeFs(), clock(), pressure === "size" ? { maxBytes: 5 } : {});
    const good = await h.preserve("a.md", encode("good"));
    c.t += pressure === "age" ? 40 * DAY : 1000;
    // A truncated write fails verification AND its cleanup fails: the damaged file stays on disk.
    fs.truncateOn("versions/", 3);
    fs.failOn("versions/", { stage: "remove" });
    await assert.rejects(h.preserve("a.md", encode("a much longer version")), /verification failed/, pressure);
    fs.clearFailures();
    assert.equal(fs.files(".carbon-history/versions").length, 2, pressure);
    const res = await h.prune();
    assert.equal(res.removed, 1, pressure);
    assert.deepEqual(fs.files(".carbon-history/versions"), [good.id], pressure);
    assert.deepEqual(await h.read(good.id), encode("good"), pressure);
  }
});

test("prune only reads the newest candidate per path to verify it", async () => {
  const { fs, c, h } = await open();
  await h.preserve("a.md", encode("1"));
  c.t += 1;
  await h.preserve("a.md", encode("2"));
  c.t += 1;
  const last = await h.preserve("a.md", encode("3"));
  fs.log.length = 0;
  await h.prune();
  assert.equal(fs.log.filter((l) => l.startsWith("getFile ") && l.includes(last.id.split("/").pop())).length, 2); // size scan + verification
  assert.equal(fs.log.filter((l) => l.startsWith("getFile ") && l.includes("a.20")).length, 4); // 3 scans + 1 verification
});

test("preserve never prunes the backup it just verified, even when timestamps tie", async () => {
  // A second handle object over the same folder has its own clock, like another tab: equal `now`.
  const alias = (root) => new Proxy(root, { get: (t, k) => (typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  for (let i = 0; i < 8; i++) {
    const fs = new FakeFs();
    const first = await openDiskHistory(fs.root, { now: () => T0, maxBytes: 8 });
    await first.preserve("a.md", encode(`old-${i}`));
    const second = await openDiskHistory(alias(fs.root), { now: () => T0, maxBytes: 8 });
    const fresh = await second.preserve("a.md", encode(`new-${i}`));
    assert.ok(fs.bytes(fresh.id), `fresh backup ${i} must survive size pruning`);
    assert.deepEqual(await second.read(fresh.id), encode(`new-${i}`));
  }
});

test("savedAt is monotonic across DiskHistory instances and across a clock rollback", async () => {
  const fs = new FakeFs();
  const c = clock();
  const ids = [];
  let prev = 0;
  for (let i = 0; i < 6; i++) {
    // Fresh instance per save, as the app does; only the clock differs.
    c.t = i === 3 ? T0 - 5 * DAY : T0; // same millisecond, then a rollback
    const h = await openDiskHistory(fs.root, { now: c.now, maxBytes: 12 });
    const meta = await h.preserve("a.md", encode(`v${i}`.padEnd(6, "x")));
    assert.ok(meta.savedAt > prev, `savedAt ${i} must increase`);
    prev = meta.savedAt;
    ids.push(meta.id);
    assert.ok(fs.bytes(meta.id), `backup ${i} must survive`);
  }
  const h = await openDiskHistory(fs.root, { now: c.now });
  assert.equal((await h.list("a.md"))[0].id, ids[5]);
});

test("traversal, absolute, hostile and self-referencing paths are rejected", async () => {
  const { h } = await open();
  for (const p of [
    "../x.md", "/abs.md", "a/../b.md", "a\\b.md", "C:/x.md", "", ".git/config",
    ".carbon-history/versions/x.md", ".Carbon-History/x", ".carbon-history", "a.md.m20260101T000000000Z",
  ])
    await assert.rejects(h.preserve(p, encode("x")), undefined, p);
  await assert.rejects(h.list("../x"));
  await assert.rejects(h.preserve("a.md", "not bytes"), /Uint8Array/);
  await assert.rejects(h.preserve("a.md", new Uint8Array(LIMITS.file + 1)), /too large/);
  await assert.rejects(h.preserve("a.md", encode("x"), { modified: NaN }), /Invalid modified/);
});

test("two preserves of the same path and bytes in the same millisecond do not collide", async () => {
  const { fs, h } = await open();
  const bytes = encode("same");
  const a = await h.preserve("a.md", bytes);
  const b = await h.preserve("a.md", bytes);
  const other = await openDiskHistory(fs.root, { now: () => T0 });
  const c = await other.preserve("a.md", bytes);
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  assert.equal((await h.list("a.md")).length, 3);
  assert.ok(a.savedAt < b.savedAt);
});

test("exportArchive round-trips through readTarFiles", async () => {
  const { fs, c, h } = await open();
  const m1 = await h.preserve("notes/a.md", encode("one"), { modified: T0 });
  c.t += 5;
  const m2 = await h.preserve("b.bin", Uint8Array.from([0, 255, 7]));
  const { files, directories } = readTarFiles(await h.exportArchive());
  const map = new Map(files);
  assert.deepEqual([...map.keys()].sort(), [
    "README.txt",
    "carbon-history.json",
    m1.id.slice(HISTORY_DIR.length + 1),
    m2.id.slice(HISTORY_DIR.length + 1),
  ].sort());
  assert.deepEqual(map.get(m1.id.slice(HISTORY_DIR.length + 1)), encode("one"));
  assert.deepEqual(map.get("carbon-history.json"), fs.bytes(`${HISTORY_DIR}/carbon-history.json`));
  assert.ok(directories.includes("versions/notes"));
});

test("exportArchive on a history beyond the TAR limits is explicit about what it omitted", async () => {
  const { c, h } = await open(new FakeFs(), clock(), { retentionDays: Infinity, maxBytes: Infinity });
  const big = new Uint8Array(LIMITS.file).fill(9);
  const saved = [];
  for (let i = 0; i < 5; i++) {
    saved.push(await h.preserve(`big${i}.bin`, big));
    c.t += 1;
  }
  const map = new Map(readTarFiles(await h.exportArchive()).files);
  const note = decode(map.get("EXPORT-INCOMPLETE.txt"));
  const included = saved.filter((s) => map.has(s.id.slice(HISTORY_DIR.length + 1)));
  assert.ok(included.length > 0 && included.length < 5);
  // Newest first; every snapshot is either included or listed.
  for (const s of saved) assert.ok(included.includes(s) || note.includes(s.id.slice(`${HISTORY_DIR}/`.length)));
  assert.ok(included.includes(saved[4]));
});

test("create:false on a folder without history writes nothing: list() is empty, export says there is none yet", async () => {
  const fs = new FakeFs();
  fs.seed("notes/a.md", "# a");
  fs.failOn(/./, { stage: "create" }); // read-only folder: no writable may ever be opened
  const h = await openDiskHistory(fs.root, { create: false });
  assert.deepEqual(await h.list("notes/a.md"), []);
  await assert.rejects(h.exportArchive(), /No local history yet/);
  await assert.rejects(h.read(`${HISTORY_DIR}/versions/notes/a.md.x`), /./);
  await assert.rejects(h.preserve("notes/a.md", encode("x")), /read-only/);
  assert.equal(fs.root.children.has(HISTORY_DIR), false, "the history directory must not be created");
  assert.deepEqual(fs.files(), ["notes/a.md"]);
  assert.equal(fs.log.some((l) => l.startsWith("create ")), false);
});

test("create:false on an existing history lists, reads and exports under read-only permission", async () => {
  const { fs, h } = await open();
  const saved = await h.preserve("notes/a.md", encode("old"), { modified: T0 });
  const before = fs.files();
  fs.failOn(/./, { stage: "create" });
  fs.failOn(/./, { stage: "remove" });
  const ro = await openDiskHistory(fs.root, { create: false });
  assert.deepEqual((await ro.list("notes/a.md")).map((v) => v.id), [saved.id]);
  assert.deepEqual(await ro.read(saved.id), encode("old"));
  const map = new Map(readTarFiles(await ro.exportArchive()).files);
  assert.ok(map.has("README.txt"));
  assert.deepEqual(fs.files(), before);
  // The default still creates (preserve depends on it).
  const fresh = new FakeFs();
  await openDiskHistory(fresh.root);
  assert.ok(fresh.root.children.has(HISTORY_DIR));
});

test("create:false still refuses an unsupported manifest and never writes a missing one", async () => {
  const fs = new FakeFs();
  fs.seed(`${HISTORY_DIR}/carbon-history.json`, JSON.stringify({ format: "carbon-history/2" }));
  await assert.rejects(openDiskHistory(fs.root, { create: false }), /Unsupported local history format/);
  const bare = new FakeFs();
  bare.seed(`${HISTORY_DIR}/versions/x.txt`, "keep");
  const h = await openDiskHistory(bare.root, { create: false });
  assert.deepEqual(await h.list("x.txt"), []);
  assert.deepEqual(bare.files(), [`${HISTORY_DIR}/versions/x.txt`]);
});
