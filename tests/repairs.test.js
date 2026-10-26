import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  Stack,
  newStack,
  History,
  sameStack,
  restoreRevision,
  restoreSnapshot,
  directoryDiff,
} from "../src/core/stack.js";
import { encode, path } from "../src/core/validate.js";
import { writeTar, readTar, archiveRoot } from "../src/archives/tar.js";
import {
  resolveEntry,
  backlinkedEntries,
  scanWikiLinks,
  wikiTargets,
} from "../src/carbon/markdown.js";
import { sample } from "./helpers.js";

/** Minimal Stack with a given id and revision; `# keep` proves the manifest patch is narrow. */
const stackAt = (id, revision, extra = "") =>
  new Stack([
    [
      "stack.yaml",
      encode(
        `format: envoy.stack/v0.2\nid: ${id}\nrevision: ${revision} # keep\n${extra}`,
      ),
    ],
  ]);
const linked = (files) =>
  newStack("Links").change({
    writes: new Map(files.map(([p, text]) => [p, encode(text)])),
  });

// CB-2 — History restore keeps revisions monotonic per Stack id.
test("CB-2 restoring an older snapshot of a Stack left in History continues its highest revision", () => {
  const history = new History();
  const a3 = stackAt("stk-a", 3);
  history.push(a3, "Before saving Entry"); // A r3 retained
  const a5 = stackAt("stk-a", 5);
  history.push(a5, "Before importing full Stack"); // switched to B; A r5 retained
  const b = stackAt("stk-b", 0);
  // Before the fix this restore produced r4, which an archive of A r5 already exceeded.
  assert.equal(restoreRevision(b, history, a3), 6);
  const restored = restoreSnapshot(b, history, a3);
  assert.equal(restored.manifest.id, "stk-a");
  assert.equal(restored.manifest.revision, 6);
  assert.match(restored.text("stack.yaml"), /revision: 6 # keep/);
});
test("CB-2 same-id restore exceeds active, restored and every retained revision", () => {
  const history = new History();
  history.push(stackAt("stk-a", 3), "x");
  history.push(stackAt("stk-a", 7), "y");
  const active = stackAt("stk-a", 5);
  assert.equal(restoreRevision(active, history, history.items[0].stack), 8);
  assert.equal(restoreRevision(active, history, history.items[1].stack), 8);
  assert.equal(
    restoreSnapshot(active, history, history.items[0].stack).manifest.revision,
    8,
  );
  // Old behaviour (max(active, old) + 1) is still the answer when History holds nothing newer.
  assert.equal(restoreRevision(active, new History(), stackAt("stk-a", 3)), 6);
  assert.equal(restoreRevision(active, new History(), stackAt("stk-a", 9)), 10);
});
test("CB-2 different-id restore ignores the active Stack and only its own History items", () => {
  const history = new History();
  history.push(stackAt("stk-a", 3), "x");
  history.push(stackAt("stk-other", 40), "y");
  const active = stackAt("stk-b", 9);
  assert.equal(restoreRevision(active, history, stackAt("stk-a", 3)), 4);
  assert.equal(restoreRevision(active, history, stackAt("stk-a", 2)), 4);
  const s = sample();
  const restored = restoreSnapshot(active, new History(), s);
  assert.equal(restored.manifest.revision, 4);
  assert.deepEqual([...restored.directories], [...s.directories]);
  assert.deepEqual(restored.files.get("assets/bytes.bin"), s.files.get("assets/bytes.bin"));
  assert.match(restored.text("stack.yaml"), /# keep manifest comment/);
  assert.throws(
    () => restoreRevision(active, history, stackAt("stk-a", Number.MAX_SAFE_INTEGER)),
    /exhausted/,
  );
});

// CB-3 — stable IDs beat path/basename aliases.
test("CB-3 an Entry file named after another Entry's stable ID does not make the ID ambiguous", () => {
  const stack = linked([
    ["entries/a.md", "---\nid: ent-a\n---\nA"],
    ["entries/ent-a.md", "Basename impostor [[ent-a]]"],
    ["notes/b.md", "[[ent-a]] [[ent-a|label]]"],
  ]);
  // Before the fix both resolutions were null and the backlink list was empty.
  assert.equal(resolveEntry(stack, "ent-a", "notes/b.md"), "entries/a.md");
  assert.equal(resolveEntry(stack, "ent-a|label", "entries/ent-a.md"), "entries/a.md");
  assert.deepEqual(backlinkedEntries(stack, "entries/a.md").sort(), [
    "entries/ent-a.md",
    "notes/b.md",
  ]);
  assert.deepEqual(backlinkedEntries(stack, "entries/ent-a.md"), []);
  // Path and basename aliases still reach the impostor when they are unambiguous.
  assert.equal(resolveEntry(stack, "entries/ent-a.md"), "entries/ent-a.md");
  assert.equal(resolveEntry(stack, "entries/ent-a"), "entries/ent-a.md");
  assert.equal(resolveEntry(stack, "./ent-a.md", "entries/a.md"), "entries/ent-a.md");
});
test("CB-3 ambiguous aliases without a stable ID still resolve to null and index no backlink", () => {
  const stack = linked([
    ["entries/a.md", "---\nid: ent-a\n---\nA"],
    ["other/a.md", "Other A"],
    ["entries/dup.md", "First"],
    ["other/dup.md", "Second"],
    ["notes/b.md", "[[dup]] [[a]]"],
  ]);
  assert.equal(resolveEntry(stack, "dup", "notes/b.md"), null);
  assert.equal(resolveEntry(stack, "a", "notes/b.md"), null);
  assert.equal(resolveEntry(stack, "missing"), null);
  assert.deepEqual(backlinkedEntries(stack, "entries/dup.md"), []);
  assert.deepEqual(backlinkedEntries(stack, "other/dup.md"), []);
  assert.deepEqual(backlinkedEntries(stack, "entries/a.md"), []);
  // Relative resolution breaks the tie from a sibling, as before.
  assert.equal(resolveEntry(stack, "./dup.md", "other/x.md"), "other/dup.md");
});

// CB-5 — literal code is not a link.
test("CB-5 scanWikiLinks skips fenced blocks, inline code and escapes but keeps ordinary links", () => {
  const body = [
    "Intro [[one]] and [[two|Two]].",
    "```md",
    "[[fenced]]",
    "```",
    "Text `[[inline]]` and ``code with ` tick [[inline2]]`` end [[three]].",
    "Escaped \\[[four]] and \\`[[five]]` literal tick.",
    "~~~",
    "[[tilde]]",
    "~~~~",
    "   ````",
    "[[long]]",
    "```",
    "````",
    "Span crosses `a",
    "[[six]] b` line [[seven]].",
    "```",
    "[[unclosed]] fence swallows the rest",
    "[[eight]]",
  ].join("\n");
  const links = scanWikiLinks(body);
  // Before the fix every bracketed form above was reported, including [[fenced]].
  assert.deepEqual(
    links.map((x) => x.target),
    ["one", "two|Two", "three", "five", "seven"],
  );
  for (const { target, start, end } of links)
    assert.equal(body.slice(start, end), `[[${target}]]`);
  assert.deepEqual(scanWikiLinks("`unterminated [[nine]]"), [
    { target: "nine", start: 14, end: 22 },
  ]);
  assert.deepEqual(scanWikiLinks("``` [[ten]]\n").map((x) => x.target), []);
  assert.deepEqual(scanWikiLinks("```a`b\n[[eleven]]").map((x) => x.target), ["eleven"]);
  assert.deepEqual(
    scanWikiLinks("    ```\n[[indented]]\n").map((x) => x.target),
    ["indented"],
  );
  assert.deepEqual(scanWikiLinks("CRLF\r\n```\r\n[[x]]\r\n```\r\n[[y]]\r\n").map((x) => x.target), ["y"]);
});
test("CB-5 wikiTargets skips frontmatter and backlinks ignore code", () => {
  assert.deepEqual(
    wikiTargets("---\nid: ent-x\nsee: [[front]]\n---\n[[body]]\n```\n[[code]]\n```\n"),
    ["body"],
  );
  const stack = linked([
    ["entries/a.md", "---\nid: ent-a\n---\nA"],
    ["entries/b.md", "---\nid: ent-b\n---\nB"],
    ["entries/c.md", "Real [[ent-a]]\n\n```\n[[ent-b]]\n```\n`[[ent-b]]`"],
  ]);
  assert.deepEqual(backlinkedEntries(stack, "entries/a.md"), ["entries/c.md"]);
  // Before the fix entries/c.md was a backlink of entries/b.md.
  assert.deepEqual(backlinkedEntries(stack, "entries/b.md"), []);
});

// CB-4 — Windows reserved names as Stack ids produce a readable archive.
test("CB-4 reserved-name Stack ids export and reimport; ordinary ids keep <id>.stack byte-for-byte", () => {
  for (const id of [
    "CON",
    "con",
    "PRN",
    "AUX",
    "Aux",
    "NUL",
    "COM1",
    "LPT9",
    "con.suffix",
    "Com1.x.y",
  ]) {
    const root = archiveRoot(id);
    assert.equal(root, `envoy-${id}.stack`);
    path(root, { archive: true });
    const s = stackAt(id, 2, "title: Reserved\n").change({
      writes: new Map([["entries/x.md", encode("---\nid: ent-x\n---\nX")]]),
      directories: new Set(["empty"]),
    });
    // Before the fix writeTar produced CON.stack/…, which readTar rejects as unsafe.
    const tar = writeTar(s);
    assert.ok(sameStack(s, readTar(tar)), id);
    assert.equal(readTar(tar).manifest.id, id);
    assert.equal(
      new TextDecoder().decode(tar.subarray(0, 100)).replace(/\0+$/, ""),
      `envoy-${id}.stack/`,
    );
  }
  for (const id of ["stk-test", "console", "CONTRACT", "aux-notes", "x"])
    assert.equal(archiveRoot(id), `${id}.stack`);
  assert.throws(() => archiveRoot("CONIN$"), /ID/); // "$" is not a legal Stack id
  assert.throws(() => archiveRoot("../x"), /ID/);
  assert.equal(
    createHash("sha256").update(writeTar(sample())).digest("hex"),
    "3c5dc6533615bb35677b7686ad64b7130efaac2cc9cbdcae3bad58cd9c48317c",
  );
  assert.equal(
    new TextDecoder().decode(writeTar(sample()).subarray(0, 100)).replace(/\0+$/, ""),
    "stk-test.stack/",
  );
});

// CB-6 — empty-directory changes for the full-Stack import preview.
test("CB-6 directoryDiff reports only explicit empty leaf folders that differ", () => {
  const base = newStack("Dirs");
  const dirs = (stack, list) =>
    stack.change({ directories: new Set([...stack.directories, ...list]) });
  const current = dirs(base, ["keep", "gone", "parent/child", "becomes-full"]);
  const next = dirs(base, ["keep", "added", "deep/a/b", "parent"]).change({
    writes: new Map([["becomes-full/note.md", encode("Now a file lives here")]]),
  });
  assert.deepEqual(directoryDiff(current, next), {
    added: ["added", "deep/a/b", "parent"],
    removed: ["becomes-full", "gone", "parent/child"],
  });
  assert.deepEqual(directoryDiff(current, current), { added: [], removed: [] });
  assert.deepEqual(directoryDiff(next, current), {
    added: ["becomes-full", "gone", "parent/child"],
    removed: ["added", "deep/a/b", "parent"],
  });
  // Directories implied by files never appear.
  const files = base.change({
    writes: new Map([["entries/nested/note.md", encode("x")]]),
  });
  assert.deepEqual(directoryDiff(base, files), { added: [], removed: [] });
  // The sample fixture carries exactly one empty folder.
  assert.deepEqual(directoryDiff(base, sample()), { added: ["empty"], removed: [] });
});
