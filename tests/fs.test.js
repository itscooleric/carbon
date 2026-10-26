import test from "node:test";
import assert from "node:assert/strict";
import { saveDirectory, readDirectory, readFiles } from "../src/carbon/fs.js";
import { sample } from "./helpers.js";
import { sameStack } from "../src/core/stack.js";
import { LIMITS } from "../src/core/validate.js";
function dir(name = "", log = [], fail = false) {
  const children = new Map();
  return {
    kind: "directory",
    name,
    children,
    async *entries() {
      yield* children;
    },
    async getDirectoryHandle(n, { create = false } = {}) {
      if (children.has(n)) {
        const c = children.get(n);
        if (c.kind !== "directory")
          throw new DOMException("file", "TypeMismatchError");
        return c;
      }
      if (!create) throw new DOMException("missing", "NotFoundError");
      const c = dir(n, log, fail);
      children.set(n, c);
      return c;
    },
    async getFileHandle(n, { create = false } = {}) {
      if (children.has(n)) return children.get(n);
      if (!create) throw new DOMException("missing", "NotFoundError");
      let bytes = new Uint8Array();
      const c = {
        kind: "file",
        async getFile() {
          return new File([bytes], n);
        },
        async createWritable() {
          return {
            async write(b) {
              if (fail) throw new DOMException("denied", "NotAllowedError");
              bytes = b.slice();
              log.push(n);
            },
            async close() {},
            async abort() {},
          };
        },
      };
      children.set(n, c);
      return c;
    },
  };
}
test("filesystem adapter writes a new snapshot, manifest last, and reads exact bytes", async () => {
  const log = [],
    parent = dir("", log),
    s = sample();
  await saveDirectory(parent, s, "snapshot.stack");
  assert.equal(log.at(-1), "stack.yaml");
  assert.ok(
    sameStack(s, await readDirectory(parent.children.get("snapshot.stack"))),
  );
  await assert.rejects(
    () => saveDirectory(parent, s, "snapshot.stack"),
    /exists/,
  );
});
test("folder write permission failures surface and no manifest claims completion", async () => {
  const log = [],
    parent = dir("", log, true);
  await assert.rejects(
    () => saveDirectory(parent, sample(), "failed.stack"),
    /denied/,
  );
  assert.ok(!log.includes("stack.yaml"));
});
test("folder picker import rejects symlink-like unsupported member handles", async () => {
  const parent = dir();
  parent.children.set("escape", { kind: "other" });
  await assert.rejects(() => readDirectory(parent));
});
test("loose file read checks duplicate names and sizes before mutation", async () => {
  await assert.rejects(
    () => readFiles([new File(["a"], "note.md"), new File(["b"], "note.md")]),
    /collision/,
  );
  await assert.rejects(
    () => readFiles([{ name: "too-big", size: LIMITS.file + 1 }]),
    /size/,
  );
});
const picked = (rel, text = "x") => Object.defineProperty(new File([text], rel.split("/").pop()), "webkitRelativePath", { value: rel });
test("folder upload skips .carbon-history snapshots but keeps look-alike names", async () => {
  const files = await readFiles(
    [
      picked("proj/notes/a.md", "a"),
      picked("proj/.carbon-history/README.txt"),
      picked("proj/.carbon-history/carbon-history.json"),
      picked("proj/.carbon-history/versions/notes/a.20260315T142530123Z.a1b2c3.md", "old secret"),
      picked("proj/.carbon-history-notes.md", "keep"),
      picked("proj/.Carbon-History/x.md", "keep case"),
      picked("proj/sub/.carbon-history/x.md", "nested is the user's own"),
    ],
    true,
  );
  assert.deepEqual(files.map(([p]) => p).sort(), [
    ".Carbon-History/x.md",
    ".carbon-history-notes.md",
    "notes/a.md",
    "sub/.carbon-history/x.md",
  ]);
});
test("skipped .carbon-history files do not count toward the file-count or size limits", async () => {
  const history = Array.from({ length: LIMITS.files }, (_, i) => picked(`proj/.carbon-history/versions/f${i}.md`));
  const big = { name: "s", webkitRelativePath: "proj/.carbon-history/versions/s", size: LIMITS.total + 1, arrayBuffer: async () => assert.fail("must not be read") };
  const files = await readFiles([picked("proj/a.md", "a"), ...history, big], true);
  assert.deepEqual(files.map(([p]) => p), ["a.md"]);
  // Without stripRoot (loose files) nothing is skipped.
  await assert.rejects(() => readFiles([...history, picked("a.md")]), /Too many/);
});
