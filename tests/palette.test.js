import test from "node:test";
import assert from "node:assert/strict";
import { sample } from "./helpers.js";
import { encode } from "../src/core/validate.js";
import { entry } from "../src/core/entries.js";
import {
  buildIndex,
  searchIndex,
  occurrences,
  excerpt,
  MAX_QUERY,
} from "../src/carbon/palette/search.js";
import {
  templateCommands,
  planTemplate,
  COMMANDS_PATH,
} from "../src/carbon/palette/templates.js";
import { readFileSync } from "node:fs";

const templates = JSON.parse(
  readFileSync(new URL("../src/carbon/templates.json", import.meta.url)),
);
const fast = { pause: async () => {} };
const state = (stack = sample(), drafts = new Map()) => ({ stack, drafts });
const withFiles = (files) =>
  sample().change({
    writes: new Map(
      Object.entries(files).map(([p, text]) => [p, encode(text)]),
    ),
  });

test("unified search matches titles, filenames, paths and committed IDs before grouped contents", async () => {
  const stack = withFiles({
    "entries/alpha.md":
      "---\nid: stable-alpha\ntitle: Alpha\n---\nAlpha body body",
    "entries/beta.md": "# Beta\nAlpha Alpha",
  });
  const index = await buildIndex(state(stack), fast);
  const commands = [{ id: "go", label: "Go to Entry" }];
  for (const query of ["alpha", "alpha.md", "entries/alpha", "stable-alpha"]) {
    const result = await searchIndex(index, query, commands, fast);
    assert.equal(result.entries[0].path, "entries/alpha.md", query);
  }
  const result = await searchIndex(index, "Alpha", commands, fast);
  assert.deepEqual(
    result.content.map((r) => [r.path, r.count]),
    [
      ["entries/alpha.md", 3],
      ["entries/beta.md", 2],
    ],
  );
  assert.equal(
    (await searchIndex(index, "Go to Entry", commands, fast)).commands[0].id,
    "go",
  );
  assert.equal(
    (await searchIndex(index, "absent term", commands, fast)).entries.length,
    0,
  );
  const empty = await searchIndex(index, "", commands, fast);
  assert.equal(empty.commands.length, 1);
  assert.equal(empty.entries.length, index.records.length);
  assert.equal(empty.content.length, 0);
  const go = await searchIndex(index, "Alpha", commands, {
    ...fast,
    entriesOnly: true,
  });
  assert.equal(go.content.length + go.commands.length + go.entities.length, 0);
});

test("resolvable entity labels use existing resolver rules and omit ambiguous targets or labels", async () => {
  const stack = withFiles({
    "entries/links.md":
      "[[ent-note|Stable person]] [[entries/other.md|Other person]] [[note|Ambiguous]] [[ent-note|Shared]] [[entries/other.md|Shared]]\n`[[ent-note|Code label]]`\n```\n[[ent-note|Fence label]]\n```",
  });
  const index = await buildIndex(state(stack), fast);
  assert.deepEqual(
    index.entities.filter((e) => e.label.includes("person")),
    [
      { label: "Stable person", path: "entries/nested/note.md" },
      { label: "Other person", path: "entries/other.md" },
    ],
  );
  for (const label of ["Ambiguous", "Shared", "Code label", "Fence label"])
    assert.equal(
      index.entities.some((e) => e.label === label),
      false,
      label,
    );
  assert.equal(index.ambiguous, 2);
  assert.equal(
    (await searchIndex(index, "Stable person", [], fast)).entities[0].path,
    "entries/nested/note.md",
  );
  // A stable ID still wins over a colliding basename.
  const collision = stack.change({
    writes: new Map([["entries/ent-note.md", encode("# Another")]]),
  });
  assert.equal(
    (await buildIndex(state(collision), fast)).entities.find(
      (e) => e.label === "Stable person",
    ).path,
    "entries/nested/note.md",
  );
});

test("draft contents and titles are searchable, invalid metadata falls back without changing saved IDs", async () => {
  const drafts = new Map([
    [
      "entries/nested/note.md",
      "---\nid: changed-draft-id\ntitle: Fresh title\n---\nDraftonly Draftonly",
    ],
    ["entries/other.md", "---\ntitle: [broken\n---\nIncompleteonly"],
  ]);
  const index = await buildIndex(state(sample(), drafts), fast);
  assert.equal(index.invalidDrafts, 1);
  assert.equal(
    (await searchIndex(index, "Fresh title", [], fast)).entries[0].id,
    "ent-note",
  );
  assert.equal(
    (await searchIndex(index, "Draftonly", [], fast)).content[0].count,
    2,
  );
  assert.equal(
    (await searchIndex(index, "Incompleteonly", [], fast)).content[0].path,
    "entries/other.md",
  );
  drafts.set("entries/other.md", "new text");
  assert.match(
    index.records.find((r) => r.path === "entries/other.md").source,
    /Incompleteonly/,
  );
});

test("literal Unicode search returns exact UTF-16 offsets after CRLF normalization", async () => {
  const source = "# Unicode\r\nİ 😀 [a.b] 😀\r\n[a.b]";
  const index = await buildIndex(
    state(withFiles({ "entries/unicode.md": source })),
    fast,
  );
  const record = index.records.find((r) => r.path === "entries/unicode.md");
  const hits = await occurrences(record.source, "[a.b]", {
    ...fast,
    countAll: true,
  });
  assert.equal(hits.count, 2);
  for (const hit of hits.matches)
    assert.equal(record.source.slice(hit.from, hit.to), "[a.b]");
  const emoji = await occurrences(record.source, "😀", {
    ...fast,
    countAll: true,
  });
  assert.equal(emoji.count, 2);
  assert.equal(emoji.matches[0].to - emoji.matches[0].from, 2);
  assert.equal(excerpt(record.source, hits.matches[1]).line, 3);
  assert.equal((await occurrences("axb", "a.b", fast)).count, 0);
});

test("large documents count repeated matches exactly, page them without duplicates and allow cancellation", async () => {
  const source = "hit ".repeat(100000) + "late needle";
  let yields = 0;
  const result = await occurrences(source, "hit", {
    countAll: true,
    pause: async () => yields++,
  });
  assert.equal(result.count, 100000);
  assert.equal(result.matches.length, 20);
  assert.ok(yields > 0);
  const page = await occurrences(source, "hit", { ...fast, from: result.next });
  assert.equal(page.matches[0].from, 80);
  assert.equal(
    new Set([...result.matches, ...page.matches].map((m) => m.from)).size,
    40,
  );
  assert.equal(
    (await occurrences(source, "late needle", fast)).matches[0].from,
    400000,
  );
  let cancel = false;
  assert.equal(
    await occurrences(source, "hit", {
      countAll: true,
      cancelled: () => cancel,
      pause: async () => {
        cancel = true;
      },
    }),
    null,
  );
  const index = await buildIndex(state(), fast);
  assert.equal(
    await searchIndex(index, "x", [], { cancelled: () => true }),
    null,
  );
  await assert.rejects(
    searchIndex(index, "x".repeat(MAX_QUERY + 1), [], fast),
    /256/,
  );
});

test("default log is an ordinary reusable template command; repeated activation opens existing content", () => {
  const stack = sample(),
    command = templateCommands(stack).commands[0],
    date = new Date(2026, 9, 20, 23, 59);
  const planned = planTemplate(
    stack,
    new Map(),
    templates,
    command,
    date,
    () => "fixed-id",
  );
  assert.equal(planned.path, "entries/logbook/2026-10-20.md");
  assert.equal(entry(planned.next.text(planned.path)).data.id, "ent-fixed-id");
  assert.match(planned.next.text(planned.path), /# Log 2026-10-20/);
  assert.equal(planned.next.manifest.revision, stack.manifest.revision + 1);
  const again = planTemplate(
    planned.next,
    new Map([[planned.path, "unsaved"]]),
    templates,
    command,
    date,
  );
  assert.equal(again.next, null);
  assert.equal(again.path, planned.path);
  assert.deepEqual([...stack.files.keys()], [...sample().files.keys()]);
});

test("Stack registrations support arbitrary templates and preserve template metadata/comments", () => {
  const stack = withFiles({
    [COMMANDS_PATH]:
      "commands:\n  - id: sprint\n    label: Open Sprint\n    template: templates/sprint.md\n    path: entries/sprint-{{year}}.md\n    title: Sprint {{year}}\n",
    "templates/sprint.md":
      "---\nid: ent-template # keep comment\nkind: meeting\ncustom: retained\n---\n# Placeholder\n\nDate: {{date}}\n{{title}}\n",
  });
  const registry = templateCommands(stack);
  assert.equal(registry.error, null);
  assert.equal(registry.commands.length, 1);
  const result = planTemplate(
    stack,
    new Map(),
    templates,
    registry.commands[0],
    new Date(2026, 9, 20),
    () => "sprint",
  );
  const output = result.next.text(result.path);
  assert.match(output, /keep comment/);
  assert.equal(entry(output).data.custom, "retained");
  assert.equal(entry(output).data.kind, "meeting");
  assert.match(output, /Date: 2026-10-20/);
  assert.equal(result.path, "entries/sprint-2026.md");
});

test("invalid registrations and unsafe/missing/colliding template targets fail closed", () => {
  for (const config of [
    "commands: bad",
    "commands: []\ncommands: []",
    "commands: &a []",
    "commands: !evil []",
    "commands: [{id: same, label: Test, template: builtin:note, path: '../bad.md', title: Test}]",
    "commands: [{id: same, label: Test, template: builtin:note, path: 'entries/{{unknown}}.md', title: Test}]",
    "commands: [{id: same, label: Test, template: builtin:note, path: entries/a.md, title: Test}, {id: same, label: Test, template: builtin:note, path: entries/b.md, title: Test}]",
  ]) {
    const result = templateCommands(withFiles({ [COMMANDS_PATH]: config }));
    assert.equal(result.commands.length, 0, config);
    assert.ok(result.error, config);
  }
  const command = templateCommands(sample()).commands[0];
  assert.throws(
    () =>
      planTemplate(sample(), new Map(), templates, {
        ...command,
        template: "templates/missing.md",
      }),
    /not found/,
  );
  assert.throws(
    () =>
      planTemplate(sample(), new Map(), templates, {
        ...command,
        path: "Entries/OTHER.md",
      }),
    /Already exists/,
  );
  assert.throws(
    () =>
      planTemplate(sample(), new Map(), templates, {
        ...command,
        path: "assets/bytes.bin/entry.md",
      }),
    /collision/,
  );
  assert.equal(
    templateCommands(withFiles({ [COMMANDS_PATH]: "commands: []" })).commands
      .length,
    0,
  );
});

test("literal queries preserve nonempty boundary whitespace through counts and exact offsets", async () => {
  const index = await buildIndex(state(withFiles({"entries/spaces.md":"# Spacing\nfoo foobar  foo \n\tfoo\t"})), fast);
  for (const query of [" foo ", "foo ", " foo", "\tfoo\t"]) {
    const result = await searchIndex(index, query, [], fast);
    assert.equal(result.query, query);
    const doc = result.content.find(r => r.path === "entries/spaces.md");
    const expected = await occurrences(doc.source, query, {...fast,countAll:true});
    assert.equal(doc.count, expected.count);
    for(const hit of doc.matches) assert.equal(doc.source.slice(hit.from,hit.to),query);
  }
  const empty = await searchIndex(index," \t\n",[],fast);
  assert.equal(empty.query,""); assert.equal(empty.content.length,0);
});
test("fallback Entry titles use actual document H1s outside fenced, indented and HTML code", async () => {
  const code = "```sh\n# Shell comment\n```\n\n<pre>\n# HTML content\n</pre>\n\n    # Indented code\n\n> # Quoted heading\n\n";
  const index = await buildIndex(state(withFiles({
    "entries/actual.md":code+"# Actual heading ###\n",
    "entries/setext.md":code+"Setext title\n============\n",
    "entries/no-title.md":code,
  })),fast);
  const label = p=>index.records.find(r=>r.path===p).label;
  assert.equal(label("entries/actual.md"),"Actual heading");
  assert.equal(label("entries/setext.md"),"Setext title");
  assert.equal(label("entries/no-title.md"),"no-title.md");
});
test("template heading replacement preserves fenced/HTML examples and surrounding source bytes", () => {
  const prefix = "~~~sh\r\n# Keep this comment\r\n~~~\r\n\r\n<pre>\r\n# Keep HTML example\r\n</pre>\r\n\r\n";
  for (const heading of ["# Placeholder ###", "Placeholder\r\n===========", ""]) {
    const body=prefix+heading+"\r\n\r\nRest unchanged.\r\n";
    const s=withFiles({"templates/code.md":body});
    const result=planTemplate(s,new Map(),templates,{id:"code",label:"Code",template:"templates/code.md",path:"entries/generated.md",title:"New title"},new Date(2026,9,21),()=>"generated");
    assert.equal(entry(result.next.text(result.path)).body,prefix+(heading?"# New title":"")+"\r\n\r\nRest unchanged.\r\n");
    assert.equal(s.text("templates/code.md"),body);
  }
});

test("indented ATX titles retain exact ranking and parser offsets", async () => {
  for (const indent of [" ", "  ", "   "]) {
    const source = `${indent}# Project plan\n`;
    const index = await buildIndex(state(withFiles({"entries/indented.md":source})), fast);
    const result = await searchIndex(index,"Project plan",[],fast);
    const found = result.entries.find(r => r.path === "entries/indented.md");
    assert.equal(found.label,"Project plan"); assert.equal(found.rank,0);
    const resultTemplate = planTemplate(withFiles({"templates/indent.md":source}),new Map(),templates,{id:"indent",label:"Indent",template:"templates/indent.md",path:"entries/new.md",title:"Updated"});
    assert.equal(entry(resultTemplate.next.text(resultTemplate.path)).body, `${indent}# Updated\n`);
  }
});
test("generated H1 renders the literal configured title, including closing hashes", async () => {
  const { marked } = await import("marked");
  for (const title of ["Roadmap #", "#", "##", "Roadmap ###  ", "C#", "A *literal* [title] &amp;", "~~draft~~", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"]) {
    const planned = planTemplate(sample(),new Map(),templates,{id:"hash",label:"Hash",template:"builtin:note",path:"entries/hash.md",title});
    const parsed = entry(planned.next.text(planned.path));
    assert.equal(parsed.data.title,title);
    const heading = marked.lexer(parsed.body).find(t => t.type === "heading");
    assert.equal(heading.tokens.map(t=>t.text).join(""),title.trim());
  }
});

test("cold wiki resolver construction yields and cancellation never publishes a partial index", async () => {
  const { prepareEntryIndex, resolveEntry } = await import("../src/carbon/markdown.js");
  const files = Object.fromEntries(Array.from({length:80}, (_,i) => [`entries/cold-${i}.md`, `---\nid: cold-${i}\n---\n[[cold-79|Alias]]\n`]));
  const s = withFiles(files);
  let reads = 0, stopped = false;
  const cold = {files:s.files, text:p => {reads++;return s.text(p);}};
  const result = await buildIndex(state(cold),{pause:async()=>{stopped=true;},cancelled:()=>stopped});
  assert.equal(result,null); assert.ok(reads < 5, `read ${reads} files before first yield`);
  reads = 0; let pauses = 0;
  assert.equal(await prepareEntryIndex(cold,{pause:async()=>{pauses++;},cancelled:()=>false}),true);
  assert.ok(reads >= 80, "a cancelled partial index must be rebuilt");
  assert.ok(pauses >= 80, "resolver construction yields per Entry");
  assert.equal(resolveEntry(cold,"cold-79"),"entries/cold-79.md");
  const warmed = reads;
  await prepareEntryIndex(cold,{pause:async()=>{throw Error("already warm");},cancelled:()=>false});
  assert.equal(reads,warmed);
});
