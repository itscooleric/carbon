import test from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { history, undo, redo } from "@codemirror/commands";
import { CompletionContext, insertBracket } from "@codemirror/autocomplete";
import {
  continueList,
  indentList,
  outdentList,
  indentOrTab,
  outdentOrDedent,
  toggleTasks,
  surround,
  wikiCompletion,
  proseAt,
} from "../src/carbon/editor/behaviors.js";
import { sample } from "./helpers.js";
import { encode } from "../src/core/validate.js";
import { editorSource } from "../src/core/entries.js";

function editor(doc, selection = { anchor: doc.length }) {
  const target = {
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        markdownLanguage,
        history(),
        EditorState.allowMultipleSelections.of(true),
      ],
    }),
  };
  target.dispatch = (tr) => {
    target.state = tr.state;
  };
  return target;
}

test("Markdown continues ordered, nested and unchecked tasks; empty items exit a level", () => {
  for (const [before, after] of [
    ["1. first", "1. first\n2. "],
    ["7) seven", "7) seven\n8) "],
    ["- parent\n  - child", "- parent\n  - child\n  - "],
    ["- [x] done", "- [x] done\n- [ ] "],
    ["- [ ] todo", "- [ ] todo\n- [ ] "],
    ["- first\n- ", "- first\n"],
    ["- [ ] ", ""],
    ["- parent\n  - child\n  - ", "- parent\n  - child\n- "],
  ]) {
    const t = editor(before);
    assert.equal(continueList(t), true, before);
    assert.equal(t.state.doc.toString(), after, before);
    assert.equal(undo(t), true);
    assert.equal(t.state.doc.toString(), before);
    assert.equal(redo(t), true);
    assert.equal(t.state.doc.toString(), after);
  }
});

test("task normalization excludes column-zero end and code/YAML, retaining selections and history", () => {
  const doc =
    "---\ntitle: x\n- [ ] metadata\n---\n- [ ] one\n  - [X] two\n```md\n- [ ] code\n```\n- [ ] last";
  const t = editor(doc, { anchor: 0, head: doc.lastIndexOf("- [ ] last") });
  assert.equal(toggleTasks(t), true);
  assert.equal(t.state.doc.toString(), doc.replace("- [ ] one", "- [x] one"));
  assert.deepEqual(t.state.selection.toJSON(), {
    ranges: [{ anchor: 0, head: doc.lastIndexOf("- [ ] last") }],
    main: 0,
  });
  undo(t);
  assert.equal(t.state.doc.toString(), doc);
  redo(t);
  assert.equal(t.state.doc.toString(), doc.replace("- [ ] one", "- [x] one"));
  toggleTasks(t);
  assert.equal(t.state.doc.toString(), doc.replace("- [X] two", "- [ ] two"));
  const multi = editor(
    "- [ ] a\n- [x] b",
    EditorSelection.create([
      EditorSelection.cursor(3),
      EditorSelection.cursor(6),
      EditorSelection.cursor(12),
    ]),
  );
  toggleTasks(multi);
  assert.equal(multi.state.doc.toString(), "- [x] a\n- [x] b");
  toggleTasks(multi);
  assert.equal(multi.state.doc.toString(), "- [ ] a\n- [ ] b");
  const locked = editor("- [ ] a");
  locked.state = EditorState.create({
    doc: "- [ ] a",
    extensions: EditorState.readOnly.of(true),
  });
  assert.equal(toggleTasks(locked), false);
});

test("tasks normalize all checked, all unchecked and mixed ranges without creating tasks", () => {
  for (const statuses of [
    ["x", "X"],
    [" ", " "],
    ["x", " "],
  ]) {
    const doc = `- [${statuses[0]}] one\n  1. [${statuses[1]}] two\n- ordinary\n[x] text`;
    const t = editor(doc, { anchor: doc.length, head: 0 });
    const selection = t.state.selection.toJSON();
    const check = statuses.some((status) => status === " ");
    assert.equal(toggleTasks(t), true);
    const expected = doc.replace(
      /\[([ xX])\](?= (?:one|two))/g,
      check ? "[x]" : "[ ]",
    );
    assert.equal(t.state.doc.toString(), expected);
    assert.deepEqual(t.state.selection.toJSON(), selection);
    assert.equal(toggleTasks(t), true);
    assert.equal(
      t.state.doc.toString(),
      expected.replace(/\[([ xX])\](?= (?:one|two))/g, check ? "[ ]" : "[x]"),
    );
  }
  for (const doc of [
    "- ordinary",
    "[ ] text",
    "~~~md\n- [ ] code\n~~~",
    "    - [ ] code",
    "---\n- [ ] unfinished",
  ]) {
    const t = editor(doc, { anchor: 0, head: doc.length });
    assert.equal(toggleTasks(t), false, doc);
    assert.equal(t.state.doc.toString(), doc);
  }
});

function listDepth(state, text) {
  const pos = state.doc.toString().indexOf(text);
  let depth = 0;
  for (
    let node = ensureSyntaxTree(state, state.doc.length).resolveInner(pos, 1);
    node;
    node = node.parent
  )
    if (node.name === "ListItem") depth++;
  return depth;
}

test("Tab nests bullets, numbered lists and tasks beneath preceding siblings with undoable selections", () => {
  for (const [before, after] of [
    ["- parent\n- child", "- parent\n  - child"],
    ["9. parent\n10. child", "9. parent\n   10. child"],
    ["10) parent\n11) child", "10) parent\n    11) child"],
    ["- [x] parent\n- [ ] child", "- [x] parent\n  - [ ] child"],
    ["- root\n  - parent\n  - child", "- root\n  - parent\n    - child"],
  ]) {
    const t = editor(before),
      selection = t.state.selection.toJSON();
    const depth = listDepth(t.state, "child");
    assert.equal(indentList(t), true, before);
    assert.equal(t.state.doc.toString(), after);
    assert.equal(t.state.selection.main.head, after.length);
    assert.equal(listDepth(t.state, "child"), depth + 1);
    undo(t);
    assert.equal(t.state.doc.toString(), before);
    assert.deepEqual(t.state.selection.toJSON(), selection);
    redo(t);
    assert.equal(t.state.doc.toString(), after);
    assert.equal(outdentList(t), true);
    assert.equal(t.state.doc.toString(), before);
    assert.deepEqual(t.state.selection.toJSON(), selection);
  }
});

test("list ranges move attached content once, retain direction and exclude a column-zero end", () => {
  const doc =
    "- parent\n- child\n  - grandchild\n    continued\n- sibling\n- last";
  const start = doc.indexOf("- child"),
    end = doc.indexOf("- last");
  const t = editor(doc, { anchor: end, head: start });
  const expected =
    "- parent\n  - child\n    - grandchild\n      continued\n  - sibling\n- last";
  assert.equal(indentList(t), true);
  assert.equal(t.state.doc.toString(), expected);
  assert.equal(t.state.selection.main.anchor, expected.indexOf("- last"));
  assert.equal(t.state.selection.main.head, expected.indexOf("- child"));
  assert.equal(listDepth(t.state, "grandchild"), 3);
  assert.equal(outdentList(t), true);
  assert.equal(t.state.doc.toString(), doc);
  assert.deepEqual(
    t.state.selection.toJSON(),
    editor(doc, { anchor: end, head: start }).state.selection.toJSON(),
  );
  const multi = editor(
    doc,
    EditorSelection.create(
      [
        EditorSelection.cursor(start + 3),
        EditorSelection.cursor(start + 5),
        EditorSelection.range(
          doc.indexOf("sibling") + 7,
          doc.indexOf("sibling"),
        ),
      ],
      2,
    ),
  );
  const ranges = multi.state.selection.toJSON();
  assert.equal(indentList(multi), true);
  assert.equal(multi.state.doc.toString(), expected);
  assert.equal(multi.state.selection.ranges.length, 3);
  assert.equal(
    multi.state.sliceDoc(
      multi.state.selection.main.from,
      multi.state.selection.main.to,
    ),
    "sibling",
  );
  undo(multi);
  assert.deepEqual(multi.state.selection.toJSON(), ranges);
});

test("outdent removes one parent level, handles tabs and preserves child paragraphs", () => {
  for (const [before, after] of [
    ["10. parent\n    - child\n      body", "10. parent\n- child\n  body"],
    ["- parent\n\t- child", "- parent\n- child"],
    [
      "- root\n  - parent\n  \t- child\n  \t  \t- grandchild",
      "- root\n  - parent\n  - child\n      - grandchild",
    ],
    [
      "- parent\n  - child\n    - grandchild",
      "- parent\n- child\n  - grandchild",
    ],
  ]) {
    const t = editor(before, { anchor: before.indexOf("child") });
    assert.equal(outdentList(t), true);
    assert.equal(t.state.doc.toString(), after);
    undo(t);
    assert.equal(t.state.doc.toString(), before);
    redo(t);
    assert.equal(t.state.doc.toString(), after);
  }
});

test("indent preserves Markdown columns when existing indentation contains tabs", () => {
  const before = "- root\n\t- parent\n\t- child\n\t\t- grandchild";
  const t = editor(before, { anchor: before.indexOf("child") });
  assert.equal(indentList(t), true);
  assert.equal(
    t.state.doc.toString(),
    "- root\n\t- parent\n      - child\n          - grandchild",
  );
  assert.equal(listDepth(t.state, "child"), 3);
  assert.equal(listDepth(t.state, "grandchild"), 4);
  assert.equal(
    t.state.selection.main.head,
    t.state.doc.toString().indexOf("child"),
  );
  undo(t);
  assert.equal(t.state.doc.toString(), before);
  assert.equal(t.state.selection.main.head, before.indexOf("child"));
});

test("Tab falls through outside movable lists, including mixed ranges and read-only/composing input", () => {
  for (const doc of [
    "text",
    "- first",
    "- first\n- second",
    "- parent\n\nparagraph",
    "```md\n- first\n- second\n```",
    "---\n- first\n- second\n---",
    "> - parent\n> - child",
    "",
  ]) {
    const t = editor(doc, { anchor: 0, head: doc.length });
    assert.equal(indentList(t), false, doc);
    assert.equal(outdentList(t), false, doc);
    assert.equal(t.state.doc.toString(), doc);
  }
  const composing = editor("- parent\n- child");
  composing.composing = true;
  assert.equal(indentList(composing), false);
  const locked = editor("- parent\n- child");
  locked.state = EditorState.create({
    doc: "- parent\n- child",
    extensions: [markdownLanguage, EditorState.readOnly.of(true)],
  });
  assert.equal(indentList(locked), false);
  assert.equal(outdentList(locked), false);
});

test("Tab indents outside movable lists instead of leaving the editor; read-only and composing fall through", () => {
  const plain = editor("text", { anchor: 0, head: 0 });
  assert.equal(indentOrTab(plain), true);
  assert.equal(plain.state.doc.toString(), "  text");
  assert.equal(outdentOrDedent(plain), true);
  assert.equal(plain.state.doc.toString(), "text");
  const lines = editor("one\ntwo", { anchor: 0, head: 7 });
  assert.equal(indentOrTab(lines), true);
  assert.equal(lines.state.doc.toString(), "  one\n  two");
  assert.equal(outdentOrDedent(lines), true);
  assert.equal(lines.state.doc.toString(), "one\ntwo");
  // Movable lists still move structurally rather than inserting spaces.
  const list = editor("- parent\n- child", { anchor: 9, head: 9 });
  assert.equal(indentOrTab(list), true);
  assert.equal(list.state.doc.toString(), "- parent\n  - child");
  const composing = editor("text");
  composing.composing = true;
  assert.equal(indentOrTab(composing), false);
  assert.equal(outdentOrDedent(composing), false);
  const locked = editor("text");
  locked.state = EditorState.create({ doc: "text", extensions: [markdownLanguage, EditorState.readOnly.of(true)] });
  assert.equal(indentOrTab(locked), false);
  assert.equal(outdentOrDedent(locked), false);
});

test("pairing and formatting preserve multiple selections and undo", () => {
  const t = editor(
    "one two",
    EditorSelection.create([
      EditorSelection.range(0, 3),
      EditorSelection.range(4, 7),
    ]),
  );
  surround("**")(t);
  assert.equal(t.state.doc.toString(), "**one** **two**");
  assert.deepEqual(
    t.state.selection.ranges.map((r) => t.state.sliceDoc(r.from, r.to)),
    ["one", "two"],
  );
  undo(t);
  assert.equal(t.state.doc.toString(), "one two");
  for (const open of ['"', "'", "(", "[", "{"]) {
    const pair = editor("word", { anchor: 0, head: 4 });
    const tr = insertBracket(pair.state, open);
    assert.ok(tr, open);
    pair.dispatch(tr);
    assert.ok(pair.state.doc.toString().startsWith(open + "word"));
  }
});

test("wiki completion validates aliases/IDs, avoids code/frontmatter and consumes paired brackets", () => {
  let stack = sample();
  const source = wikiCompletion(() => ({ stack, current: "entries/other.md" }));
  const complete = (doc, pos = doc.length) =>
    source(new CompletionContext(editor(doc).state, pos, false));
  const result = complete("[[");
  assert.ok(result.options.some((o) => o.label === "ent-note"));
  assert.ok(result.options.some((o) => o.label === "entries/nested/note.md"));
  assert.ok(!result.options.some((o) => o.label === "note")); // fixture has two note.md files
  for (const doc of [
    "---\ntitle: [[",
    "---\ntitle: [[\n---",
    "```md\n[[",
    "~~~\n[[",
    "`[[`",
    "\\[[",
  ]) {
    const pos = doc.indexOf("[[") + 2;
    assert.equal(complete(doc, pos), null, doc);
  }
  assert.ok(complete("---\nid: x\n---\n[["));
  const option = result.options.find((o) => o.label === "ent-note");
  let state = editor("[[]]", { anchor: 2 }).state;
  option.apply(
    {
      get state() {
        return state;
      },
      dispatch(spec) {
        state = state.update(spec).state;
      },
    },
    option,
    2,
    2,
  );
  assert.equal(state.doc.toString(), "[[ent-note]]");
  stack = stack.change({
    moves: [["entries/nested/note.md", "entries/renamed.md"]],
  });
  assert.ok(
    complete("[[ent").options.some((o) => o.detail === "entries/renamed.md"),
  );
  stack = stack.change({
    writes: new Map([
      ["entries/collision.md", encode("---\nid: renamed\n---\nCollision")],
    ]),
  });
  assert.ok(
    !complete("[[renamed").options.some(
      (o) => o.detail === "entries/renamed.md" && o.label === "renamed",
    ),
  );
});

test("editor draft conversion preserves YAML comments and original CRLF", () => {
  const original =
    "---\r\nid: stable # comment\r\ncustom: yes\r\n---\r\nOld\r\n";
  const edited = original.replace(/\r\n/g, "\n").replace("Old", "New");
  assert.equal(editorSource(edited, original), original.replace("Old", "New"));
  assert.equal(proseAt(editor("---\nunclosed: [").state, 15), false);
});
