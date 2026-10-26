import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalFolder, canEdit, editableBytes, textIssue, defaultDocument, entryFor, isMarkdown,
  textFormat, describeLineEndings, toEditorText, sourceFor, saveBytes, MixedLineEndingsError,
} from "../src/carbon/local-files.js";
import { Stack, newStack } from "../src/core/stack.js";
import { encode, decode, LIMITS } from "../src/core/validate.js";
import { assertNewPath, suggestPath } from "../src/core/naming.js";
import { resolveEntry, backlinkedEntries } from "../src/carbon/markdown.js";
import { buildIndex } from "../src/carbon/palette/search.js";
import { isTextLike } from "../src/carbon/asset-data.js";
import { viewableIn, workspaceState } from "../src/carbon/workspace.js";
import { fakeFolder } from "./linked-fake-fs.js";
import { readDirectoryFiles } from "../src/carbon/fs.js";
import { createState, commit } from "../src/carbon/state.js";
import { newLink, syncFile, takeDiskVersion, refreshFolder } from "../src/carbon/linked.js";
import { trackBaseline } from "../src/carbon/source.js";
import { History } from "../src/core/stack.js";

const BOM = "﻿";
const folder = (files, directories = []) =>
  new LocalFolder(Object.entries(files).map(([p, v]) => [p, typeof v === "string" ? encode(v) : v]), directories);

test("ordinary workspaces edit any bounded UTF-8 text by its bytes, whatever its name", () => {
  const f = folder({
    "notes/today.txt": "plain\n",
    README: "no extension\n",
    "config.yaml": "---\nkey: value\n---\n",
    "data.json": '{"n":9007199254740993}',
    "table.csv": "a,b\n1,2\n",
    "src/tool.py": "def f():\n    return '<img src=x onerror=alert(1)>'\n",
    "page.html": "<script>window.pwned = 1</script>",
    ".env.example": "KEY=\n",
    "empty.txt": new Uint8Array(),
    "note.md": "# Note\n",
  });
  for (const p of f.files.keys()) assert.equal(canEdit(f, p), true, p);
  assert.equal(canEdit(f, "missing.txt"), false);
  assert.equal(canEdit(f, null), false);
  assert.equal(editableBytes("any.name", encode("text")), true);
});

test("invalid UTF-8, NUL anywhere and more than 1 MiB stay read-only, each with a reason", () => {
  const nulLate = new Uint8Array(9000).fill(0x61);
  nulLate[8999] = 0;
  const f = folder({
    "bad.txt": new Uint8Array([0x61, 0xff, 0xfe]),
    "late-nul.txt": nulLate,
    "big.txt": new Uint8Array(LIMITS.text + 1).fill(0x61),
    "exact.txt": new Uint8Array(LIMITS.text).fill(0x61),
    "bad.md": new Uint8Array([0xc3]),
    "image.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
  });
  assert.equal(canEdit(f, "exact.txt"), true, "exactly 1 MiB is editable");
  assert.match(textIssue(f.files.get("big.txt")), /larger than the 1 MiB text editing limit/);
  assert.match(textIssue(f.files.get("bad.txt")), /not valid UTF-8/);
  assert.match(textIssue(f.files.get("bad.md")), /not valid UTF-8/);
  assert.match(textIssue(f.files.get("image.png")), /NUL/);
  // The Viewer's text sniffing reads an 8 KiB prefix; editing scans every byte.
  assert.equal(isTextLike(nulLate), true);
  assert.match(textIssue(nulLate), /NUL/);
  for (const p of ["bad.txt", "late-nul.txt", "big.txt", "bad.md", "image.png"]) assert.equal(canEdit(f, p), false, p);
  // Read-only files stay viewable or downloadable; their bytes are untouched inventory.
  assert.equal(viewableIn(f, "big.txt"), true);
  assert.deepEqual(f.files.get("bad.txt"), new Uint8Array([0x61, 0xff, 0xfe]));
});

test("strict Envoy Stacks keep editing Markdown Entries only", () => {
  const base = newStack("Strict");
  const s = new Stack([
    ...base.files,
    ["entries/a.md", encode("# A\n")],
    ["assets/notes.txt", encode("plain")],
    ["assets/config.yaml", encode("k: v\n")],
  ]);
  assert.equal(canEdit(s, "entries/a.md"), true);
  for (const p of ["assets/notes.txt", "assets/config.yaml", "stack.yaml"]) assert.equal(canEdit(s, p), false, p);
  assert.equal(defaultDocument(s), "entries/a.md");
});

test("the first file to open prefers Markdown, then any editable text, else none", () => {
  assert.equal(defaultDocument(folder({ "a.json": "{}", "z.md": "# Z" })), "z.md");
  assert.equal(defaultDocument(folder({ "bin.dat": new Uint8Array([0]), "b.txt": "b" })), "b.txt");
  assert.equal(defaultDocument(folder({ "bin.dat": new Uint8Array([0]) })), null);
  assert.equal(defaultDocument(folder({})), null);
});

test("plain text is never parsed as frontmatter, Markdown links or wiki links", async () => {
  const yaml = "---\nid: [broken\n---\n[[a]] and [link](a.md)\n";
  const f = folder({ "a.md": "# A\n", "config.yaml": yaml, "notes.txt": "see [[a]]\n", "b.md": "see [[a]]\n" });
  assert.deepEqual(entryFor(f, yaml, "config.yaml"), { data: {}, body: yaml, frontmatter: "" });
  // Even a well-formed leading YAML block is file content, not metadata, outside Markdown.
  const valid = "---\ntitle: Not metadata\n---\nkey: value\n";
  assert.deepEqual(entryFor(f, valid, "settings.yml"), { data: {}, body: valid, frontmatter: "" });
  assert.equal(entryFor(f, valid, "note.md").data.title, "Not metadata");
  assert.equal(isMarkdown("config.yaml"), false);
  assert.equal(isMarkdown("NOTE.MD"), true);
  // Backlinks and resolution consider Markdown documents only.
  assert.deepEqual([...backlinkedEntries(f, "a.md")], ["b.md"]);
  assert.equal(resolveEntry(f, "notes"), null);
  assert.equal(resolveEntry(f, "config"), null);
  // Palette content search keeps its Markdown scope (RFC D10).
  const index = await buildIndex({ stack: f, drafts: new Map() });
  assert.deepEqual(index.records.map((r) => r.path), ["a.md", "b.md"]);
});

test("line-ending conventions and a BOM are detected from committed text", () => {
  const cases = [
    ["", "none", false],
    ["one line", "none", false],
    ["a\nb\n", "lf", false],
    ["a\r\nb\r\n", "crlf", false],
    ["a\rb\r", "cr", false],
    [`${BOM}a\r\nb`, "crlf", true],
    ["a\r\nb\n", "mixed", false],
    ["a\rb\n", "mixed", false],
    ["a\r\nb\rc", "mixed", false],
  ];
  for (const [source, eol, bom] of cases) {
    const format = textFormat(source);
    assert.equal(format.eol, eol, JSON.stringify(source));
    assert.equal(format.bom, bom, JSON.stringify(source));
  }
  assert.equal(describeLineEndings(textFormat("a\r\nb\r\nc\nd\re")), "2 CRLF, 1 LF, 1 CR");
});

test("uniform LF, CRLF and lone-CR files, with or without a BOM, round-trip byte for byte", () => {
  for (const [eol, label] of [["\n", "LF"], ["\r\n", "CRLF"], ["\r", "CR"]]) {
    for (const bom of [false, true]) {
      const original = (bom ? BOM : "") + ["first", "second", "third", ""].join(eol);
      const f = folder({ "f.txt": original, "g.md": original });
      for (const p of ["f.txt", "g.md"]) {
        const name = `${label}${bom ? "+BOM" : ""} ${p}`;
        const text = toEditorText(f.text(p));
        assert.equal(text, "first\nsecond\nthird\n", `${name}: the editor holds LF without a BOM`);
        assert.equal(sourceFor(f, text, f.text(p)), original, `${name}: unchanged text is no draft`);
        const draft = sourceFor(f, text.replace("second", "2nd"), f.text(p));
        const expected = (bom ? BOM : "") + ["first", "2nd", "third", ""].join(eol);
        assert.equal(draft, expected, `${name}: only the edited line changes`);
        assert.deepEqual(saveBytes(f, p, draft), encode(expected), name);
        // A stored draft shows in the editor exactly as typed.
        assert.equal(toEditorText(draft), "first\n2nd\nthird\n", name);
        // Committed bytes keep the BOM and conventions, so the file stays editable and re-saves the same way.
        const saved = f.change({ writes: new Map([[p, saveBytes(f, p, draft)]]) });
        assert.equal(decode(saved.files.get(p)), expected, name);
        assert.equal(sourceFor(saved, toEditorText(saved.text(p)), saved.text(p)), expected, name);
      }
    }
  }
  // A file without line breaks gets LF when lines are added. A leading U+FEFF is a byte-order mark:
  // whether the saved file has one follows the committed file, never the draft.
  const f = folder({ "one.txt": "one", "plain.txt": "x" });
  assert.equal(sourceFor(f, "one\ntwo", f.text("one.txt")), "one\ntwo");
  assert.equal(toEditorText(`${BOM}typed`), "typed");
  assert.deepEqual(saveBytes(f, "plain.txt", `${BOM}typed`), encode("typed"));
});

test("a draft kept across a change of the committed file saves with the file's current conventions", () => {
  // Typed against a mixed file (so the draft is LF), then the file became uniform CRLF with a BOM.
  const before = folder({ "b.txt": "a\r\nb\nc" });
  const draft = sourceFor(before, "a\nb\nc\nd", before.text("b.txt"));
  assert.equal(draft, "a\nb\nc\nd");
  const after = before.change({ writes: new Map([["b.txt", encode(`${BOM}a\r\nb\r\nc`)]]) });
  assert.deepEqual(saveBytes(after, "b.txt", draft), encode(`${BOM}a\r\nb\r\nc\r\nd`), "no LF rewrite without the choice");
  // The BOM follows the committed file both ways.
  const withBom = folder({ "c.txt": `${BOM}x\n` });
  const bomDraft = sourceFor(withBom, "x\ny\n", withBom.text("c.txt"));
  const dropped = withBom.change({ writes: new Map([["c.txt", encode("x\n")]]) });
  assert.deepEqual(saveBytes(dropped, "c.txt", bomDraft), encode("x\ny\n"));
  // And a file that became mixed refuses the old uniform draft until LF is chosen.
  const mixed = dropped.change({ writes: new Map([["c.txt", encode("x\r\ny\n")]]) });
  assert.throws(() => saveBytes(mixed, "c.txt", bomDraft), MixedLineEndingsError);
  // Re-deriving is idempotent for a draft typed against the current file.
  const crlf = folder({ "d.md": "---\r\ntitle: T\r\n---\r\nbody\r\n" });
  const current = sourceFor(crlf, "---\ntitle: T\n---\nbody\nmore\n", crlf.text("d.md"));
  assert.deepEqual(saveBytes(crlf, "d.md", current), encode(current));
});

test("mixed line endings are never rewritten implicitly; the explicit LF choice keeps a BOM", () => {
  const original = `${BOM}a\r\nb\nc\rd`;
  const f = folder({ "mixed.txt": original });
  const text = toEditorText(f.text("mixed.txt"));
  assert.equal(text, "a\nb\nc\nd");
  const draft = sourceFor(f, `${text}!`, f.text("mixed.txt"));
  assert.throws(() => saveBytes(f, "mixed.txt", draft), (e) => {
    assert.ok(e instanceof MixedLineEndingsError);
    assert.equal(e.path, "mixed.txt");
    assert.match(e.message, /mixes line endings \(1 CRLF, 1 LF, 1 CR\).*Nothing was saved; your draft is kept/);
    return true;
  });
  assert.equal(decode(saveBytes(f, "mixed.txt", draft, { lf: true })), `${BOM}a\nb\nc\nd!`);
  // Undoing every edit still leaves an LF draft: Save refuses it rather than silently normalizing.
  assert.notEqual(sourceFor(f, text, f.text("mixed.txt")), original);
  assert.throws(() => saveBytes(f, "mixed.txt", sourceFor(f, text, f.text("mixed.txt"))), MixedLineEndingsError);
});

test("saving from the Editor requires bounded text without NUL for every file, not only Markdown", () => {
  const f = folder({ "a.txt": "a", "b.json": "{}" });
  assert.throws(() => saveBytes(f, "a.txt", "a\0b"), /Text limit or NUL violation.*Nothing was saved; your draft is kept/);
  assert.throws(() => saveBytes(f, "b.json", "x".repeat(LIMITS.text + 1)), /Text limit or NUL violation/);
  assert.equal(saveBytes(f, "a.txt", "x".repeat(LIMITS.text)).length, LIMITS.text);
  // Non-editor writes (image bytes) still go through change() unvalidated, as before.
  assert.deepEqual(f.change({ writes: new Map([["img.png", new Uint8Array([0, 1])]]) }).files.get("img.png"), new Uint8Array([0, 1]));
});

test("Stack Entries keep exact frontmatter bytes and also keep BOM and lone-CR conventions", () => {
  const base = newStack("Strict");
  const front = "---\r\nid: ent-1\r\ntitle: A\r\n---\r\n";
  const s = new Stack([
    ...base.files,
    ["entries/crlf.md", encode(`${front}# A\r\nbody\r\n`)],
    ["entries/bom.md", encode(`${BOM}# B\nbody\n`)],
    ["entries/cr.md", encode("# C\rbody\r")],
  ]);
  for (const [p, edit, expected] of [
    ["entries/crlf.md", (t) => t.replace("body", "changed"), `${front}# A\r\nchanged\r\n`],
    ["entries/bom.md", (t) => t.replace("body", "changed"), `${BOM}# B\nchanged\n`],
    ["entries/cr.md", (t) => t.replace("body", "changed"), "# C\rchanged\r"],
  ]) {
    const text = toEditorText(s.text(p));
    assert.equal(text.includes("\r") || text.startsWith(BOM), false, p);
    assert.equal(sourceFor(s, text, s.text(p)), s.text(p), `${p}: unchanged`);
    const draft = sourceFor(s, edit(text), s.text(p));
    assert.equal(draft, expected, p);
    assert.equal(decode(s.change({ writes: new Map([[p, saveBytes(s, p, draft)]]) }).files.get(p)), expected, p);
  }
});

test("new ordinary files may have any safe name; Stack Entries still need .md", () => {
  const f = folder({ "Notes.txt": "x", "dir/a.md": "# A" });
  for (const p of ["notes/today.txt", "README", "a.py", "config.yaml", "dir/b.json"])
    assert.equal(assertNewPath(f, p, false, { text: true }), p);
  for (const [p, message] of [
    ["notes.TXT", /Already exists/],
    ["../x.txt", /Unsafe path/],
    ["con.txt", /Unsafe path/],
    [".git/config", /Unsafe path/],
    ["Notes.txt/inner", /Already exists|collision|conflict/i],
  ])
    assert.throws(() => assertNewPath(f, p, false, { text: true }), message, p);
  assert.throws(() => assertNewPath(f, "todo.txt"), /must end in \.md/);
  // An ordinary folder's suggestion goes to its root unless it already has an Entries directory.
  assert.match(suggestPath(f, "note", new Date(2026, 9, 25), { parent: "" }), /^note-20261025-001\.md$/);
  assert.match(suggestPath(folder({ "Entries/x.md": "# X" }), "note", new Date(2026, 9, 25), { parent: "" }), /^Entries\/note-20261025-001\.md$/);
  assert.match(suggestPath(f, "note", new Date(2026, 9, 25)), /^entries\/note-20261025-001\.md$/);
});

test("tabs for editable text survive reconciliation; unreadable files never become Editor tabs", () => {
  const f = folder({ "a.txt": "a", "b.yaml": "k: v", "c.bin": new Uint8Array([0]) });
  const m = workspaceState(f, "a.txt", { stackId: f.manifest.id, editors: ["a.txt", "b.yaml", "c.bin"], viewers: [] });
  assert.deepEqual(m.editors, ["a.txt", "b.yaml"]);
});

/** A linked folder over the fake directory handle, as linked.test.js builds it (Save is virtual; Sync writes the folder). */
async function linked(files) {
  const fs = fakeFolder(files, { name: "Research" });
  const read = await readDirectoryFiles(fs.root);
  const state = createState();
  state.stack = new LocalFolder(read.files, read.directories, { title: "Research" });
  state.link = { ...newLink(fs.root, null, state.stack, read), consent: { granted: true, remember: false, history: true } };
  state.copyState = "imported";
  state.unexported = false;
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
    modal: async () => null,
    confirm: async () => true,
    render: () => {},
    diskHistory: async () => ({ preserve: async () => ({ id: "h" }) }),
    now: () => new Date("2026-10-25T10:00:00Z"),
  };
  /** Save the draft of `path` in Carbon exactly as the Editor does (text guard, History, draft cleared). */
  const save = async (path, { lf = false } = {}) => {
    const bytes = saveBytes(state.stack, path, state.drafts.get(path), { lf });
    const history = new History([...state.history.items]);
    history.push(state.stack, `Before saving ${path}`);
    const drafts = new Map(state.drafts);
    drafts.delete(path);
    await deps.commit({ stack: state.stack.change({ writes: new Map([[path, bytes]]) }), history, drafts, unexported: true, copyState: "pending" });
    return bytes;
  };
  return { fs, state, deps, notices, save };
}

test("linked folders: Save keeps a text file's conventions in Carbon and writes nothing; Sync writes exactly those bytes", async () => {
  const s = await linked({ "notes.txt": `${BOM}one\r\ntwo\r\n`, "a.md": "# A\n" });
  assert.equal(canEdit(s.state.stack, "notes.txt"), true);
  const text = toEditorText(s.state.stack.text("notes.txt"));
  s.state.drafts.set("notes.txt", sourceFor(s.state.stack, text.replace("two", "2"), s.state.stack.text("notes.txt")));
  await s.save("notes.txt");
  assert.deepEqual(s.state.stack.files.get("notes.txt"), encode(`${BOM}one\r\n2\r\n`));
  assert.deepEqual(s.fs.bytes("notes.txt"), encode(`${BOM}one\r\ntwo\r\n`), "the folder is untouched by Save");
  assert.equal(s.fs.ctl.writes.length + s.fs.ctl.creates, 0);
  assert.equal(s.state.drafts.has("notes.txt"), false);
  const r = await syncFile(s.deps, "notes.txt");
  assert.equal(r.ok, true);
  assert.deepEqual(s.fs.bytes("notes.txt"), encode(`${BOM}one\r\n2\r\n`));
});

test("linked: a draft kept across Take folder version saves with the taken file's conventions", async () => {
  const s = await linked({ "b.txt": "a\r\nb\n" });
  s.state.current = "b.txt";
  s.state.drafts.set("b.txt", sourceFor(s.state.stack, "a\nb\nmine\n", s.state.stack.text("b.txt")));
  s.fs.put("b.txt", "a\r\nb\r\n"); // fixed outside Carbon: uniform CRLF now
  await refreshFolder(s.deps);
  await takeDiskVersion(s.deps, "b.txt");
  assert.equal(s.state.stack.text("b.txt"), "a\r\nb\r\n");
  assert.ok(s.state.drafts.has("b.txt"), "the draft survives");
  const bytes = await s.save("b.txt");
  assert.equal(decode(bytes), "a\r\nb\r\nmine\r\n", "the draft took the taken file's CRLF convention");
  assert.equal(s.fs.text("b.txt"), "a\r\nb\r\n", "still nothing written");
  await syncFile(s.deps, "b.txt");
  assert.equal(s.fs.text("b.txt"), "a\r\nb\r\nmine\r\n");
});

const UNREADABLE = [["NUL", new Uint8Array([0x61, 0, 0x62])], ["invalid UTF-8", new Uint8Array([0xff, 0xfe])], ["over 1 MiB", new Uint8Array(LIMITS.text + 1).fill(0x61)]];

test("linked: Take folder version never adopts unreadable bytes while a draft exists", async () => {
  for (const p of ["notes.txt", "note.md"])
    for (const [label, bytes] of UNREADABLE) {
      const s = await linked({ [p]: "one\n", "other.md": "keep\n" });
      s.state.current = p;
      s.state.drafts.set(p, "one\nmine\n");
      s.fs.put(p, bytes);
      await refreshFolder(s.deps);
      const stack = s.state.stack;
      await assert.rejects(takeDiskVersion(s.deps, p), /can no longer be edited as text.*not taken: Carbon's copy and your draft are unchanged/, `${p} ${label}`);
      assert.equal(s.state.stack, stack, `${p} ${label}: nothing committed`);
      assert.equal(canEdit(s.state.stack, p), true, `${p} ${label}`);
      assert.equal(s.state.drafts.get(p), "one\nmine\n", `${p} ${label}`);
    }
});

test("linked: Take folder version without a draft adopts unreadable bytes read-only, Markdown included", async () => {
  for (const p of ["notes.txt", "note.md", "dir/Deep.MD"])
    for (const [label, bytes] of UNREADABLE) {
      const s = await linked({ [p]: "one\n", "other.md": "keep\n" });
      s.state.current = p;
      s.fs.put(p, bytes);
      await refreshFolder(s.deps);
      const before = s.state.stack;
      await takeDiskVersion(s.deps, p);
      const next = s.state.stack;
      assert.notEqual(next, before, `${p} ${label}: a new revision`);
      assert.deepEqual(next.files.get(p), bytes, `${p} ${label}: exact disk bytes`);
      assert.equal(canEdit(next, p), false, `${p} ${label}: read-only from now on`);
      assert.equal(next.manifest.id, before.manifest.id, `${p} ${label}`);
      assert.equal(next.manifest.revision, before.manifest.revision + 1, `${p} ${label}`);
      assert.deepEqual([...next.files.keys()], [...before.files.keys()], `${p} ${label}: same files, same order`);
      assert.deepEqual([...next.directories], [...before.directories], `${p} ${label}`);
      assert.deepEqual(next.files.get("other.md"), before.files.get("other.md"), `${p} ${label}`);
      assert.equal(s.state.history.items.at(-1).stack, before, `${p} ${label}: previous revision in History`);
      assert.equal(s.state.drafts.size, 0, `${p} ${label}`);
      assert.match(s.notices.at(-1).m, /^Took the folder's version of .+\. The previous version is in History\.$/, `${p} ${label}`);
      assert.equal(s.fs.ctl.writes.length + s.fs.ctl.creates, 0, `${p} ${label}: nothing written`);
      // Editor writes are still validated: the unreadable baseline cannot be re-saved as a Markdown edit.
      if (isMarkdown(p) && label !== "over 1 MiB") assert.throws(() => next.change({ writes: new Map([[p, bytes]]) }), undefined, `${p} ${label}`);
    }
});

test("linked: Take folder version keeps the folder bounds and changes nothing when they would break", async () => {
  const big = () => new Uint8Array(LIMITS.file).fill(0x61);
  const s = await linked({ "a.bin": big(), "b.bin": big(), "c.bin": big(), "d.bin": new Uint8Array(LIMITS.file - LIMITS.text), "note.md": "one\n" });
  s.fs.put("note.md", new Uint8Array(2 * LIMITS.text).fill(0xff)); // unreadable and pushes the folder over its total limit
  await assert.rejects(refreshFolder(s.deps), /Could not read the folder \(Folder size limit exceeded\)/);
  const before = s.state.stack;
  await assert.rejects(takeDiskVersion(s.deps, "note.md"), /changed in the folder since the last Refresh/, "the stale observation refuses first");
  s.state.link = { ...s.state.link, observed: null }; // no observation: a confirmed preview supplies the bytes, and the folder bounds are the last guard
  await assert.rejects(takeDiskVersion(s.deps, "note.md", { expected: s.fs.bytes("note.md") }), /Could not take note\.md from the folder \(Taking the folder's version of note\.md would take the folder.*past Carbon's folder limits.*Nothing was taken\..*\)\. Carbon's copy is unchanged\.$/);
  assert.equal(s.state.stack, before);
  assert.equal(s.state.history.items.length, 0);
});

test("LocalFolder.change still validates Markdown writes from the Editor", () => {
  const f = folder({ "note.md": "# Note\n" });
  for (const [label, bytes] of UNREADABLE) assert.throws(() => f.change({ writes: new Map([["note.md", bytes]]) }), undefined, label);
  assert.deepEqual(f.change({ writes: new Map([["notes.txt", new Uint8Array([0, 0xff])]]) }).files.get("notes.txt"), new Uint8Array([0, 0xff]));
});

test("palette search offsets refer to the Editor's text, so BOM-prefixed Markdown navigates", async () => {
  const f = folder({ "bom.md": `${BOM}---\ntitle: Kept as body\n---\n# Heading\r\nneedle here\r\n` });
  const index = await buildIndex({ stack: f, drafts: new Map() });
  const [record] = index.records;
  assert.equal(record.source, toEditorText(f.text("bom.md")));
  assert.equal(record.source.indexOf("needle"), "---\ntitle: Kept as body\n---\n# Heading\n".length);
  // Metadata still reads the stored text: after a BOM the block is not frontmatter (unchanged).
  assert.equal(record.label, "Heading");
});

test("linked: a mixed-ending file is saved only by the explicit LF choice, in Carbon; Sync writes the committed bytes, never a draft", async () => {
  const s = await linked({ "mixed.txt": "a\r\nb\n" });
  const draft = sourceFor(s.state.stack, "a\nb\nc", s.state.stack.text("mixed.txt"));
  s.state.drafts.set("mixed.txt", draft);
  await assert.rejects(() => s.save("mixed.txt"), MixedLineEndingsError);
  await assert.rejects(() => syncFile(s.deps, "mixed.txt"), /Save or discard the draft/);
  assert.equal(s.fs.ctl.writes.length + s.fs.ctl.creates, 0);
  assert.equal(s.fs.text("mixed.txt"), "a\r\nb\n");
  await s.save("mixed.txt", { lf: true });
  assert.equal(s.state.stack.text("mixed.txt"), "a\nb\nc");
  assert.equal(s.fs.text("mixed.txt"), "a\r\nb\n", "Save in Carbon writes nothing");
  await syncFile(s.deps, "mixed.txt");
  assert.equal(s.fs.text("mixed.txt"), "a\nb\nc");
});
