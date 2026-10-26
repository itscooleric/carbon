import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { newStack, Stack, sameStack } from "../src/core/stack.js";
import { entry } from "../src/core/entries.js";
import {
  localDate,
  suggestPath,
  suggestStackName,
  assertNewPath,
} from "../src/core/naming.js";
import { encode, path } from "../src/core/validate.js";
import { writeTar, readTar } from "../src/archives/tar.js";
import { gzip, gunzip } from "../src/archives/gzip.js";
import { dispatch, propose, diffLines } from "../src/core/handoff.js";
import { resolveTheme } from "../src/carbon/theme.js";
import { resolveEntry, backlinkedEntries } from "../src/carbon/markdown.js";
import { sample } from "./helpers.js";
const date = new Date(2026, 9, 19, 23, 59);

test("names use local calendar dates on both sides of UTC midnight", () => {
  assert.equal(localDate(date), "20261019");
  const run = (tz) =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {localDate} from "./src/core/naming.js"; console.log(localDate(new Date("2026-10-20T03:30:00Z")))',
      ],
      { env: { ...process.env, TZ: tz }, encoding: "utf8" },
    ).trim();
  assert.equal(run("America/Los_Angeles"), "20261019");
  assert.equal(run("Pacific/Auckland"), "20261020");
  assert.equal(localDate(new Date(2026, 0, 2)), "20260102");
});
test("Stack suggestions retry case-insensitive name collisions; IDs stay independent", () => {
  let calls = 0;
  const title = suggestStackName(["STACK-20261019-aaaaaaaa"], date, () =>
    ++calls === 1 ? "aaaaaaaa" : "bbbbbbbb",
  );
  assert.equal(title, "stack-20261019-bbbbbbbb");
  assert.equal(calls, 2);
  const a = newStack(title),
    b = newStack(title);
  assert.notEqual(a.manifest.id, b.manifest.id);
  assert.notEqual(a.manifest.id, title);
  assert.match(newStack().manifest.title, /^stack-\d{8}-[a-f0-9]{8}$/);
  assert.throws(
    () => suggestStackName([title], date, () => "bbbbbbbb"),
    /unique/,
  );
});
test("repeated typed creation never overwrites and survives complete archives", async () => {
  let stack = newStack("Naming test");
  for (const kind of [
    "note",
    "research",
    "mission",
    "meeting",
    "requirement",
    "transcript",
  ]) {
    for (let n = 1; n <= 5; n++) {
      const p = suggestPath(stack, kind, date);
      assert.equal(
        p,
        `entries/${kind}-20261019-${String(n).padStart(3, "0")}.md`,
      );
      path(p);
      stack = stack.change({
        writes: new Map([
          [p, encode(`---\nid: ent-${kind}-${n}\n---\n# ${kind} ${n}\n`)],
        ]),
      });
    }
  }
  for (let n = 1; n <= 3; n++) {
    const p = suggestPath(stack, "folder", date);
    assert.equal(p, `entries/folder-20261019-00${n}`);
    stack = stack.change({ directories: new Set([...stack.directories, p]) });
  }
  assert.equal(stack.files.size, 31);
  assert.ok(sameStack(stack, readTar(writeTar(stack))));
  assert.ok(
    sameStack(stack, readTar(await gunzip(await gzip(writeTar(stack))))),
  );
});
test("suggestions skip files, directories, implied directories and case collisions", () => {
  const base = newStack("Collisions");
  const stack = new Stack(
    [
      ...base.files,
      ["Entries/NOTE-20261019-001.MD", encode("Keep me")],
      ["Entries/note-20261019-002.md/child.txt", encode("asset")],
    ],
    ["Entries/note-20261019-003.md"],
  );
  assert.equal(
    suggestPath(stack, "note", date),
    "Entries/note-20261019-004.md",
  );
  assert.throws(
    () => assertNewPath(stack, "Entries/note-20261019-001.md"),
    /exists/,
  );
  assert.throws(() => assertNewPath(stack, "entries/new.md"), /collision/);
  assert.throws(() => assertNewPath(stack, "../escape.md"), /Unsafe/);
  assert.throws(() => assertNewPath(stack, "CON.md"), /Unsafe/);
  assert.throws(
    () => assertNewPath(stack, "Entries/note-20261019-003.md", true),
    /exists/,
  );
  assert.equal(stack.text("Entries/NOTE-20261019-001.MD"), "Keep me");
  const blocked = new Stack([...base.files, ["entries", encode("asset")]]);
  assert.equal(suggestPath(blocked, "note", date), "note-20261019-001.md");
});
test("leading thematic break imports as exact plain Markdown through TAR and gzip", async () => {
  for (const text of ["---\n# Heading\nBody", "---\r\n# Heading\r\nBody"]) {
    assert.equal(entry(text).body, text);
    assert.equal(entry(text).frontmatter, "");
    const stack = newStack("Plain Markdown").change({
      writes: new Map([["entries/plain.md", encode(text)]]),
    });
    assert.ok(
      sameStack(stack, readTar(await gunzip(await gzip(writeTar(stack))))),
    );
  }
  assert.throws(() => entry("---\nid: [broken\n---\nBody"), /YAML/);
  const managed = sample();
  assert.throws(
    () =>
      managed.change({
        writes: new Map([
          [
            "entries/nested/note.md",
            encode("---\nid: ent-note\nMissing close"),
          ],
        ]),
      }),
    /ID/,
  );
});
test("Returns reject all frontmatter changes, addition, removal and byte normalization", () => {
  const stack = sample(),
    packet = dispatch(stack);
  for (const returned of [
    packet.text.replace("kind: research", "kind: mission"),
    packet.text.replace("custom: yes", "custom: no"),
    packet.text.replace("# keep comment", "# changed comment"),
    packet.text.replace("id: ent-note # stable", "id: ent-note # new comment"),
    packet.text.replace("---\nid: ent-note", "---\r\nid: ent-note"),
    packet.text.replace(
      "---\nid: ent-note # stable\n# keep comment\nkind: research\nunknown:\n  custom: yes\n---\n",
      "",
    ),
    packet.text.replace("# Plain note", "---\nkind: note\n---\n# Plain note"),
  ])
    assert.throws(() => propose(stack, packet, returned), /frontmatter/);
  const next = propose(
    stack,
    packet,
    packet.text.replace("# Original", "# Updated"),
  ).next;
  assert.equal(
    entry(next.text("entries/nested/note.md")).frontmatter,
    entry(stack.text("entries/nested/note.md")).frontmatter,
  );
});
test("multi-hunk diff changes only the two edited lines and preserves middle context", () => {
  const before = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  const after = [...before];
  after[3] = "first edit";
  after[54] = "second edit";
  const lines = diffLines(before.join("\n"), after.join("\n"));
  assert.deepEqual(
    lines.filter((l) => l.kind === "removed").map((l) => l.text),
    ["line 3", "line 54"],
  );
  assert.deepEqual(
    lines.filter((l) => l.kind === "added").map((l) => l.text),
    ["first edit", "second edit"],
  );
  assert.ok(lines.some((l) => l.kind === "context" && l.text === "line 4"));
  assert.ok(lines.some((l) => l.kind === "hunk" && /unchanged/.test(l.text)));
});
test("line diff handles insertions, deletions, repeated lines, CRLF, and explicit budget fallback", () => {
  for (const [before, after] of [
    ["a\nb\nc", "a\nc"],
    ["a\na", "a\nb\na"],
    ["", "new"],
    ["a\r\nb", "a\r\nc"],
  ]) {
    const lines = diffLines(before, after);
    assert.equal(
      lines
        .filter((l) => l.kind !== "added")
        .map((l) => l.text)
        .join("\n"),
      before,
    );
    assert.equal(
      lines
        .filter((l) => l.kind !== "removed")
        .map((l) => l.text)
        .join("\n"),
      after,
    );
  }
  assert.deepEqual(diffLines("same", "same"), []);
  assert.equal(diffLines("a\nb\nc", "x\ny\nz", { maxDistance: 1 }), null);
  assert.equal(diffLines("a\nb", "a\nc", { maxWork: 1 }), null);
});
test("theme resolves explicit overrides and automatic system preference", () => {
  for (const systemDark of [true, false]) {
    assert.equal(resolveTheme("dark", systemDark), "dark");
    assert.equal(resolveTheme("light", systemDark), "light");
    assert.equal(
      resolveTheme("system", systemDark),
      systemDark ? "dark" : "light",
    );
    assert.equal(
      resolveTheme("invalid", systemDark),
      systemDark ? "dark" : "light",
    );
  }
});
test("indexed links retain ambiguity rules and update after moves and edits", () => {
  const stack = newStack("Links").change({
    writes: new Map([
      ["entries/a.md", encode("---\nid: ent-a\n---\nA")],
      ["entries/b.md", encode("[[ent-a]] [[a]] [[./a.md]]")],
      ["other/a.md", encode("Other A")],
    ]),
  });
  assert.equal(resolveEntry(stack, "a", "entries/b.md"), null);
  assert.equal(resolveEntry(stack, "ent-a"), "entries/a.md");
  assert.equal(resolveEntry(stack, "./a.md", "entries/b.md"), "entries/a.md");
  assert.deepEqual(backlinkedEntries(stack, "entries/a.md"), ["entries/b.md"]);
  const moved = stack.change({ moves: [["entries/a.md", "entries/moved.md"]] });
  assert.equal(resolveEntry(moved, "ent-a"), "entries/moved.md");
  assert.deepEqual(backlinkedEntries(moved, "entries/moved.md"), [
    "entries/b.md",
  ]);
  const edited = moved.change({
    writes: new Map([["entries/b.md", encode("No links")]]),
  });
  assert.deepEqual(backlinkedEntries(edited, "entries/moved.md"), []);
  assert.deepEqual(backlinkedEntries(stack, "entries/a.md"), ["entries/b.md"]);
});
