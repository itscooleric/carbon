import test from "node:test";
import assert from "node:assert/strict";
import { sample } from "./helpers.js";
import { encode } from "../src/core/validate.js";
import { newStack } from "../src/core/stack.js";
import {
  workspaceState,
  addTab,
  removeTab,
  MAX_TABS,
  viewable,
  viewableIn,
} from "../src/carbon/workspace.js";
import {
  createState,
  serialize,
  restore,
  commit,
} from "../src/carbon/state.js";

const stack = () =>
  sample().change({
    writes: new Map([
      ["assets/data.csv", encode("x,y\n1,2")],
      ["assets/data.json", encode('{"large":9007199254740993}')],
    ]),
  });
test("workspace recovery validates tabs, deduplicates paths and bounds UI fields", () => {
  const s = stack(),
    p = "entries/other.md";
  const m = workspaceState(s, p, {
    stackId: s.manifest.id,
    editors: [p, p, "assets/data.csv", null, "missing.md"],
    viewers: [
      p,
      "assets/data.csv",
      "assets/data.json",
      p,
      "stack.yaml",
      "../secret.md",
    ],
    viewer: "missing.md",
    shown: true,
    side: "invalid",
    ratio: 999,
    swapped: true,
    scroll: { [p]: -1, "assets/data.csv": "bad" },
  });
  assert.deepEqual(m.editors, [p]);
  assert.deepEqual(m.viewers, [p, "assets/data.csv", "assets/data.json", "stack.yaml"]);
  assert.equal(m.viewer, p);
  assert.equal(m.shown, true);
  assert.equal(m.side, "editor");
  assert.equal(m.ratio, 75);
  assert.equal(m.swapped, true);
  assert.equal(m.scroll[p], 0);
  assert.equal(
    workspaceState(s, p, { stackId: s.manifest.id, editors: {} }).editors
      .length,
    1,
  );
});
test("tab operations keep panes independent, do not duplicate, and select a neighbor on close", () => {
  const editors = ["a.md"],
    viewers = [];
  for (const p of ["a.md", "b.csv", "c.json", "a.md"]) addTab(viewers, p);
  assert.deepEqual(viewers, ["a.md", "b.csv", "c.json"]);
  assert.equal(removeTab(viewers, "b.csv", "a.md"), "b.csv");
  assert.equal(removeTab(viewers, "b.csv", "b.csv"), "c.json");
  assert.deepEqual(editors, ["a.md"]);
  const full = Array.from({ length: MAX_TABS }, (_, i) => `${i}.md`);
  addTab(full, "0.md");
  assert.throws(() => addTab(full, "extra.md"), /Close a tab/);
});
test("Stack replacement clears documents but retains arrangement preferences", () => {
  const a = stack(),
    saved = workspaceState(a, "entries/other.md");
  saved.viewers.push("assets/data.csv");
  saved.viewer = "assets/data.csv";
  saved.shown = true;
  saved.swapped = true;
  saved.ratio = 65;
  const b = workspaceState(newStack(), null, saved);
  assert.deepEqual(b.editors, []);
  assert.deepEqual(b.viewers, []);
  assert.equal(b.viewer, null);
  assert.equal(b.shown, false);
  assert.equal(b.ratio, 65);
  assert.equal(b.swapped, true);
});
test("workspace state round-trips with drafts and atomic commits do not alter failed candidates", async () => {
  const s = createState();
  s.stack = stack();
  s.current = "entries/other.md";
  s.documents = workspaceState(s.stack, s.current);
  s.documents.viewers = ["assets/data.csv", "assets/data.json"];
  s.documents.viewer = "assets/data.json";
  s.documents.shown = true;
  s.documents.side = "viewer";
  s.documents.scroll["assets/data.json"] = 123;
  s.drafts.set(s.current, "draft kept");
  const cache = serialize(s),
    recovered = restore(cache);
  assert.deepEqual(recovered.documents, cache.documents);
  assert.equal(recovered.current, s.current);
  assert.equal(recovered.drafts.get(s.current), "draft kept");
  const candidate = { ...s.documents, viewer: "assets/data.csv" };
  await assert.rejects(
    commit(s, {}, { documents: candidate }, async () => {
      throw Error("quota");
    }),
    /quota/,
  );
  assert.equal(s.documents.viewer, "assets/data.json");
  const old = { ...cache };
  delete old.documents;
  assert.deepEqual(restore(old).documents.editors, [s.current]);
});

test("different Stack identity clears overlapping paths; legacy caches retain their active Entry", () => {
  const a=stack(), path="entries/other.md", old=workspaceState(a,path);
  old.viewers=[path]; old.viewer=path; old.shown=true; old.swapped=true;
  const b=newStack().change({writes:new Map([[path,encode("# Different document")]])});
  const next=workspaceState(b,path,old);
  assert.deepEqual(next.editors,[]); assert.deepEqual(next.viewers,[]);
  assert.equal(next.viewer,null); assert.equal(next.swapped,true);
  assert.deepEqual(workspaceState(b,path).editors,[path]);
});
test("a full Editor workspace never evicts a tab to seed an untracked current Entry", () => {
  const paths=Array.from({length:MAX_TABS+1},(_,i)=>`entries/${i}.md`);
  const s=sample().change({writes:new Map(paths.map(p=>[p,encode("# Tab")]))});
  const cached=workspaceState(s,paths[0]); cached.editors=paths.slice(0,MAX_TABS);
  const next=workspaceState(s,paths.at(-1),cached);
  assert.deepEqual(next.editors,cached.editors);
  assert.throws(()=>addTab(next.editors,paths.at(-1)),/Close a tab/);
});
test("viewableIn opens known extensions and any text-like file, but never binaries", () => {
  const s = stack().change({
    writes: new Map([
      ["src/tool.py", encode("print('<script>')\n")],
      ["conf/app.toml", encode("a = 1\n")],
      ["bom.cfg", Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)],
      ["blob.bin", Uint8Array.of(0, 1, 2, 255)],
      ["latin.dat", Uint8Array.of(0x63, 0x61, 0x66, 0xe9)],
    ]),
  });
  assert.equal(viewable("src/tool.py"), false);
  assert.equal(viewable("assets/data.csv"), true);
  for (const p of ["src/tool.py", "conf/app.toml", "bom.cfg", "assets/data.csv"])
    assert.equal(viewableIn(s, p), true, p);
  for (const p of ["blob.bin", "latin.dat", "missing.py", null, undefined])
    assert.equal(viewableIn(s, p), false, String(p));
  assert.equal(viewableIn(s, "missing.csv"), true, "known extensions stay viewable by name");
  const m = workspaceState(s, null, {
    stackId: s.manifest.id,
    viewers: ["src/tool.py", "blob.bin", "bom.cfg"],
    viewer: "blob.bin",
  });
  assert.deepEqual(m.viewers, ["src/tool.py", "bom.cfg"]);
  assert.equal(m.viewer, "src/tool.py");
});
