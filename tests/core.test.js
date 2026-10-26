import test from "node:test";
import assert from "node:assert/strict";
import { entry, yaml, patchScalar } from "../src/core/entries.js";
import { Stack, newStack, History, sameStack } from "../src/core/stack.js";
import {
  path,
  validatePaths,
  encode,
  decode,
  LIMITS,
} from "../src/core/validate.js";
import {
  dispatch,
  parseHandoff,
  registerDispatch,
  propose,
  diffLines,
} from "../src/core/handoff.js";
import { readTar, writeTar } from "../src/archives/tar.js";
import { gzip, gunzip } from "../src/archives/gzip.js";
import { sample, fixChecksum, setName } from "./helpers.js";
const changed = (d) => d.text.replace("# Original", "# Revised");
test("TAR exact text/binary/nested/Unicode/PAX/empty directory round trip", () => {
  const s = sample();
  assert.ok(sameStack(s, readTar(writeTar(s))));
  assert.deepEqual(writeTar(s), writeTar(s));
});
test("TAR.GZ deterministic exact round trip", async () => {
  const s = sample(),
    a = await gzip(writeTar(s));
  assert.deepEqual(a, await gzip(writeTar(s)));
  assert.ok(sameStack(s, readTar(await gunzip(a))));
});
test("long Stack ID uses PAX for root and paths", () => {
  const s = new Stack([
    [
      "stack.yaml",
      encode(`format: envoy.stack/v0.2\nid: ${"s".repeat(128)}\nrevision: 0\n`),
    ],
  ]);
  assert.ok(sameStack(s, readTar(writeTar(s))));
});
test("YAML scalar patch preserves every other byte including CRLF and comments", () => {
  const source = "# x\r\nrevision: 3  # inline\r\nunknown: {a: yes}\r\n";
  assert.equal(
    patchScalar(source, "revision", 4),
    source.replace("revision: 3", "revision: 4"),
  );
});
test("Markdown and YAML unknown fields/comment/ID preservation through edit and move", () => {
  const s = sample(),
    p = "entries/nested/note.md",
    text = s.text(p).replace("Original", "Revised");
  const next = s
    .change({ writes: new Map([[p, encode(text)]]) })
    .change({ moves: [[p, "entries/moved.md"]] });
  assert.equal(next.text("entries/moved.md"), text);
  assert.equal(next.manifest.entrypoint, "entries/moved.md");
  assert.equal(next.manifest.revision, 5);
  assert.match(next.text("stack.yaml"), /# revision comment/);
  assert.match(text, /# keep comment/);
});
test("ordinary Markdown remains ordinary and exact", () => {
  const source = "Plain text\r\nno final newline";
  assert.deepEqual(entry(source).data, {});
  const s = newStack().change({
    writes: new Map([["notes/plain.md", encode(source)]]),
  });
  assert.equal(s.text("notes/plain.md"), source);
});
test("managed Entry ID cannot change, disappear or duplicate", () => {
  const s = sample(),
    p = "entries/nested/note.md";
  for (const text of [s.text(p).replace("ent-note", "ent-other"), "# no ID"])
    assert.throws(
      () => s.change({ writes: new Map([[p, encode(text)]]) }),
      /ID/,
    );
  assert.throws(
    () => s.change({ writes: new Map([["duplicate.md", s.files.get(p)]]) }),
    /Duplicate Entry/,
  );
});
test("invalid YAML, aliases, tags, duplicates, complex keys and excess nesting rejected", () => {
  for (const bad of [
    "a: 1\na: 2",
    "a: &x [1]\nb: *x",
    "a: !evil x",
    "? [a,b]\n: c",
    "a: 1\n---\nb: 2",
    "%YAML 1.1\n---\na: yes",
    "a: " + "[".repeat(34) + "0" + "]".repeat(34),
  ])
    assert.throws(() => yaml(bad));
});
test("manifest identity, revision, entrypoint and file limits", () => {
  for (const text of [
    "format: nope\nid: s\nrevision: 0",
    "format: envoy.stack/v0.2\nid: ../x\nrevision: 0",
    "format: envoy.stack/v0.2\nid: s\nrevision: -1",
    "format: envoy.stack/v0.2\nid: s\nrevision: 0.5",
    "format: envoy.stack/v0.2\nid: s\nrevision: 0\nentrypoint: missing.md",
  ])
    assert.throws(() => new Stack([["stack.yaml", encode(text)]]));
  assert.throws(
    () =>
      sample().change({
        writes: new Map([["huge", new Uint8Array(LIMITS.file + 1)]]),
      }),
    /large/,
  );
});
test("portable path traversal, drive, UNC, reserved and Unicode ambiguity rejected", () => {
  for (const p of [
    "../x",
    "/x",
    "C:/x",
    "a\\b",
    "a//b",
    "a/./b",
    "a/../b",
    "aux.txt",
    "a/COM1.md",
    "x.",
    "x ",
    "a\0b",
    "e\u0301.md",
    ".git/config",
    "a\u202eb",
    "a/".repeat(33) + "x",
  ])
    assert.throws(() => path(p), p);
  path("entries/日本語.md");
});
test("case, normalized, parent and file/directory collisions rejected", () => {
  for (const list of [
    ["a", "A"],
    ["a", "a"],
    ["A/x", "a/y"],
    ["a", "a/b"],
  ])
    assert.throws(() => validatePaths(list), /collision/);
  assert.throws(() => validatePaths(["a"], ["a"]), /collision/);
});
test("corrupt, truncated, unaligned, missing terminator and trailing TAR data rejected", () => {
  const tar = writeTar(sample());
  const corrupt = tar.slice();
  corrupt[10] ^= 1;
  assert.throws(() => readTar(corrupt), /checksum/);
  assert.throws(() => readTar(tar.slice(0, -1)));
  assert.throws(() => readTar(tar.slice(0, -1024)), /terminator/);
  const trailing = new Uint8Array(tar.length + 512);
  trailing.set(tar);
  trailing[trailing.length - 1] = 1;
  assert.throws(() => readTar(trailing), /end markers/);
});
test("TAR traversal names and root escapes rejected", () => {
  for (const p of [
    "../bad",
    "/absolute",
    "C:/drive",
    "root/../bad",
    "root\\bad",
    "root/NUL",
  ])
    assert.throws(() => readTar(setName(writeTar(sample()), p)));
});
test("TAR links, devices, sparse and unsupported formats rejected", () => {
  for (const type of ["1", "2", "3", "4", "6", "S", "L"]) {
    const b = writeTar(sample());
    b[156] = type.charCodeAt(0);
    fixChecksum(b);
    assert.throws(() => readTar(b), /member type/);
  }
  const b = writeTar(sample());
  b[257] = 0;
  fixChecksum(b);
  assert.throws(() => readTar(b), /format/);
});
test("TAR malicious sizes and non-octal fields rejected before body read", () => {
  for (const size of ["77777777777\0", "99999999999\0"]) {
    const b = writeTar(sample());
    b.set(encode(size), 124);
    fixChecksum(b);
    assert.throws(() => readTar(b));
  }
});
test("TAR duplicate member rejected", () => {
  const tar = writeTar(sample()),
    out = new Uint8Array(tar.length + 512);
  out.set(tar.subarray(0, 512));
  out.set(tar, 512);
  assert.throws(() => readTar(out), /Duplicate TAR/);
});
test("gzip corruption and expansion bombs rejected", async () => {
  const bomb = await gzip(new Uint8Array(2 * 1024 ** 2));
  await assert.rejects(() => gunzip(bomb), /decompression/);
  const b = await gzip(writeTar(sample()));
  b[b.length - 5] ^= 1;
  await assert.rejects(() => gunzip(b));
  await assert.rejects(() => gunzip(b.subarray(0, -5)));
});
test("handoff exact text preserves CRLF and absent final newline", () => {
  const s = sample(),
    d = dispatch(s),
    p = parseHandoff(d.text);
  for (const [name, b] of p.files) assert.deepEqual(b, s.files.get(name));
  assert.ok(p.meta.omitted_files.includes("assets/bytes.bin"));
});
test("partial Return keeps omitted Entries, Assets and empty dirs with one revision increment", () => {
  const s = sample(),
    d = dispatch(s, ["entries/nested/note.md"]),
    r = propose(s, d, changed(d));
  assert.equal(r.next.manifest.revision, 4);
  assert.equal(r.changes.length, 1);
  for (const p of d.omitted)
    assert.deepEqual(r.next.files.get(p), s.files.get(p));
  assert.deepEqual(r.next.directories, s.directories);
  assert.match(s.text("entries/nested/note.md"), /# Original/);
});
test("Return identity and base revision mismatch rejected", () => {
  const s = sample(),
    d = dispatch(s);
  assert.throws(
    () =>
      propose(s, d, changed(d).replace("base_revision: 3", "base_revision: 4")),
    /revision/,
  );
  assert.throws(
    () =>
      propose(
        s,
        d,
        changed(d).replace("stack_id: stk-test", "stack_id: stk-other"),
      ),
    /identity/,
  );
});
test("Return requires trusted scope and exact prior state even if revision forged unchanged", () => {
  const s = sample(),
    d = dispatch(s, ["entries/nested/note.md"]);
  assert.throws(() => propose(s, null, changed(d)), /dispatch/);
  const f = new Map(s.files);
  f.set("assets/bytes.bin", encode("changed"));
  assert.throws(
    () => propose(new Stack(f, s.directories), d, changed(d)),
    /changed since/,
  );
  const wide = dispatch(s);
  assert.throws(() => propose(s, d, changed(wide)), /scope/);
});
test("Return refuses managed ID changes and manifest edits", () => {
  const s = sample(),
    d = dispatch(s);
  assert.throws(
    () => propose(s, d, changed(d).replace("ent-note #", "ent-new #")),
    /ID/,
  );
  assert.throws(
    () => propose(s, d, changed(d).replace("revision: 3 #", "revision: 4 #")),
    /stack.yaml/,
  );
});
test("handoff missing, duplicate, mismatched, traversal and trailing frames fail safely", () => {
  const d = dispatch(sample());
  for (const bad of [
    d.text.slice(0, -10),
    d.text + d.text,
    d.text.replace('path="stack.yaml"', 'path="..%2Fbad"'),
    d.text.replace("## File: stack.yaml", "## File: missing"),
    d.text.replace("framing: exact-v1", "framing: old"),
  ])
    assert.throws(() => parseHandoff(bad));
});
test("original dispatch registration requires current exact text and complete inventory", () => {
  const s = sample(),
    d = dispatch(s);
  assert.equal(registerDispatch(s, d.text).dispatchId, d.dispatchId);
  assert.throws(() => registerDispatch(s, changed(d)), /differs/);
});
test("bounded History retains prior immutable logical state and diff has explicit +/-", () => {
  const h = new History(),
    s = sample();
  for (let i = 0; i < 12; i++) h.push(s, "test");
  assert.equal(h.items.length, 10);
  assert.equal(h.items[0].stack, s);
  assert.deepEqual(
    diffLines("a\nb", "a\nc")
      .filter((x) => x.kind !== "context")
      .map((x) => x.kind),
    ["removed", "added"],
  );
});
test("Stack constructor rejects duplicate input members before Map conversion", () => {
  assert.throws(
    () => new Stack([...sample().files, ...sample().files]),
    /collision/,
  );
});
test("editor keeps unchanged frontmatter bytes and CRLF when saving body edits", async () => {
  const { editorSource } = await import("../src/core/entries.js");
  const source = "---\r\nid: ent-crlf # keep\r\n---\r\n# Before\r\n";
  assert.equal(
    editorSource(
      source.replace(/\r\n/g, "\n").replace("Before", "After"),
      source,
    ),
    source.replace("Before", "After"),
  );
});
test("excessive Markdown, YAML and file count rejected", () => {
  assert.throws(() => entry("x".repeat(LIMITS.text + 1)), /limit/);
  assert.throws(() => yaml("a: " + "x".repeat(LIMITS.yaml)), /limit/);
  assert.throws(
    () =>
      new Stack([
        ...sample().files,
        ...Array.from({ length: LIMITS.files }, (_, i) => [
          "a" + i,
          new Uint8Array(),
        ]),
      ]),
    /count/,
  );
});
test("PAX traversal override, malformed length, unsupported records and duplicate keys rejected", () => {
  const original = writeTar(sample());
  let at = 0;
  while (original[at + 156] !== 120) {
    const size = parseInt(
      new TextDecoder().decode(original.subarray(at + 124, at + 136)),
      8,
    );
    at += 512 + Math.ceil(size / 512) * 512;
  }
  for (const mutate of [
    (b) => {
      b[at + 512] = 57;
    },
    (b) => {
      const body = new TextDecoder().decode(b.subarray(at + 512, at + 1024));
      const off = body.indexOf("path=");
      b.set(encode("evil="), at + 512 + off);
    },
    (b) => {
      const body = new TextDecoder().decode(b.subarray(at + 512, at + 1024));
      const off = body.indexOf("path=") + 5;
      b.set(encode("../"), at + 512 + off);
    },
  ]) {
    const b = original.slice();
    mutate(b);
    assert.throws(() => readTar(b));
  }
});
test("deleting the entrypoint removes its optional field while keeping comments and unknown keys", () => {
  const s = sample(),
    next = s.change({ deletes: ["entries/nested/note.md"] });
  assert.equal(next.manifest.entrypoint, undefined);
  assert.deepEqual(next.manifest.unknown, ["a", "b"]);
  assert.match(next.text("stack.yaml"), /# keep manifest comment/);
  assert.equal(next.manifest.revision, 4);
});
test('Windows device aliases, Unicode case collisions and oversized components rejected',()=>{for(const name of ['COM¹.txt','LPT².md','CONIN$','CONOUT$','x'.repeat(256)])assert.throws(()=>path(name));assert.throws(()=>validatePaths(['Straße.md','STRASSE.md']),/collision/);});
test('relative path depth and file-count limits round trip without counting the archive root',()=>{const base=newStack();const deep=base.change({writes:new Map([['d/'.repeat(LIMITS.depth-1)+'x.md',encode('# Deep')]])});assert.ok(sameStack(deep,readTar(writeTar(deep))));const many=new Stack([...base.files,...Array.from({length:LIMITS.files-1},(_,i)=>['f'+i,new Uint8Array()])]);assert.ok(sameStack(many,readTar(writeTar(many))));});
