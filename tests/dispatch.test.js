import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createState } from "../src/carbon/state.js";
import {
  createDispatchController,
  missionCandidates,
} from "../src/carbon/controller/dispatch.js";
import {
  parseCast,
  parseReturn,
  readHandoff,
  encodeReturn,
} from "../cast-kit/src/kit.mjs";
import { yaml } from "../src/core/entries.js";
import { encode, decode } from "../src/core/validate.js";
import { sample } from "./helpers.js";
import { LocalFolder } from "../src/carbon/local-files.js";

const assets = JSON.parse(
  readFileSync(new URL("../src/carbon/castkit-assets.json", import.meta.url), "utf8"),
);
const NOTE = "entries/nested/note.md",
  OTHER = "entries/other.md",
  MISSION = "entries/mission.md";

function withMission(stack = sample()) {
  return stack.change({
    writes: new Map([
      [MISSION, encode("---\nid: ent-mission\nkind: mission\n---\n# Mission\n")],
    ]),
  });
}
function harness({ stack = sample(), clipboardFails = false } = {}) {
  const state = createState();
  state.stack = stack;
  const downloads = [],
    copies = [],
    persists = { n: 0 };
  let tick = 0;
  const ctl = createDispatchController({
    state,
    persist: async () => {
      persists.n++;
    },
    commit: async () => {},
    assets,
    download: (bytes, name, type) => downloads.push({ bytes, name, type }),
    clipboard: async (text) => {
      if (clipboardFails) throw new Error("denied");
      copies.push(text);
    },
    now: () => `2026-10-20T00:00:${String(tick++ % 60).padStart(2, "0")}.000Z`,
  });
  return { state, ctl, downloads, copies, persists };
}
function ready(ctl, options = {}) {
  const r = ctl.startDraft({ seedContext: [NOTE, OTHER], ...options });
  ctl.updateDraft(r.assignmentId, { objective: "Summarize the notes.", consent: true });
  return r;
}

test("castkit assets carry the starter Playbooks, contract and bootstrap", () => {
  assert.deepEqual(Object.keys(assets.playbooks), [
    "Research",
    "Planning",
    "Investigation",
    "Report generation",
    "Critical review",
    "Entity reconciliation",
  ]);
  assert.equal(assets.sources["Report generation"], "builtin:report");
  assert.match(assets.playbooks.Research, /^---\ntitle: Research\n/);
  assert.match(assets.contract, /^# Envoy Operating Contract v0.1/);
  assert.match(assets.bootstrap, /Follow the supplied Envoy Operating Contract v0.1/);
});

test("startDraft seeds context from existing Entries and applies the question preset", () => {
  const { ctl, state, persists } = harness();
  const r = ctl.startDraft({
    seedContext: [OTHER, "entries/missing.md", "assets/bytes.bin", OTHER],
  });
  assert.match(r.assignmentId, /^cast-[0-9a-f-]{36}$/);
  assert.equal(r.seq, 1);
  assert.equal(r.status, "draft");
  assert.equal(r.stackId, "stk-test");
  assert.equal(r.baseRevision, 3);
  assert.deepEqual(r.draft.context, [OTHER]);
  assert.equal(r.draft.mission, null);
  assert.deepEqual(
    r.draft.playbooks.map((p) => [p.name, p.source]),
    [["Research", "builtin:research"]],
  );
  assert.equal(r.draft.playbooks[0].content, assets.playbooks.Research);
  assert.equal(r.draft.target, "text");
  assert.equal(r.draft.scope, "selected");
  assert.equal(r.draft.consent, false);
  assert.equal(r.draft.step, 0);
  assert.deepEqual(r.draft.criteria, []);
  assert.deepEqual(r.draft.permissions, {
    create: [],
    replace: [],
    metadata: [],
    delete: [],
    rename: [],
  });
  assert.equal(r.exported, null);
  assert.deepEqual(r.receipts, []);
  assert.equal(state.dispatches[0], r);
  assert.equal(ctl.find(r.assignmentId), r);
  assert.equal(ctl.list().length, 1);
  assert.equal(ctl.startDraft({ preset: "custom" }).seq, 2);
  assert.ok(persists.n >= 1);
});

test("plan and report presets pre-fill permissions from the open Entry", () => {
  const { ctl } = harness();
  const plan = ctl.startDraft({ openPath: NOTE, preset: "plan" });
  assert.deepEqual(plan.draft.context, [NOTE]);
  assert.deepEqual(plan.draft.permissions.replace, [NOTE]);
  assert.deepEqual(
    plan.draft.playbooks.map((p) => p.name),
    ["Planning"],
  );
  const report = ctl.startDraft({ openPath: NOTE, preset: "report" });
  assert.deepEqual(
    report.draft.playbooks.map((p) => p.name),
    ["Research", "Report generation"],
  );
  assert.deepEqual(report.draft.permissions.replace, [NOTE]);
  assert.deepEqual(report.draft.permissions.create, ["entries/report.md"]);
  const custom = ctl.startDraft({ openPath: NOTE, preset: "custom" });
  assert.deepEqual(custom.draft.playbooks, []);
  assert.deepEqual(custom.draft.permissions.create, []);
  const none = ctl.startDraft({ openPath: "assets/bytes.bin", preset: "report" });
  assert.deepEqual(none.draft.context, []);
  assert.deepEqual(none.draft.permissions.replace, []);
});

test("report preset picks the next free report path when entries/report.md exists", () => {
  const taken = sample().change({
    writes: new Map([["entries/Report.md", encode("# Taken\n")]]),
  });
  const { ctl } = harness({ stack: taken });
  const r = ctl.startDraft({ preset: "report" });
  assert.deepEqual(r.draft.permissions.create, ["entries/report-2.md"]);
});

test("mission is chosen from the context and missionCandidates lists mission Entries", () => {
  const stack = withMission();
  assert.deepEqual(missionCandidates(stack), [MISSION]);
  assert.deepEqual(missionCandidates(sample()), []);
  const { ctl } = harness({ stack });
  const r = ctl.startDraft({ seedContext: [OTHER, MISSION] });
  assert.equal(r.draft.mission, MISSION);
  assert.deepEqual(r.draft.context, [MISSION, OTHER]);
  assert.equal(ctl.startDraft({ seedContext: [OTHER] }).draft.mission, null);
});

test("updateDraft merges, validates lightly and refuses unknown fields", () => {
  const { ctl, persists } = harness();
  const r = ctl.startDraft();
  const before = persists.n;
  ctl.updateDraft(r.assignmentId, {
    objective: "Q",
    permissions: { create: ["entries/new.md"] },
    step: 3,
  });
  assert.equal(r.draft.objective, "Q");
  assert.deepEqual(r.draft.permissions.create, ["entries/new.md"]);
  assert.deepEqual(r.draft.permissions.replace, []);
  assert.equal(r.draft.step, 3);
  assert.equal(persists.n, before + 1);
  assert.throws(() => ctl.updateDraft(r.assignmentId, { bogus: 1 }), /Unknown draft field/);
  assert.throws(() => ctl.updateDraft(r.assignmentId, { preset: "x" }), /Invalid preset/);
  assert.throws(() => ctl.updateDraft(r.assignmentId, { step: 9 }), /Step/);
  assert.throws(() => ctl.updateDraft(r.assignmentId, { target: "mail" }), /Invalid target/);
  assert.throws(() => ctl.updateDraft(r.assignmentId, { playbooks: [{ name: 1 }] }), /Playbooks/);
  assert.throws(() => ctl.updateDraft("cast-none", {}), /Unknown Dispatch/);
});

test("issues reports every blocker with its wizard step", () => {
  const { ctl, state } = harness({ stack: withMission() });
  const r = ctl.startDraft({ seedContext: [OTHER] });
  const id = r.assignmentId;
  const texts = () => ctl.issues(id).map((i) => [i.step, i.text, i.fix]);
  assert.deepEqual(texts(), [[0, "Objective is required.", undefined]]);
  ctl.updateDraft(id, { objective: "Q" });
  assert.deepEqual(ctl.issues(id), []);
  state.drafts.set(OTHER, "# edited");
  assert.deepEqual(texts(), [
    [1, "Unsaved draft in entries/other.md. Save it or remove it from the context.", "save"],
  ]);
  state.drafts.clear();
  ctl.updateDraft(id, { mission: MISSION });
  assert.deepEqual(texts(), [
    [1, "Mission entries/mission.md must be an included context Entry.", "include"],
  ]);
  ctl.updateDraft(id, { mission: null, assets: ["assets/bytes.bin"] });
  assert.deepEqual(texts(), [
    [4, "Text export cannot carry Assets; deselect them or choose Files or TAR.", undefined],
  ]);
  ctl.updateDraft(id, { target: "files" });
  assert.deepEqual(ctl.issues(id), []);
  ctl.updateDraft(id, { assets: [], target: "text", scope: "complete" });
  assert.equal(ctl.issues(id)[0].step, 4);
  assert.match(ctl.issues(id)[0].text, /Complete Stack scope exports only as a TAR/);
  // Files is not enough either: only the TAR target carries the complete Stack archive.
  ctl.updateDraft(id, { target: "files" });
  assert.deepEqual(texts(), [
    [4, "Complete Stack scope exports only as a TAR (.stack.tar + dispatch.md); choose TAR-capable or switch to selected context.", undefined],
  ]);
  ctl.updateDraft(id, { target: "tar" });
  assert.deepEqual(ctl.issues(id), []);
  ctl.updateDraft(id, { scope: "selected", target: "text" });
  ctl.updateDraft(id, { permissions: { create: [OTHER] } });
  assert.deepEqual(texts(), [[3, "Already exists: entries/other.md. Choose another name.", undefined]]);
  ctl.updateDraft(id, { permissions: { create: ["ENTRIES/Nested/x.md", "Entries/nested/X.md"] } });
  assert.ok(ctl.issues(id).every((i) => i.step === 3));
  assert.ok(ctl.issues(id).some((i) => /collide|collision/i.test(i.text)));
  ctl.updateDraft(id, { permissions: { create: ["entries/other.md/new.md"] } });
  assert.ok(ctl.issues(id).some((i) => i.step === 3 && /collision/i.test(i.text)));
  ctl.updateDraft(id, { permissions: { create: [], metadata: [{ path: NOTE, keys: ["kind"] }] } });
  assert.deepEqual(texts(), [
    [3, "Metadata permission for entries/nested/note.md requires replace permission.", undefined],
  ]);
  ctl.updateDraft(id, { permissions: { metadata: [], replace: [NOTE] } });
  assert.deepEqual(texts(), [
    [3, "entries/nested/note.md must be in the context to be replaced.", "include"],
  ]);
  ctl.updateDraft(id, { permissions: { replace: [], delete: ["entries/gone.md"] } });
  assert.deepEqual(texts(), [
    [3, "Cannot be deleted: entries/gone.md is not an existing Entry.", undefined],
  ]);
  ctl.updateDraft(id, { permissions: { delete: [] } });
  const pb = (name, size = 10) => ({ name, source: "import:x", content: "# " + name + "\n" + "x".repeat(size) });
  ctl.updateDraft(id, { playbooks: [pb("A"), pb("A")] });
  assert.deepEqual(texts(), [[2, "Duplicate Playbook name: A", undefined]]);
  ctl.updateDraft(id, { playbooks: [pb("Big", 16000)] });
  assert.deepEqual(texts(), [[2, 'Playbook "Big" exceeds 16000 characters.', undefined]]);
  ctl.updateDraft(id, { playbooks: [{ name: "Empty", source: "s", content: "  \n" }] });
  assert.deepEqual(texts(), [[2, 'Playbook "Empty" is empty.', undefined]]);
  const nine = Array.from({ length: 9 }, (_, i) => pb("P" + i));
  r.draft = { ...r.draft, playbooks: nine };
  assert.deepEqual(texts()[0], [2, "At most eight Playbooks.", undefined]);
  ctl.updateDraft(id, { playbooks: Array.from({ length: 8 }, (_, i) => pb("P" + i, 9000)) });
  assert.deepEqual(texts(), [
    [2, "Cast exceeds 64 KiB; remove Playbooks or shorten the objective and criteria.", undefined],
  ]);
  ctl.updateDraft(id, { playbooks: [] });
  assert.deepEqual(ctl.issues(id), []);
});

test("preview and export compose a Cast that Cast Kit accepts", async () => {
  const { ctl, state, copies } = harness();
  const r = ready(ctl);
  ctl.updateDraft(r.assignmentId, {
    playbooks: [
      { name: "Report generation", source: "builtin:report", content: assets.playbooks["Report generation"] },
      { name: "Research", source: "builtin:research", content: assets.playbooks.Research },
    ],
    criteria: ["Cite every note."],
  });
  const p = ctl.preview(r.assignmentId);
  const c = parseCast(p.castSource);
  assert.deepEqual(c.read, ["entries/nested/note.md", "entries/other.md", "stack.yaml"]);
  assert.deepEqual(p.included, c.read);
  assert.ok(p.omitted.includes("assets/bytes.bin") && p.omitted.includes("entries/日本語-☃.md"));
  assert.equal(c.assignment_id, r.assignmentId);
  assert.equal(c.stack_id, "stk-test");
  assert.equal(c.base_revision, 3);
  assert.equal(c.mission, null);
  assert.deepEqual(c.playbooks.map((x) => x.name), ["Report generation", "Research"]);
  assert.deepEqual(c.completion, ["Cite every note."]);
  assert.deepEqual(c.permissions, { network: false, execute: false, write_files: false, transmit_to: [] });
  assert.deepEqual(c.outputs, ["Conversational answer in Return summary and evidence"]);
  assert.deepEqual(c.required_files, []);
  assert.equal(p.sizes.castBytes, encode(p.castSource).length);
  assert.ok(p.sizes.textBytes > p.sizes.castBytes);
  assert.equal(p.sizes.assetBytes, 0);
  assert.equal(r.status, "draft", "preview has no side effects");
  const { text } = await ctl.export(r.assignmentId, "copy");
  assert.equal(copies.length, 1);
  assert.equal(copies[0], text);
  assert.match(text, /^# Envoy Dispatch\n/);
  assert.ok(text.includes(assets.bootstrap.trim()));
  assert.ok(text.includes(assets.contract.trim()));
  assert.equal(r.status, "exported");
  assert.equal(r.exported.via, "copy");
  assert.equal(r.baseRevision, 3);
  assert.ok(r.exported.base && r.exported.base.files.length === state.stack.files.size);
  const exported = parseCast(r.exported.castSource);
  const h = readHandoff(r.exported.handoff);
  assert.equal(exported.dispatch_id, h.meta.dispatch_id);
  assert.equal(r.exported.dispatchId, h.meta.dispatch_id);
  assert.deepEqual(exported.read, h.meta.included_files);
  assert.deepEqual(exported.playbooks.map((x) => x.name), ["Report generation", "Research"]);
  const template = parseReturn(r.exported.returnTemplate);
  assert.equal(template.meta.assignment_id, r.assignmentId);
  assert.equal(template.meta.status, "partial");
  assert.match(template.meta.boundary, /^envoy-return-[0-9a-f]{32}$/);
  assert.deepEqual(template.meta.next, ["Continue the assigned work."]);
  assert.throws(() => ctl.updateDraft(r.assignmentId, { objective: "late" }), /no longer a draft/);
  assert.throws(() => ctl.preview(r.assignmentId), /no longer a draft/);
});

test("report preset derives outputs and required_files; replace without context is blocked", () => {
  const { ctl } = harness();
  const r = ctl.startDraft({ openPath: NOTE, preset: "report" });
  ctl.updateDraft(r.assignmentId, { objective: "Report.", consent: true });
  const c = parseCast(ctl.preview(r.assignmentId).castSource);
  assert.deepEqual(c.create, ["entries/report.md"]);
  assert.deepEqual(c.replace, [NOTE]);
  assert.deepEqual(c.required_files, ["entries/report.md", NOTE]);
  assert.deepEqual(c.outputs, [
    "Complete Markdown report at entries/report.md",
    "Complete replacement of entries/nested/note.md",
  ]);
  assert.deepEqual(c.completion, [
    "Every finding names its supplied source; unresolved limitations are explicit.",
  ]);
});

test("export requires consent and refuses while issues remain", async () => {
  const { ctl, copies } = harness();
  const r = ctl.startDraft({ seedContext: [OTHER] });
  await assert.rejects(ctl.export(r.assignmentId, "copy"), /Objective is required/);
  ctl.updateDraft(r.assignmentId, { objective: "Q" });
  await assert.rejects(ctl.export(r.assignmentId, "copy"), /consent/);
  ctl.updateDraft(r.assignmentId, { consent: true });
  await assert.rejects(ctl.export(r.assignmentId, "fax"), /Unknown export action/);
  assert.equal(copies.length, 0);
  assert.equal(r.status, "draft");
});

test("clipboard failure leaves the record a draft", async () => {
  const { ctl, persists } = harness({ clipboardFails: true });
  const r = ready(ctl);
  const before = persists.n;
  await assert.rejects(ctl.export(r.assignmentId, "copy"), {
    message: "Clipboard unavailable — use Download instead",
  });
  assert.equal(r.status, "draft");
  assert.equal(r.exported, null);
  assert.equal(persists.n, before);
});

test("download-files writes dispatch.md plus each Asset under the path name the Cast lists", async () => {
  const { ctl, downloads } = harness();
  const r = ready(ctl);
  ctl.updateDraft(r.assignmentId, { target: "files", assets: ["assets/bytes.bin"] });
  await ctl.export(r.assignmentId, "download-files");
  // Loose attachments match the Cast's `assets` entry by file name; the generated
  // `assets/0001.bin` names belong to the TAR package only, so no manifest is emitted here.
  assert.deepEqual(
    downloads.map((d) => [d.name, d.type]),
    [
      ["stk-test-dispatch-1.dispatch.md", "text/markdown"],
      ["bytes.bin", "application/octet-stream"],
    ],
  );
  const text = decode(downloads[0].bytes);
  assert.ok(text.startsWith("# Envoy Dispatch\n"));
  assert.match(text, /assets:\n\s+- assets\/bytes\.bin/);
  assert.deepEqual(downloads[1].bytes, sample().files.get("assets/bytes.bin"));
  assert.equal(parseCast(r.exported.castSource).assets[0], "assets/bytes.bin");
  assert.equal(r.status, "exported");
});

test("two Assets sharing a file name block Files export and are not offered; the TAR keeps them apart", async () => {
  const stack = sample().change({
    writes: new Map([["media/bytes.bin", new Uint8Array([1, 2, 3])]]),
  });
  const { ctl, downloads } = harness({ stack });
  const r = ready(ctl);
  ctl.updateDraft(r.assignmentId, {
    target: "files",
    assets: ["assets/bytes.bin", "media/bytes.bin"],
  });
  // The collision is a blocker and the Files action is not offered, so the UI never shows an
  // enabled button that write() would refuse.
  assert.deepEqual(ctl.issues(r.assignmentId).map((i) => [i.step, i.text]), [
    [4, "Two selected files share the name bytes.bin; loose files cannot keep them apart. Choose TAR-capable, or deselect one."],
  ]);
  assert.deepEqual(ctl.exportActions(r.assignmentId), []);
  await assert.rejects(ctl.export(r.assignmentId, "download-files"), /share the name bytes\.bin/);
  assert.equal(downloads.length, 0);
  assert.equal(r.status, "draft");
  ctl.updateDraft(r.assignmentId, { target: "tar" });
  await ctl.export(r.assignmentId, "download-tar");
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].name, /\.dispatch\.tar$/);
});

test("complete scope exports the actual complete Stack archive plus dispatch.md", async () => {
  const { ctl, downloads, state } = harness();
  const r = ready(ctl);
  ctl.updateDraft(r.assignmentId, { scope: "complete", target: "tar" });
  assert.deepEqual(ctl.issues(r.assignmentId), []);
  await ctl.export(r.assignmentId, "download-tar");
  assert.deepEqual(
    downloads.map((d) => [d.name, d.type]),
    [
      ["stk-test-r3.stack.tar", "application/x-tar"],
      ["stk-test-dispatch-1.dispatch.md", "text/markdown"],
    ],
  );
  const { readTar } = await import("../src/archives/tar.js");
  const { sameStack } = await import("../src/core/stack.js");
  const archive = readTar(downloads[0].bytes);
  assert.ok(sameStack(archive, state.stack));
  assert.ok(archive.directories.has("empty"));
  const cast = parseCast(r.exported.castSource);
  assert.deepEqual(cast.assets, ["assets/bytes.bin"]);
  assert.ok(decode(downloads[1].bytes).includes(r.exported.castSource));
  // The same bytes again while the base is retained.
  await ctl.exportAgain(r.assignmentId, "download-tar");
  assert.deepEqual(downloads[2].bytes, downloads[0].bytes);
  // Copy or loose files would hand over only dispatch.md, not the complete Stack.
  for (const via of ["copy", "download-md", "download-files"])
    await assert.rejects(ctl.exportAgain(r.assignmentId, via), /exports only as a TAR/);
  assert.equal(downloads.length, 4);
});

test("download-tar and download-md name the files after the Stack and seq", async () => {
  const { ctl, downloads } = harness();
  const a = ready(ctl);
  ctl.updateDraft(a.assignmentId, { target: "tar" });
  await ctl.export(a.assignmentId, "download-tar");
  const b = ready(ctl);
  await ctl.export(b.assignmentId, "download-md");
  assert.deepEqual(
    downloads.map((d) => [d.name, d.type]),
    [
      ["stk-test-dispatch-1.dispatch.tar", "application/x-tar"],
      ["stk-test-dispatch-2.dispatch.md", "text/markdown"],
    ],
  );
  assert.equal(downloads[0].bytes.length % 512, 0);
  assert.ok(decode(downloads[1].bytes).startsWith("# Envoy Dispatch\n"));
});

test("text exports refuse Assets even when the target can carry them", async () => {
  const { ctl } = harness();
  const r = ready(ctl);
  ctl.updateDraft(r.assignmentId, { target: "files", assets: ["assets/bytes.bin"] });
  assert.deepEqual(ctl.issues(r.assignmentId), []);
  await assert.rejects(ctl.export(r.assignmentId, "copy"), /Text export cannot carry Assets/);
  assert.equal(r.status, "draft");
  ctl.updateDraft(r.assignmentId, { target: "text" });
  await assert.rejects(ctl.export(r.assignmentId, "download-tar"), /Text export cannot carry Assets/);
});

test("exportActions is the single list of supported exports, and write() enforces it", async () => {
  const { ctl, downloads, copies } = harness();
  const r = ready(ctl);
  const id = r.assignmentId;
  assert.deepEqual(ctl.exportActions(id), ["copy", "download-md"]);
  ctl.updateDraft(id, { target: "files" });
  assert.deepEqual(ctl.exportActions(id), ["download-files", "copy", "download-md"]);
  ctl.updateDraft(id, { assets: ["assets/bytes.bin"] });
  assert.deepEqual(ctl.exportActions(id), ["download-files"]);
  ctl.updateDraft(id, { target: "tar" });
  assert.deepEqual(ctl.exportActions(id), ["download-tar"]);
  ctl.updateDraft(id, { target: "text" });
  assert.deepEqual(ctl.exportActions(id), []);
  ctl.updateDraft(id, { assets: [], scope: "complete", target: "tar" });
  assert.deepEqual(ctl.exportActions(id), ["download-tar"]);
  ctl.updateDraft(id, { scope: "selected", target: "files", assets: ["assets/bytes.bin"] });
  await assert.rejects(ctl.export(id, "copy"), /Text export cannot carry Assets/);
  await ctl.export(id, "download-files");
  assert.equal(copies.length, 0);
  // Download again / Copy again follow the same list for the exported record.
  assert.deepEqual(ctl.exportActions(id), ["download-files"]);
  await assert.rejects(ctl.exportAgain(id, "download-md"), /Text export cannot carry Assets/);
  await assert.rejects(ctl.exportAgain(id, "download-tar"), /does not support download-tar/);
  const before = downloads.length;
  await ctl.exportAgain(id, "download-files");
  assert.equal(downloads.length, before + 2);
});

test("invariant: every offered export action succeeds and every other action is refused", async () => {
  const stack = sample().change({
    writes: new Map([["media/bytes.bin", new Uint8Array([1, 2, 3])]]),
  });
  const VIAS = ["copy", "download-md", "download-files", "download-tar"];
  const selections = [[], ["assets/bytes.bin"], ["assets/bytes.bin", "media/bytes.bin"]];
  let checked = 0;
  for (const scope of ["selected", "complete"])
    for (const target of ["text", "files", "tar"])
      for (const assets of selections)
        for (const via of VIAS) {
          const { ctl } = harness({ stack });
          const r = ready(ctl);
          ctl.updateDraft(r.assignmentId, { scope, target, assets });
          const offered = ctl.exportActions(r.assignmentId);
          const blocked = ctl.issues(r.assignmentId).length > 0;
          const label = JSON.stringify({ scope, target, assets, via, offered, blocked });
          if (offered.includes(via) && !blocked) {
            await ctl.export(r.assignmentId, via);
            assert.equal(r.status, "exported", label);
          } else {
            await assert.rejects(ctl.export(r.assignmentId, via), Error, label);
            assert.equal(r.status, "draft", label);
          }
          // An unblocked draft always offers at least one working action.
          if (!blocked) assert.ok(offered.length > 0, label);
          checked++;
        }
  assert.equal(checked, 2 * 3 * 3 * 4);
});

test("exportAgain reproduces the same bytes and downloadCast writes the Cast", async () => {
  const { ctl, copies, downloads } = harness();
  const r = ready(ctl);
  const { text } = await ctl.export(r.assignmentId, "copy");
  const updated = r.updatedAt;
  const again = await ctl.exportAgain(r.assignmentId, "copy");
  assert.equal(again.text, text);
  assert.equal(copies[1], copies[0]);
  await ctl.exportAgain(r.assignmentId, "download-md");
  assert.equal(decode(downloads[0].bytes), text);
  assert.equal(r.status, "exported");
  assert.notEqual(r.updatedAt, updated);
  ctl.downloadCast(r.assignmentId);
  assert.equal(downloads[1].name, `${r.assignmentId}.cast.yaml`);
  assert.equal(decode(downloads[1].bytes), r.exported.castSource);
  const d = ctl.startDraft();
  assert.throws(() => ctl.downloadCast(d.assignmentId), /not been exported/);
  await assert.rejects(ctl.exportAgain(d.assignmentId, "copy"), /not been exported/);
});

test("a ninth pending Dispatch is refused until one releases its base", async () => {
  const { ctl, state } = harness();
  for (let i = 0; i < 8; i++) await ctl.export(ready(ctl).assignmentId, "copy");
  assert.equal(state.dispatches.filter((x) => x.exported?.base).length, 8);
  const ninth = ready(ctl);
  assert.deepEqual(ctl.issues(ninth.assignmentId), [
    { step: 4, text: "8 Dispatches already await a Return; accept, reject or abandon one before exporting." },
  ]);
  await assert.rejects(ctl.export(ninth.assignmentId, "copy"), /8 Dispatches already await/);
  ctl.abandon(state.dispatches[0].assignmentId);
  assert.equal(state.dispatches[0].status, "abandoned");
  assert.equal(state.dispatches[0].exported.base, null);
  assert.deepEqual(ctl.issues(ninth.assignmentId), []);
  await ctl.export(ninth.assignmentId, "copy");
  assert.equal(ninth.status, "exported");
});

test("discard removes drafts only and abandon applies to pending records only", async () => {
  const { ctl, state } = harness();
  const d = ctl.startDraft();
  const e = ready(ctl);
  await ctl.export(e.assignmentId, "copy");
  assert.throws(() => ctl.discard(e.assignmentId), /no longer a draft/);
  assert.throws(() => ctl.abandon(d.assignmentId), /cannot be abandoned while draft/);
  ctl.discard(d.assignmentId);
  assert.deepEqual(state.dispatches, [e]);
  ctl.abandon(e.assignmentId);
  assert.equal(e.status, "abandoned");
  assert.throws(() => ctl.abandon(e.assignmentId), /cannot be abandoned while abandoned/);
});

test("redispatch copies the assignment to a new draft at the current revision", async () => {
  const { ctl, state } = harness({ stack: withMission() });
  const r = ctl.startDraft({ seedContext: [NOTE, OTHER, MISSION], openPath: NOTE, preset: "report" });
  ctl.updateDraft(r.assignmentId, {
    objective: "Report on the notes.",
    criteria: ["Cite."],
    consent: true,
    permissions: { metadata: [{ path: NOTE, keys: ["kind"] }] },
  });
  await ctl.export(r.assignmentId, "copy");
  state.stack = state.stack.change({ deletes: [OTHER] });
  const next = ctl.redispatch(r.assignmentId);
  assert.equal(r.status, "exported");
  assert.equal(next.status, "draft");
  assert.equal(next.seq, 2);
  assert.equal(next.baseRevision, 5);
  assert.equal(next.draft.objective, "Report on the notes.");
  assert.deepEqual(next.draft.criteria, ["Cite."]);
  assert.deepEqual(next.draft.context, [MISSION, NOTE]);
  assert.equal(next.draft.mission, MISSION);
  assert.equal(next.draft.preset, "report");
  assert.deepEqual(next.draft.playbooks.map((p) => p.name), ["Research", "Report generation"]);
  assert.deepEqual(next.draft.permissions.replace, [NOTE]);
  assert.deepEqual(next.draft.permissions.create, ["entries/report.md"]);
  assert.deepEqual(next.draft.permissions.metadata, [{ path: NOTE, keys: ["kind"] }]);
  assert.equal(next.draft.consent, false);
  assert.deepEqual(ctl.issues(next.assignmentId), []);
});

test("continueFrom seeds surviving context plus files the accepted Return created", async () => {
  const { ctl, state } = harness();
  const r = ctl.startDraft({ openPath: NOTE, preset: "report" });
  ctl.updateDraft(r.assignmentId, { objective: "Report.", consent: true });
  await ctl.export(r.assignmentId, "copy");
  assert.throws(() => ctl.continueFrom(r.assignmentId), /no accepted or checkpoint Return/);
  const c = parseCast(r.exported.castSource);
  const receipt = encodeReturn(
    {
      format: "envoy.return/v0.1",
      assignment_id: c.assignment_id,
      dispatch_id: c.dispatch_id,
      stack_id: c.stack_id,
      base_revision: c.base_revision,
      checkpoint_id: "checkpoint-1",
      parent_checkpoint: null,
      status: "partial",
      summary: "Report drafted.",
      objective: c.objective,
      accepted: [], evidence: [], decisions: [], completed: [], questions: [], blockers: [],
      next: ["Review."], verification: [], errors: [], capabilities: [], operations_performed: [],
      creates: ["entries/report.md"],
      replaces: [],
      deletes: [],
      renames: [],
      boundary: "continue-test-boundary-0001",
    },
    new Map([["entries/report.md", "---\nid: ent-report\n---\n# Report\n"]]),
  );
  // Simulate the accepted outcome the return controller records.
  state.stack = state.stack.change({
    writes: new Map([["entries/report.md", encode("---\nid: ent-report\n---\n# Report\n")]]),
    deletes: [NOTE],
  });
  r.status = "accepted";
  r.receipts = [{ kind: "accepted", source: receipt, at: "t" }];
  const next = ctl.continueFrom(r.assignmentId);
  assert.deepEqual(next.draft.context, ["entries/report.md"]);
  assert.equal(next.draft.preset, "report");
  assert.deepEqual(next.draft.playbooks.map((p) => p.name), ["Research", "Report generation"]);
  assert.equal(next.draft.objective, "");
  assert.deepEqual(next.draft.permissions.create, []);
  assert.equal(next.baseRevision, 4);
});

test("Dispatch actions refuse an ordinary copy, including callbacks retained from an earlier Stack", async () => {
  const { state, ctl, downloads, copies, persists } = harness();
  const exported = ready(ctl);
  await ctl.export(exported.assignmentId, "download-md");
  const draft = ready(ctl);
  const stack = state.stack,
    records = structuredClone(state.dispatches),
    seen = { downloads: downloads.length, copies: copies.length, persists: persists.n };
  state.stack = new LocalFolder([["note.md", encode("# Ordinary\n")]], [], { title: "Local files" });
  const refused = /requires an Envoy Stack/;
  assert.throws(() => ctl.startDraft(), refused);
  assert.throws(() => ctl.updateDraft(draft.assignmentId, { objective: "Changed" }), refused);
  assert.throws(() => ctl.discard(draft.assignmentId), refused);
  await assert.rejects(ctl.export(draft.assignmentId, "copy"), refused);
  await assert.rejects(ctl.exportAgain(exported.assignmentId, "download-md"), refused);
  await assert.rejects(ctl.exportAgain(exported.assignmentId, "copy"), refused);
  assert.throws(() => ctl.downloadCast(exported.assignmentId), refused);
  assert.throws(() => ctl.abandon(exported.assignmentId), refused);
  assert.throws(() => ctl.exportActions(exported.assignmentId), refused);
  assert.deepEqual(state.dispatches, records);
  assert.deepEqual({ downloads: downloads.length, copies: copies.length, persists: persists.n }, seen);
  // The same records work again once a valid Stack is active.
  state.stack = stack;
  await ctl.exportAgain(exported.assignmentId, "download-md");
  assert.equal(downloads.length, seen.downloads + 1);
  assert.deepEqual(downloads.at(-1).bytes, downloads[0].bytes);
});
