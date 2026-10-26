import { editorText, fillEditor } from "./editor-browser-helpers.mjs";
/** Integrated Dispatch / Return acceptance against the built, offline file:// distributable.
 * Invoked by tests/browser.mjs after `refinements`; its report lands in
 * test-results/browser.json under `dispatchFlows`.
 *
 * Every scenario drives the REAL flow through the UI: import a Stack, compose a Dispatch in
 * the docked wizard, export it, build an `envoy.return/v0.1` Return with Cast Kit against the
 * exported Cast, import it through the Import Return dialog, review it and decide. Nothing is
 * stubbed except where a scenario says so (clipboard, IndexedDB failure). Each scenario runs in
 * its own browser context (own IndexedDB), offline, and asserts zero http(s) requests and zero
 * page errors at the end.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { menuClick } from "./refinements-browser.mjs";
import { sample } from "./helpers.js";
import { Stack } from "../src/core/stack.js";
import { encode, decode } from "../src/core/validate.js";
import { entry } from "../src/core/entries.js";
import { readTar, writeTar } from "../src/archives/tar.js";
import { gunzip } from "../src/archives/gzip.js";
import { parseCast, parseReturn, encodeReturn } from "../cast-kit/src/kit.mjs";
import * as fixtures from "../cast-kit/tests/fixtures.mjs";
import { planningFixture } from "../cast-kit/tests/planning-fixture.mjs";

const require = createRequire(import.meta.url);
/** @type {{playbooks: Record<string,string>, contract: string, bootstrap: string}} */
const castkitAssets = require("../src/carbon/castkit-assets.json");

const DIST = pathToFileURL(resolve("dist/carbon.html")).href;
const CAST_BLOCK = /## User-authorized Cast and ordered Playbooks\n\n```yaml\n([\s\S]*?)\n```/;
const THEMES = ["dark", "light"];
const SIZES = [
  [1440, 900],
  [1000, 700],
  [800, 650],
];
const REVIEW_SELECTORS = [".chip", ".op", ".udiff td", ".checks li", "#review-reason"];

/** Extract and parse the Cast embedded in an exported dispatch.md. */
export function castOf(text) {
  const m = CAST_BLOCK.exec(text);
  assert.ok(m, "exported text carries the Cast block");
  return parseCast(m[1]);
}

/** A Return receipt for an exported Cast; identity fields come from the Cast itself. */
export function receiptFor(cast, overrides = {}) {
  return {
    format: "envoy.return/v0.1",
    assignment_id: cast.assignment_id,
    dispatch_id: cast.dispatch_id,
    stack_id: cast.stack_id,
    base_revision: cast.base_revision,
    checkpoint_id: `checkpoint-${cast.assignment_id.slice(5, 13)}-${Math.random().toString(16).slice(2, 8)}`,
    parent_checkpoint: null,
    status: "complete",
    summary: "Answered from the supplied Entries only.",
    objective: cast.objective,
    accepted: [],
    evidence: ["entries: headings and bodies as supplied in the Dispatch"],
    decisions: [],
    completed: ["Reviewed the supplied context."],
    questions: [],
    blockers: [],
    next: [],
    verification: ["Checked every claim against the supplied Entry text."],
    errors: [],
    capabilities: ["text"],
    operations_performed: [],
    creates: [],
    replaces: [],
    deletes: [],
    renames: [],
    boundary: `browser-return-boundary-${Math.random().toString(16).slice(2, 10)}`,
    ...overrides,
  };
}

/** Re-address a fixture Return to a Carbon-exported Cast (ids, base, objective, boundary). */
function readdress(source, cast, extra = {}) {
  const { meta, files } = parseReturn(source);
  return encodeReturn(
    {
      ...meta,
      assignment_id: cast.assignment_id,
      dispatch_id: cast.dispatch_id,
      stack_id: cast.stack_id,
      base_revision: cast.base_revision,
      objective: cast.objective,
      ...extra,
    },
    files,
  );
}

/** Minimal ustar reader for a selected Dispatch package (not a Stack; readTar refuses it). */
function readUstar(bytes) {
  const files = new Map();
  const td = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const h = bytes.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) break;
    const name = td.decode(h.subarray(0, 100)).replace(/\0[\s\S]*$/, "");
    const size = parseInt(td.decode(h.subarray(124, 136)).replace(/\0[\s\S]*$/, "").trim(), 8);
    files.set(name, bytes.slice(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Harbor demo Stack (Cast Kit fixture) with an explicit empty directory. */
const harbor = () => new Stack(fixtures.fullFiles(), ["empty"]);
/** The fixture findings with one line rewritten, so the replace diff has both + and − rows. */
const findingsBody = fixtures.findings.replace("No field-level assessment yet.", "Field-level assessment follows.");

/**
 * Run the integrated Dispatch / Return scenarios.
 * @param {import("playwright").Browser} browser
 * @returns {Promise<object>} report merged into test-results/browser.json
 */
export async function dispatchFlows(browser) {
  const started = Date.now();
  const scenarios = [],
    screenshots = [],
    contrasts = [],
    allErrors = [],
    allNetwork = [];
  const reportTimes = {};

  /** Open an offline context with request / pageerror capture. */
  async function session(options = {}, init = null) {
    const context = await browser.newContext({
      offline: true,
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
      ...options,
    });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    const errors = [],
      network = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (/^https?:/.test(r.url())) network.push(r.url());
    });
    page.on("dialog", (d) => d.accept());
    const ready = () =>
      page.waitForFunction(
        () => document.getElementById("notice").textContent !== "Opening local workspace…",
      );
    await page.goto(DIST);
    await ready();
    const s = {
      context,
      page,
      errors,
      network,
      ready,
      /** Accept the open dialog and wait for the UI to be idle again. */
      accept: async () => {
        await page.locator("#dialog-accept").click();
        await page.waitForFunction(
          () => !document.getElementById("dialog").open && document.getElementById("workspace").getAttribute("aria-busy") !== "true",
        );
      },
      upload: (name, buffer) =>
        page.locator("#files").setInputFiles({
          name,
          mimeType: "application/octet-stream",
          buffer: Buffer.from(buffer),
        }),
      /** Import a complete Stack TAR through the Import route and confirm the preview. */
      importStack: async (stack, name = "demo.stack.tar") => {
        await s.upload(name, writeTar(stack));
        await page.waitForSelector("#dialog[open]");
        await s.accept();
        await page.waitForFunction(
          (rev) => document.getElementById("stack-meta").textContent.includes(`revision ${rev}`),
          stack.manifest.revision,
        );
      },
      open: async (p) => {
        await page.locator(`#tree button[title="${p}"]`).click();
        await page.waitForFunction((p) => document.getElementById("current-path").textContent === p, p);
      },
      check: (p) => page.locator(`#tree input[aria-label="Include ${p} in Needlecast"]`).check(),
      revision: async () => Number(/revision (\d+)/.exec(await page.locator("#stack-meta").textContent())[1]),
      notice: () => page.locator("#notice").textContent(),
      drawerVisible: () => page.waitForFunction(() => !document.getElementById("drawer").hidden),
      drawerHidden: () => page.waitForFunction(() => document.getElementById("drawer").hidden),
      reviewVisible: () => page.waitForFunction(() => !document.getElementById("review").hidden),
      reviewHidden: () => page.waitForFunction(() => document.getElementById("review").hidden),
      /** Step button by index (0..4). */
      step: async (i) => {
        await page.locator("#drawer-steps button").nth(i).click();
        await page.waitForFunction(
          (i) => document.querySelectorAll("#drawer-steps button")[i].getAttribute("aria-current") === "step",
          i,
        );
      },
      /**
       * Start a Dispatch from the toolbar (or the editor's Dispatch this), choose the preset
       * and type the objective. Returns nothing; the drawer stays on step 1.
       */
      startDispatch: async ({ via = "dispatch", preset = null, objective }) => {
        await menuClick(page, via);
        await s.drawerVisible();
        await page.waitForFunction(() => document.activeElement.id === "draft-objective");
        if (preset) {
          await page.locator(`#drawer input[name="preset"][value="${preset}"]`).check();
          await page.waitForFunction(
            (preset) => document.querySelector(`#drawer input[name="preset"][value="${preset}"]`).checked,
            preset,
          );
        }
        await page.locator("#draft-objective").fill(objective);
        await page.waitForFunction(
          (o) => document.querySelector("#dispatches .dcard .obj")?.textContent.includes(o.slice(0, 20)),
          objective,
        );
      },
      /** Jump to Review & export and tick the consent box. */
      toReview: async () => {
        if (!(await page.locator("#drawer-skip").isHidden())) await page.locator("#drawer-skip").click();
        else await s.step(4);
        await page.waitForSelector("#draft-consent");
        await page.locator("#draft-consent").check();
        await page.waitForFunction(() => document.getElementById("draft-consent").checked);
      },
      /** Click an export button in the Review step and read the download. */
      exportDownload: async (via) => {
        const event = page.waitForEvent("download");
        await page.locator(`#drawer [data-via="${via}"]`).click();
        const d = await event;
        await page.waitForFunction(() => document.getElementById("notice").textContent.includes("Nothing has been sent"));
        return { bytes: new Uint8Array(await readFile(await d.path())), name: d.suggestedFilename() };
      },
      /** Full quick path: consent + Download dispatch.md; returns {text, cast}. */
      exportMd: async () => {
        await s.toReview();
        const { bytes, name } = await s.exportDownload("download-md");
        const text = decode(bytes);
        return { text, cast: castOf(text), name };
      },
      /** Paste a Return in the Import Return dialog; resolves "review" or the inline error text. */
      importReturn: async (text, { expectError = false } = {}) => {
        await menuClick(page, "import-return");
        await page.waitForSelector("#return-text");
        await page.locator("#return-text").fill(text);
        await page.locator("#dialog-accept").click();
        await page.waitForFunction(
          () =>
            !document.getElementById("review").hidden ||
            (document.getElementById("dialog").open && document.querySelector("#dialog .err")) ||
            document.querySelector("#dialog .diff"),
          null,
          { timeout: 15000 },
        );
        const error = await page.evaluate(() => document.querySelector("#dialog .err b")?.textContent || null);
        if (expectError) {
          assert.ok(error, "expected an inline Import Return error");
          await page.locator("#dialog-cancel").click();
          await page.waitForFunction(() => !document.getElementById("dialog").open);
          return error;
        }
        assert.equal(error, null, `unexpected Import Return error: ${error}`);
        return "review";
      },
      checks: () =>
        page.$$eval("#review-receipt .checks li", (lis) =>
          lis.map((li) => ({ ok: !li.classList.contains("fail"), text: li.textContent.replace(/^[✓✕]?\s*(Passed|Failed): /, "").trim() })),
        ),
      cardChip: (seq) =>
        page
          .locator("#dispatches .dcard", { hasText: `Dispatch ${seq} ·` })
          .locator(".chip")
          .textContent(),
      card: (seq) => page.locator("#dispatches .dcard", { hasText: `Dispatch ${seq} ·` }),
      setTheme: (theme) =>
        page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme),
      shot: async (name) => {
        const file = `test-results/carbon-flow-${name}.png`;
        await page.screenshot({ path: file });
        screenshots.push(file);
      },
      /** Same sampler as tests/refinements-browser.mjs (not exported there): text vs nearest opaque background. */
      checkContrast: async (label, selectors) => {
        const result = await page.evaluate((selectors) => {
          const rgb = (value) => value.match(/[\d.]+/g)?.map(Number) || [];
          const lum = (c) =>
            c
              .slice(0, 3)
              .map((v) => v / 255)
              .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
              .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          const ratio = (a, b) => {
            const x = lum(a),
              y = lum(b);
            return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
          };
          const samples = [];
          for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
              if (!el.getClientRects().length || !el.textContent.trim()) continue;
              const style = getComputedStyle(el);
              let parent = el,
                bg;
              while (parent) {
                const candidate = rgb(getComputedStyle(parent).backgroundColor);
                if (candidate.length === 3 || candidate[3] > 0) {
                  bg = candidate;
                  break;
                }
                parent = parent.parentElement;
              }
              samples.push({ selector, text: el.textContent.trim().slice(0, 40), ratio: ratio(rgb(style.color), bg || [255, 255, 255]) });
            }
          }
          return samples;
        }, selectors);
        assert.ok(result.length > 0, `${label}: nothing sampled`);
        for (const sample of result) assert.ok(sample.ratio >= 4.5, `${label}: ${JSON.stringify(sample)}`);
        contrasts.push({ theme: label, samples: result.length, minTextRatio: Math.min(...result.map((x) => x.ratio)) });
      },
      close: async () => {
        allErrors.push(...errors);
        allNetwork.push(...network);
        await context.close();
      },
    };
    return s;
  }

  /** Time one named scenario; failures are recorded then rethrown so the suite fails. */
  async function scenario(name, fn) {
    const t = Date.now();
    try {
      await fn();
      scenarios.push({ name, status: "pass", ms: Date.now() - t });
    } catch (e) {
      scenarios.push({ name, status: "fail", ms: Date.now() - t, error: e.message });
      throw e;
    }
  }

  await scenario("workspace review: accepted rename, delayed persistence, refreshed links and editor history survive", async () => {
    const s = await session();
    try {
      const { page } = s, from = "entries/nested/note.md", to = "entries/nested/note-renamed.md", ref = "entries/reference.md";
      await s.importStack(sample().change({writes:new Map([[ref, encode("# Reference\n[[ent-note|Working note]]\n" + "Detail\n\n".repeat(100))]])}));
      await s.open(from);
      const original = await editorText(page);
      await page.locator("#editor .cm-content").press("Control+End");
      await page.keyboard.insertText("\nSaved navigation test.");
      const saved = await editorText(page);
      await page.locator("#save-entry").click();
      await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") !== "true");
      await page.evaluate(() => carbonTestSelect([[3,9]]));
      await page.getByRole("button", {name:`Open ${from} in Viewer`,exact:true}).click();
      await page.getByRole("button", {name:`Open ${ref} in Viewer`,exact:true}).click();
      assert.equal(await page.locator("#viewer-content a").getAttribute("data-entry"),from);
      await s.startDispatch({via:"dispatch-this",preset:"question",objective:"Rename the working note."});
      await s.step(3);
      await page.locator("#drawer details.adv summary").click();
      await page.getByRole("checkbox", {name:`May rename ${from}`,exact:true}).check();
      const {cast} = await s.exportMd();
      const previous = await s.revision();
      await s.importReturn(encodeReturn(receiptFor(cast,{renames:[[from,to]]}),new Map()));
      await page.evaluate(() => {
        window.holdAccepted = true;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value,...args) {
          // carbon-vfs also writes the switcher index in the same transaction: mark, never unmark.
          if (window.holdAccepted && value?.dispatches?.some(r => r.status === "accepted")) {
            this.transaction.delayAccepted = true;
            window.holdAccepted = false;
          }
          return put.call(this,value,...args);
        };
        const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype,"oncomplete");
        Object.defineProperty(IDBTransaction.prototype,"oncomplete",{...descriptor,set(fn) {
          const transaction = this;
          descriptor.set.call(this, this.delayAccepted ? function(event) {
            window.acceptanceHeld = true;
            window.releaseAcceptance = () => fn.call(transaction,event);
          } : fn);
        }});
      });
      await page.locator("#review-accept").click();
      await page.locator("#dialog-accept").click();
      await page.waitForFunction(() => window.acceptanceHeld);
      await page.locator("#viewer-content").evaluate(el => el.dispatchEvent(new Event("scroll")));
      await page.waitForTimeout(600);
      await page.evaluate(() => { window.releaseAcceptance(); });
      await s.reviewHidden();
      assert.equal(await s.revision(), previous+1);
      assert.equal(await page.locator("#current-path").textContent(),to);
      assert.equal(await page.locator(`#viewer-tabs [data-path="${to}"]`).count(),1);
      assert.equal(await page.locator("#viewer-content a").getAttribute("data-entry"),to);
      assert.deepEqual(await page.evaluate(() => [carbonTestView().state.selection.main.anchor,carbonTestView().state.selection.main.head]),[3,9]);
      await page.locator("#editor .cm-content").press("Control+z");
      assert.equal(await editorText(page),original);
      await page.locator("#editor .cm-content").press("Control+Shift+z");
      assert.equal(await editorText(page),saved);
      await page.waitForTimeout(700);
      await page.reload(); await s.ready();
      assert.equal(await s.revision(),previous+1);
      assert.equal(await page.locator("#current-path").textContent(),to);
      assert.equal(await page.locator(`#viewer-tabs [data-path="${to}"]`).count(),1);
      assert.match(await s.cardChip(1),new RegExp(`Accepted → rev ${previous+1}`));
      await page.locator("#viewer-content a").click();
      assert.equal(await page.locator("#viewer-path").textContent(),to);
      assert.equal(await page.locator("#current-path").textContent(),to);
    } finally { await s.close(); }
  });

  await scenario("full workspace refuses Save answer without evicting a tab or saving a receipt", async () => {
    const s=await session();
    try {
      const paths=Array.from({length:20},(_,i)=>`entries/tab-${i}.md`);
      await s.importStack(sample().change({writes:new Map(paths.map(p=>[p,encode("# Reference")]))}));
      for(const p of paths) await s.open(p);
      const before=await s.page.locator('#editor-tabs [role="tab"]').evaluateAll(nodes=>nodes.map(n=>n.dataset.path));
      assert.equal(before.length,20);
      await s.startDispatch({via:"dispatch-this",preset:"question",objective:"Summarize this note."});
      const {cast}=await s.exportMd();
      await s.importReturn(encodeReturn(receiptFor(cast),new Map()));
      const revision=await s.revision();
      await s.page.locator("#review-save-answer").click();
      await s.page.locator("#dialog input").fill("entries/answer-over-limit.md");
      await s.accept();
      assert.match(await s.notice(),/Close a tab/);
      assert.equal(await s.revision(),revision);
      assert.match(await s.cardChip(1),/Return staged/);
      assert.equal(await s.page.locator('#tree button[title="entries/answer-over-limit.md"]').count(),0);
      assert.deepEqual(await s.page.locator('#editor-tabs [role="tab"]').evaluateAll(nodes=>nodes.map(n=>n.dataset.path)),before);
    } finally {await s.close();}
  });

  // ---- 1. Quick question -------------------------------------------------------------------
  await scenario("1 quick question: export, zero-op Return, receipt, save answer as Entry", async () => {
    const s = await session();
    try {
      const { page } = s;
      await s.importStack(sample());
      await s.open("entries/nested/note.md");
      await s.startDispatch({ objective: "What does the note say? Cite the Entry." });
      const { text, cast } = await s.exportMd();
      const firstLine = (t) => t.split("\n").find((l) => l.trim());
      assert.ok(text.includes(firstLine(castkitAssets.playbooks.Research.replace(/^---[\s\S]*?---\n/, ""))), "Research Playbook embedded");
      assert.ok(text.includes(firstLine(castkitAssets.contract)), "operating contract embedded");
      assert.ok(text.includes("# Envoy Handoff\n"), "handoff context embedded");
      assert.ok(text.includes("## Return template") && text.includes("# Envoy Cast Return\n"), "Return template embedded");
      assert.deepEqual(cast.permissions, { network: false, execute: false, write_files: false, transmit_to: [] });
      assert.deepEqual([cast.create, cast.replace, cast.delete, cast.rename], [[], [], [], []]);
      assert.deepEqual(cast.read, ["entries/nested/note.md", "stack.yaml"]);
      assert.equal(cast.base_revision, 3);
      assert.match(await s.cardChip(1), /Exported · awaiting Return/);
      assert.match(await page.locator("#drawer-chip").textContent(), /Exported · awaiting Return/);
      const ret = encodeReturn(receiptFor(cast, { summary: "The note says Original and that evidence stays. <b>html</b>" }), new Map());
      await s.importReturn(ret);
      const checks = await s.checks();
      assert.equal(checks.length, 7);
      assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
      assert.deepEqual(
        checks.map((c) => c.text),
        [
          "Framing and format envoy.return/v0.1",
          `Matches registered Cast ${cast.assignment_id}`,
          "Base revision 3 matches the current Stack byte-for-byte",
          "Every change is within Cast permissions",
          "New Entry IDs are unique across the full Stack, including omitted Entries",
          "Omitted Entries and Assets are untouched",
          "No unsaved editor changes",
        ],
      );
      assert.equal(await page.locator("#review-accept").count(), 0);
      assert.ok((await page.locator("#review-receipt").innerHTML()).includes("&lt;b&gt;html&lt;/b&gt;"), "summary rendered as text");
      assert.match(await page.locator("#review-reason").textContent(), /no file operations/);
      await page.locator("#review-save-receipt").click();
      await s.reviewHidden();
      assert.match(await s.cardChip(1), /Checkpoint/);
      assert.equal(await s.revision(), 3);
      // A second zero-op Return on the checkpoint record can be saved as a note Entry.
      const ret2 = encodeReturn(receiptFor(cast, { summary: "Second answer: the heading is Original." }), new Map());
      await s.importReturn(ret2);
      await page.locator("#review-save-answer").click();
      await page.waitForSelector("#dialog[open]");
      const suggested = await page.locator("#dialog input").inputValue();
      assert.match(suggested, /^entries\/note-\d{8}-\d{3}\.md$/);
      await s.accept();
      await s.reviewHidden();
      assert.equal(await s.revision(), 4);
      assert.equal(await page.locator("#current-path").textContent(), suggested);
      assert.match(await editorText(page), /Second answer: the heading is Original\./);
      assert.match(await s.cardChip(1), /Checkpoint/);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 2. Full report flow (harbor fixture) + 13. layout/accessibility with real data ------
  {
    const s = await session({ reducedMotion: "reduce" });
    try {
      const { page } = s;
      let cast, text;
      await scenario("2a report flow: harbor import, wizard with ordered Playbooks, deliverables, export", async () => {
        await s.importStack(harbor(), "harbor.stack.tar");
        await s.open("entries/findings.md");
        for (const p of ["entries/mission.md", "entries/source.md", "entries/findings.md"]) await s.check(p);
        assert.match(await page.locator("#toolbar-selection").textContent(), /3 Entries checked/);
        await s.startDispatch({ preset: "report", objective: fixtures.cast("report").objective });
        assert.equal(await page.locator("#draft-mission").inputValue(), "entries/mission.md");
        assert.match(await page.locator("#drawer-sub").textContent(), /Mission: entries\/mission\.md/);
        await s.step(1);
        const body = await page.locator("#drawer-body").textContent();
        for (const p of ["entries/mission.md", "entries/source.md", "entries/findings.md"])
          assert.equal(await page.locator(`#drawer-body input[aria-label="Include ${p} in this Dispatch"]`).isChecked(), true);
        assert.equal(await page.locator('#drawer-body input[aria-label="Include entries/retained.md in this Dispatch"]').isChecked(), false);
        assert.match(body, /Omitted · 2/);
        assert.match(body, /assets\/marker\.bin/);
        await s.step(2);
        const names = () => page.$$eval(".pb.sel .pbname", (b) => b.map((x) => x.textContent.trim()));
        assert.deepEqual(await names(), ["Research", "Report generation"]);
        await page.locator(".pb", { hasText: "Critical review" }).getByRole("button", { name: "+ Add" }).click();
        await page.waitForFunction(() => document.querySelectorAll(".pb.sel").length === 3);
        assert.deepEqual(await names(), ["Research", "Report generation", "Critical review"]);
        await page.locator('button[aria-label="Move Critical review up"]').click();
        await page.waitForFunction(() => document.querySelectorAll(".pb.sel .pbname")[1].textContent.trim() === "Critical review");
        const visibleOrder = await names();
        assert.deepEqual(visibleOrder, ["Research", "Critical review", "Report generation"]);
        await s.step(3);
        assert.equal(await page.locator("#draft-create").inputValue(), "entries/report.md");
        const mayReplace = (p) => page.locator("#drawer-body label.check", { hasText: p }).filter({ hasText: "Keeps its ID" }).locator("input");
        assert.equal(await mayReplace("entries/findings.md").isChecked(), true);
        assert.equal(await mayReplace("entries/mission.md").isChecked(), false);
        // Drawer layout at every size and theme (Review & export step with real data).
        await s.toReview();
        for (const [w, h] of SIZES) {
          await page.setViewportSize({ width: w, height: h });
          for (const theme of THEMES) {
            await s.setTheme(theme);
            await s.shot(`${theme}-${w}x${h}-drawer`);
          }
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll with drawer at ${w}`);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await s.setTheme("dark");
        assert.equal(await page.locator("#drawer").evaluate((el) => getComputedStyle(el).transitionDuration), "0s");
        assert.equal(await page.locator("#drawer").evaluate((el) => getComputedStyle(el).animationName), "none");
        ({ bytes: text } = await s.exportDownload("download-md"));
        text = decode(text);
        cast = castOf(text);
        assert.deepEqual(cast.playbooks.map((p) => p.name), visibleOrder);
        assert.deepEqual(cast.create, ["entries/report.md"]);
        assert.deepEqual(cast.replace, ["entries/findings.md"]);
        assert.deepEqual([...cast.required_files].sort(), ["entries/findings.md", "entries/report.md"]);
        assert.equal(cast.mission, "entries/mission.md");
        assert.deepEqual(cast.read, ["entries/findings.md", "entries/mission.md", "entries/source.md", "stack.yaml"]);
        assert.equal(cast.base_revision, 4);
        assert.equal(cast.stack_id, "stk-harbor-demo");
      });
      await scenario("2b report flow: Return review with NEW/EDIT badges and diff gutters", async () => {
        const ret = encodeReturn(
          receiptFor(cast, {
            summary: "Prepared the report and updated findings from supplied fictional evidence.",
            creates: ["entries/report.md"],
            replaces: ["entries/findings.md"],
          }),
          new Map([
            ["entries/report.md", fixtures.report],
            ["entries/findings.md", findingsBody],
          ]),
        );
        await s.importReturn(ret);
        const checks = await s.checks();
        assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
        const rows = await page.$$eval("#review-files .rfile", (b) =>
          b.map((x) => ({ op: x.querySelector(".op").textContent, path: x.querySelector(".p").textContent, meta: x.querySelector(".m").textContent })),
        );
        assert.deepEqual(rows.map((r) => [r.op, r.path]), [
          ["NEW", "entries/report.md"],
          ["EDIT", "entries/findings.md"],
        ]);
        assert.match(rows[0].meta, /^\d+ lines$/);
        assert.match(rows[1].meta, /^\d+ changed lines$/);
        assert.match(await page.locator("#review-banner .facts").textContent(), /1 new · 1 edit/);
        const signs = async () => new Set(await page.$$eval("#review-diff .udiff td.sg", (t) => t.map((x) => x.textContent)));
        assert.ok((await signs()).has("+"), "create view has + gutter");
        await page.keyboard.press("j");
        await page.waitForFunction(() => document.querySelector("#review-files [aria-current]").textContent.includes("entries/findings.md"));
        const edit = await signs();
        assert.ok(edit.has("+") && edit.has("−"), "replace diff has + and − gutters");
        assert.equal(await page.locator("#review-accept").isEnabled(), true);
        assert.match(await page.locator("#review-reason").textContent(), /Accepting creates revision 5\. Revision 4 stays in History\./);
      });
      await scenario("13 layout and accessibility in review mode with real data", async () => {
        for (const [w, h] of SIZES) {
          await page.setViewportSize({ width: w, height: h });
          for (const theme of THEMES) {
            await s.setTheme(theme);
            await s.shot(`${theme}-${w}x${h}-review`);
          }
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll in review at ${w}`);
          for (const selector of ["#review-accept", "#review-files"]) {
            const box = await page.locator(selector).boundingBox();
            assert.ok(
              box && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= w + 1 && box.y + box.height <= h + 1,
              `${selector} within ${w}x${h}: ${JSON.stringify(box)}`,
            );
          }
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        // Keyboard: Tab from the heading reaches the file list; j/k move aria-current.
        await page.locator("#review-heading").focus();
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => !!document.activeElement.closest("#review-files")), true);
        await page.keyboard.press("k");
        await page.waitForFunction(() => document.querySelector("#review-files [aria-current]").textContent.includes("entries/report.md"));
        await page.keyboard.press("j");
        await page.waitForFunction(() => document.querySelector("#review-files [aria-current]").textContent.includes("entries/findings.md"));
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-current")), "true");
        for (const theme of THEMES) {
          await s.setTheme(theme);
          await s.checkContrast(`${theme} review`, REVIEW_SELECTORS);
        }
        await s.setTheme("dark");
      });
      await scenario("2c report flow: accept as revision 5, History, preserved bytes, TAR.GZ round trip", async () => {
        await page.locator("#review-accept").click();
        await page.waitForSelector("#dialog[open]");
        assert.match(await page.locator("#dialog-title").textContent(), /Accept 2 changes as revision 5\?/);
        assert.equal(await page.locator("#dialog-accept").textContent(), "Accept as revision 5");
        await page.locator("#dialog-accept").click();
        await page.waitForFunction(() => document.getElementById("stack-meta").textContent.includes("revision 5"));
        await s.reviewHidden();
        assert.match(await s.notice(), /Revision 5 saved in this browser with receipt/);
        assert.match(await s.cardChip(1), /Accepted → rev 5/);
        assert.equal(await page.locator('#tree button[title="entries/report.md"]').count(), 1);
        await menuClick(page, "history");
        await page.waitForSelector("#dialog[open]");
        assert.match(await page.locator("#dialog-content").textContent(), /r4 · Before accepting Return 1/);
        await page.locator("#dialog-cancel").click();
        await page.waitForFunction(() => !document.getElementById("dialog").open);
        const event = page.waitForEvent("download");
        await menuClick(page, "export-gzip");
        const exported = readTar(await gunzip(new Uint8Array(await readFile(await (await event).path()))));
        const original = harbor();
        assert.equal(exported.manifest.revision, 5);
        assert.deepEqual(exported.files.get("assets/marker.bin"), original.files.get("assets/marker.bin"));
        assert.deepEqual(exported.files.get("entries/retained.md"), original.files.get("entries/retained.md"));
        assert.match(exported.text("stack.yaml"), /# Preserve this manifest comment/);
        assert.match(exported.text("stack.yaml"), /custom: keep-me/);
        assert.ok(exported.directories.has("empty"));
        assert.equal(exported.text("entries/report.md"), fixtures.report);
        assert.equal(exported.text("entries/findings.md"), findingsBody);
        assert.match(exported.text("entries/mission.md"), /custom: keep-me # Preserve this comment/);
        // Fresh context: the exported archive restores the same Stack.
        const fresh = await session();
        try {
          await fresh.importStack(exported, "restored.stack.tar");
          assert.equal(await fresh.revision(), 5);
          assert.equal(await fresh.page.locator('#tree button[title="entries/report.md"]').count(), 1);
          const again = fresh.page.waitForEvent("download");
          await menuClick(fresh.page, "export-tar");
          const round = readTar(new Uint8Array(await readFile(await (await again).path())));
          assert.deepEqual(round.files.get("assets/marker.bin"), original.files.get("assets/marker.bin"));
          assert.equal(round.manifest.revision, 5);
        } finally {
          await fresh.close();
        }
      });
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  }

  // ---- 3. Planning continuity 4 -> 5 -> 6 ----------------------------------------------------
  await scenario("3 planning continuity 4→5→6 equals the published fixtures byte-for-byte", async () => {
    const s = await session();
    try {
      const { page } = s;
      const p = planningFixture();
      await s.importStack(new Stack(p.original), "planning.stack.tar");
      const exportAll = async () => {
        const event = page.waitForEvent("download");
        await menuClick(page, "export-tar");
        return readTar(new Uint8Array(await readFile(await (await event).path())));
      };
      const sameFiles = (stack, expected) => {
        assert.deepEqual([...stack.files.keys()].sort(), [...expected.keys()].sort());
        for (const [path, bytes] of expected) assert.deepEqual(stack.files.get(path), bytes, `bytes of ${path}`);
      };
      const allowStatus = async () => {
        await page.locator("#drawer-body details.adv summary", { hasText: "Advanced permissions" }).click();
        const box = page.locator("#drawer-body details.adv label.check", { hasText: "entries/plan.md · status" }).locator("input");
        await box.check();
        await page.waitForFunction(() => /metadata: entries\/plan\.md#status|Advanced permissions · 1 on/.test(document.getElementById("drawer-body").textContent));
      };
      // Dispatch 1: research/report at revision 4.
      for (const path of ["entries/mission.md", "entries/source.md", "entries/findings.md", "entries/plan.md"]) await s.check(path);
      await s.startDispatch({ preset: "report", objective: p.first.cast.objective });
      await s.step(3);
      assert.equal(await page.locator("#draft-create").inputValue(), "entries/report.md");
      assert.equal(
        await page.locator("#drawer-body label.check", { hasText: "entries/plan.md" }).filter({ hasText: "Keeps its ID" }).locator("input").isChecked(),
        true,
      );
      await allowStatus();
      const one = await s.exportMd();
      assert.deepEqual(one.cast.replace, ["entries/plan.md"]);
      assert.deepEqual(one.cast.create, ["entries/report.md"]);
      assert.deepEqual(one.cast.metadata, [{ path: "entries/plan.md", keys: ["status"] }]);
      assert.equal(one.cast.base_revision, 4);
      await s.importReturn(readdress(p.first.source, one.cast));
      let checks = await s.checks();
      assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
      await page.keyboard.press("j");
      await page.waitForFunction(() => document.querySelector("#review-diff .metachg"));
      const meta5 = await page.locator("#review-diff .metachg").textContent();
      assert.match(meta5, /status"proposed"→"active"✓ permitted/);
      await page.locator("#review-accept").click();
      await page.waitForSelector("#dialog[open]");
      await page.locator("#dialog-accept").click();
      await page.waitForFunction(() => document.getElementById("stack-meta").textContent.includes("revision 5"));
      await s.reviewHidden();
      sameFiles(await exportAll(), p.expected5);
      // Dispatch 2: license investigation at revision 5; the Return reports blocked.
      for (const path of ["entries/mission.md", "entries/source.md", "entries/findings.md", "entries/plan.md", "entries/report.md"]) await s.check(path);
      await s.startDispatch({ preset: "report", objective: p.second.cast.objective });
      await s.step(3);
      assert.equal(await page.locator("#draft-create").inputValue(), "entries/report-2.md");
      await page.locator("#draft-create").fill("entries/investigation.md");
      // Leave the field as a user would (blur commits the change and re-renders the step). A
      // synthetic `change` dispatched while the field still has focus would fire a second
      // native change from the blur inside the re-render.
      await page.keyboard.press("Tab");
      await page.waitForFunction(() => document.getElementById("draft-create")?.value === "entries/investigation.md");
      await allowStatus();
      const two = await s.exportMd();
      assert.deepEqual(two.cast.create, ["entries/investigation.md"]);
      assert.deepEqual(two.cast.replace, ["entries/plan.md"]);
      assert.equal(two.cast.base_revision, 5);
      assert.ok(two.cast.read.includes("entries/report.md"));
      await s.importReturn(readdress(p.second.source, two.cast));
      checks = await s.checks();
      assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
      assert.match(await page.locator("#review-banner .chip.warn").textContent(), /Reported blocked/);
      assert.match(await page.locator("#review-receipt").textContent(), /Publisher terms not supplied\./);
      assert.equal(await page.locator("#review-accept").isEnabled(), true);
      await page.keyboard.press("j");
      await page.waitForFunction(() => document.querySelector("#review-diff .metachg"));
      assert.match(await page.locator("#review-diff .metachg").textContent(), /status"active"→"blocked"✓ permitted/);
      await page.locator("#review-accept").click();
      await page.waitForSelector("#dialog[open]");
      await page.locator("#dialog-accept").click();
      await page.waitForFunction(() => document.getElementById("stack-meta").textContent.includes("revision 6"));
      await s.reviewHidden();
      assert.match(await s.cardChip(2), /Accepted → rev 6/);
      // Continue: the notice action seeds a new draft from the accepted files.
      await page.locator("button.notice-action", { hasText: "New Dispatch from rev 6" }).click();
      await s.drawerVisible();
      assert.match(await page.locator("#drawer-title").textContent(), /Dispatch 3/);
      assert.match(await s.cardChip(3), /Draft/);
      assert.match(await page.locator("#drawer-sub").textContent(), /base revision 6/);
      await s.step(1);
      for (const path of ["entries/plan.md", "entries/report.md", "entries/investigation.md", "entries/mission.md"])
        assert.equal(await page.locator(`#drawer-body input[aria-label="Include ${path} in this Dispatch"]`).isChecked(), true, path);
      sameFiles(await exportAll(), p.expected6);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 4. Stale base ----------------------------------------------------------------------
  await scenario("4 stale: moved Stack fails the base check, Accept disabled, Re-dispatch; foreign base claim", async () => {
    const s = await session();
    try {
      const { page } = s;
      await s.importStack(sample());
      await s.open("entries/nested/note.md");
      await s.startDispatch({ via: "dispatch-this", preset: "report", objective: "Write a report about the note." });
      const { cast } = await s.exportMd();
      assert.deepEqual(cast.replace, ["entries/nested/note.md"]);
      assert.equal(cast.base_revision, 3);
      await s.open("entries/other.md");
      await fillEditor(page, "# Plain note\n\nEdited after dispatch.\n\n[[ent-note]]\n");
      await page.locator("#save-entry").click();
      await page.waitForFunction(() => document.getElementById("stack-meta").textContent.includes("revision 4"));
      const files = new Map([
        ["entries/report.md", "---\nid: ent-browser-report\nkind: report\n---\n# Report\n\nThe note says Original.\n"],
        ["entries/nested/note.md", sample().text("entries/nested/note.md").replace("Evidence stays.", "Evidence stays.\n\nReport written.")],
      ]);
      const ops = { creates: ["entries/report.md"], replaces: ["entries/nested/note.md"] };
      await s.importReturn(encodeReturn(receiptFor(cast, ops), files));
      let checks = await s.checks();
      assert.equal(checks.find((c) => c.text.startsWith("Stack is now")).text, "Stack is now revision 4; Cast base is 3");
      assert.equal(checks.filter((c) => !c.ok).length, 1);
      assert.equal(await page.locator("#review-accept").isDisabled(), true);
      assert.match(await page.locator("#review-reason").textContent(), /Stack is now revision 4; Cast base is 3/);
      await page.locator("#review-redispatch").click();
      await s.drawerVisible();
      await s.reviewHidden();
      assert.match(await page.locator("#drawer-title").textContent(), /Dispatch 2/);
      assert.match(await s.card(2).textContent(), /Dispatch 2 · rev 4/);
      assert.match(await s.cardChip(2), /Draft/);
      assert.equal(await page.locator("#draft-objective").inputValue(), "Write a report about the note.");
      assert.match(await s.cardChip(1), /Return staged/);
      await page.keyboard.press("Escape");
      await s.drawerHidden();
      // The same Dispatch takes another Return; one that claims a different base fails the base check.
      await s.importReturn(encodeReturn(receiptFor(cast, { ...ops, base_revision: 2 }), files));
      checks = await s.checks();
      assert.equal(checks.find((c) => c.text.startsWith("Return claims")).text, "Return claims base 2; Cast base is 3");
      assert.equal(await page.locator("#review-accept").isDisabled(), true);
      await page.locator("#review-keep").click();
      await s.reviewHidden();
      assert.equal(await s.revision(), 4);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 5. Unauthorized operation --------------------------------------------------------
  await scenario("5 unauthorized: replacing an Entry outside the Cast fails permissions and cannot be accepted", async () => {
    const s = await session();
    try {
      const { page } = s;
      await s.importStack(sample());
      await s.open("entries/other.md");
      await s.startDispatch({ objective: "Summarise the plain note." });
      const { cast } = await s.exportMd();
      assert.deepEqual(cast.replace, []);
      await s.importReturn(
        encodeReturn(
          receiptFor(cast, { replaces: ["entries/other.md"] }),
          new Map([["entries/other.md", "# Plain note\n\nRewritten without permission.\n\n[[ent-note]]\n"]]),
        ),
      );
      const checks = await s.checks();
      assert.equal(checks.find((c) => !c.ok)?.text, "entries/other.md: replacement is not permitted by the Cast");
      assert.match(await page.locator("#review-files .op.bad").textContent(), /✕/);
      assert.match(await page.locator("#review-files .rfile .m").textContent(), /Not permitted by Cast/);
      assert.match(await page.locator("#review-diff .err").textContent(), /Not permitted by the original Cast/);
      assert.equal(await page.locator("#review-accept").isDisabled(), true);
      await page.locator("#review-keep").click();
      await s.reviewHidden();
      assert.equal(await s.revision(), 3);
      assert.match(await editorText(page), /^# Plain note\n\n\[\[ent-note\]\]/);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 6. Duplicate Entry ID against an omitted Entry --------------------------------------
  await scenario("6 duplicate ID: a created Entry reusing an omitted Entry's id fails the ids check", async () => {
    const s = await session();
    try {
      const { page } = s;
      await s.importStack(harbor(), "harbor.stack.tar");
      await s.open("entries/findings.md");
      await s.startDispatch({ via: "dispatch-this", preset: "report", objective: fixtures.cast("report").objective });
      const { cast } = await s.exportMd();
      assert.deepEqual(cast.create, ["entries/report.md"]);
      assert.ok(!cast.read.includes("entries/retained.md"), "retained.md is omitted from the Cast");
      await s.importReturn(
        encodeReturn(
          receiptFor(cast, { creates: ["entries/report.md"], replaces: ["entries/findings.md"] }),
          new Map([
            ["entries/report.md", fixtures.report.replace("ent-harbor-report", "ent-retained")],
            ["entries/findings.md", fixtures.findings],
          ]),
        ),
      );
      const checks = await s.checks();
      const failed = checks.filter((c) => !c.ok);
      assert.equal(failed.length, 1);
      assert.match(failed[0].text, /entries\/report\.md: Entry ID ent-retained already exists in the Stack/);
      assert.equal(await page.locator("#review-accept").isDisabled(), true);
      await page.locator("#review-reject").click();
      await page.waitForSelector("#dialog[open]");
      await page.locator("#dialog-accept").click();
      await s.reviewHidden();
      assert.match(await s.cardChip(1), /Return rejected/);
      assert.equal(await s.revision(), 4);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 7. Dirty affected Entry ---------------------------------------------------------------
  await scenario("7 dirty Entry: drafts check fails, Open unsaved Entry, discard, review passes", async () => {
    const s = await session();
    try {
      const { page } = s;
      await s.importStack(sample());
      await s.open("entries/nested/note.md");
      await s.startDispatch({ via: "dispatch-this", preset: "report", objective: "Write a report about the note." });
      const { cast } = await s.exportMd();
      await page.locator("#drawer-close").click();
      await s.drawerHidden();
      const saved = await editorText(page);
      await fillEditor(page, saved + "\nUnsaved line\n");
      await page.waitForSelector('#tree button[title="entries/nested/note.md"] .tag.dirty');
      const ret = encodeReturn(
        receiptFor(cast, { creates: ["entries/report.md"], replaces: ["entries/nested/note.md"] }),
        new Map([
          ["entries/report.md", "---\nid: ent-browser-report\nkind: report\n---\n# Report\n\nDone.\n"],
          ["entries/nested/note.md", saved.replace("Evidence stays.", "Evidence stays.\n\nReport written.")],
        ]),
      );
      await s.importReturn(ret);
      let checks = await s.checks();
      assert.equal(checks.filter((c) => !c.ok).map((c) => c.text).join(), "Unsaved editor changes in entries/nested/note.md");
      assert.equal(await page.locator("#review-accept").isDisabled(), true);
      await page.locator("#review-open-dirty").click();
      await s.reviewHidden();
      await page.waitForFunction(() => document.getElementById("current-path").textContent === "entries/nested/note.md");
      await page.getByRole("button", { name: "Discard draft", exact: true }).click();
      await s.accept();
      await page.waitForFunction(() => !document.querySelector("#tree .tag.dirty"));
      assert.match(await s.cardChip(1), /Return staged/);
      await s.card(1).click();
      await s.reviewVisible();
      checks = await s.checks();
      assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
      assert.equal(await page.locator("#review-accept").isEnabled(), true);
      await page.locator("#review-keep").click();
      await s.reviewHidden();
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 8. Storage failure on accept ------------------------------------------------------------
  await scenario("8 storage failure: accept leaves the Stack unchanged and staged; Retry succeeds", async () => {
    const s = await session();
    try {
      const { page } = s;
      await s.importStack(sample());
      await s.open("entries/nested/note.md");
      await s.startDispatch({ via: "dispatch-this", preset: "report", objective: "Write a report about the note." });
      const { cast } = await s.exportMd();
      const ret = encodeReturn(
        receiptFor(cast, { creates: ["entries/report.md"], replaces: ["entries/nested/note.md"] }),
        new Map([
          ["entries/report.md", "---\nid: ent-browser-report\nkind: report\n---\n# Report\n\nDone.\n"],
          ["entries/nested/note.md", sample().text("entries/nested/note.md").replace("Evidence stays.", "Evidence stays.\n\nReport written.")],
        ]),
      );
      await s.importReturn(ret);
      assert.ok((await s.checks()).every((c) => c.ok));
      await page.evaluate(() => {
        window.__realPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function () {
          throw new DOMException("Simulated quota failure", "QuotaExceededError");
        };
      });
      await page.locator("#review-accept").click();
      await page.waitForSelector("#dialog[open]");
      await page.locator("#dialog-accept").click();
      await page.waitForFunction(() => document.getElementById("notice").className === "error");
      const notice = await s.notice();
      assert.match(notice, /Not saved/);
      assert.match(notice, /Simulated quota failure/);
      assert.match(notice, /Stack is unchanged/);
      assert.match(notice, /still staged/);
      assert.equal(notice.match(/Not saved/g).length, 1, `single "Not saved" prefix: ${notice}`);
      assert.equal(await s.revision(), 3);
      assert.equal(await page.locator("#review").isHidden(), false);
      assert.equal(await page.locator("#review-accept").isEnabled(), true);
      assert.match(await s.cardChip(1), /Return staged/);
      assert.equal(await page.locator("button.notice-action", { hasText: "Download proposed archive" }).count(), 1);
      await page.evaluate(() => {
        IDBObjectStore.prototype.put = window.__realPut;
      });
      await page.locator("button.notice-action", { hasText: "Retry" }).click();
      await page.waitForSelector("#dialog[open]");
      await page.locator("#dialog-accept").click();
      await page.waitForFunction(() => document.getElementById("stack-meta").textContent.includes("revision 4"));
      await s.reviewHidden();
      assert.match(await s.cardChip(1), /Accepted → rev 4/);
      // The accepted revision survives a reload: it really reached IndexedDB.
      await page.reload();
      await s.ready();
      assert.equal(await s.revision(), 4);
      assert.match(await s.cardChip(1), /Accepted → rev 4/);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 8b. No draft cache at all -------------------------------------------------------------
  await scenario("8b no draft cache: accept first requests a before-return TAR of the current revision", async () => {
    const s = await session({}, () => Object.defineProperty(window, "indexedDB", { value: undefined }));
    try {
      const { page } = s;
      await page.waitForFunction(() => document.getElementById("persistence").textContent.includes("unavailable"));
      await s.importStack(sample());
      await s.open("entries/nested/note.md");
      await s.startDispatch({ via: "dispatch-this", preset: "plan", objective: "Update the note as a plan." });
      const { cast } = await s.exportMd();
      assert.deepEqual(cast.replace, ["entries/nested/note.md"]);
      const before = sample().text("entries/nested/note.md");
      await s.importReturn(
        encodeReturn(
          receiptFor(cast, { replaces: ["entries/nested/note.md"] }),
          new Map([["entries/nested/note.md", before.replace("Evidence stays.", "Evidence stays.\n\nPlan updated.")]]),
        ),
      );
      assert.ok((await s.checks()).every((c) => c.ok));
      await page.locator("#review-accept").click();
      await page.waitForSelector("#dialog[open]");
      const event = page.waitForEvent("download");
      await page.locator("#dialog-accept").click();
      const d = await event;
      assert.equal(d.suggestedFilename(), "stk-test-before-return-r3.stack.tar");
      const prior = readTar(new Uint8Array(await readFile(await d.path())));
      assert.equal(prior.manifest.revision, 3);
      assert.equal(prior.text("entries/nested/note.md"), before);
      await page.waitForFunction(() => document.getElementById("stack-meta").textContent.includes("revision 4"));
      await s.reviewHidden();
      assert.match(await editorText(page), /Plan updated\./);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 9. Routing by format ------------------------------------------------------------------
  await scenario("9 routing: unknown text, unknown Cast, legacy Needlecast via dialog and via upload", async () => {
    const s = await session();
    try {
      const { page } = s;
      await s.importStack(sample());
      await s.open("entries/nested/note.md");
      const garbage = await s.importReturn("Here is my answer:\n\nThe note says Original.\n", { expectError: true });
      assert.match(garbage, /Not a Return Carbon understands|Unknown Return format/);
      const foreign = encodeReturn(
        receiptFor({
          assignment_id: "cast-unknown-00000001",
          dispatch_id: "dispatch-unknown-00000001",
          stack_id: "stk-test",
          base_revision: 3,
          objective: "Something else",
        }),
        new Map(),
      );
      const unknown = await s.importReturn(foreign, { expectError: true });
      assert.match(unknown, /Original Cast not found for cast-unknown-00000001/);
      // Legacy Needlecast packet pasted into the Import Return dialog reaches the legacy modal.
      const legacyPacket = async () => {
        await s.check("entries/nested/note.md");
        await menuClick(page, "export-handoff");
        await page.waitForSelector("#dialog[open]");
        const event = page.waitForEvent("download");
        await s.accept();
        return readFile(await (await event).path(), "utf8");
      };
      const first = await legacyPacket();
      assert.match(first, /^# Envoy Handoff\n/);
      await menuClick(page, "import-return");
      await page.waitForSelector("#return-text");
      await page.locator("#return-text").fill(first.replace("# Original", "# AI proposed"));
      await page.locator("#dialog-accept").click();
      await page.waitForSelector(".diff .added");
      assert.match(await page.locator("#dialog-title").textContent(), /Review Needlecast Return/);
      await s.accept();
      await page.waitForFunction(() => document.getElementById("stack-meta").textContent.includes("revision 4"));
      assert.match(await editorText(page), /# AI proposed/);
      // The existing upload route is unchanged.
      const second = await legacyPacket();
      await s.upload("returned.handoff.md", Buffer.from(second.replace("# AI proposed", "# Uploaded proposal")));
      await page.waitForSelector(".diff .added");
      await s.accept();
      await page.waitForFunction(() => document.getElementById("stack-meta").textContent.includes("revision 5"));
      assert.match(await editorText(page), /# Uploaded proposal/);
      assert.equal(await page.locator("#dispatches .dcard").count(), 0);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 10. Selected Dispatch TAR, text blocker, Playbook limits -------------------------------
  await scenario("10 selected TAR is not a Stack; text target blocker; Playbook limit; Stack Entry as Playbook", async () => {
    const s = await session();
    try {
      const { page } = s;
      const original = sample();
      await s.importStack(original);
      await s.open("entries/other.md");
      await s.startDispatch({ objective: "Describe the binary Asset." });
      await s.step(1);
      await page.locator('#drawer-body input[aria-label="Include Asset assets/bytes.bin"]').check();
      await page.waitForFunction(() => document.querySelector('#drawer-body input[aria-label="Include Asset assets/bytes.bin"]').checked);
      await s.step(4);
      await page.locator('#drawer input[name="target"][value="tar"]').check();
      await page.waitForFunction(() => document.querySelector('#drawer [data-via="download-tar"]'));
      await page.locator("#draft-consent").check();
      await page.waitForFunction(() => document.getElementById("draft-consent").checked);
      const { bytes, name } = await s.exportDownload("download-tar");
      assert.match(name, /^stk-test-dispatch-1\.dispatch\.tar$/);
      const pkg = readUstar(bytes);
      assert.ok(pkg.has("envoy-dispatch/dispatch.yaml") && !pkg.has("envoy-dispatch/stack.yaml"));
      const manifest = decode(pkg.get("envoy-dispatch/dispatch.yaml"));
      assert.match(manifest, /format: envoy\.dispatch\/v0\.1/);
      assert.match(manifest, /complete_stack: false/);
      assert.match(manifest, /packaged_as: assets\/0001\.bin/);
      assert.deepEqual(pkg.get("envoy-dispatch/assets/0001.bin"), original.files.get("assets/bytes.bin"));
      assert.throws(() => readTar(bytes), /stack\.yaml/);
      assert.match(await s.cardChip(1), /Exported/);
      // Uploading the package as if it were a Stack is refused; the Stack is unchanged.
      await s.upload("selected.dispatch.tar", bytes);
      await page.waitForFunction(() => document.getElementById("notice").className === "error");
      assert.match(await s.notice(), /stack\.yaml/);
      assert.equal(await page.locator("#dialog").isVisible(), false);
      assert.equal(await s.revision(), 3);
      // Text target with an Asset: visible blocker, export disabled.
      await page.locator("#drawer-close").click();
      await s.drawerHidden();
      await s.startDispatch({ objective: "Second draft with an Asset." });
      await s.step(1);
      await page.locator('#drawer-body input[aria-label="Include Asset assets/bytes.bin"]').check();
      await s.step(4);
      await page.locator('#drawer input[name="target"][value="text"]').check();
      await page.waitForFunction(() => /cannot carry Assets/.test(document.getElementById("drawer-body").textContent));
      await page.locator("#draft-consent").check();
      await page.waitForFunction(() => document.getElementById("draft-consent").checked);
      for (const b of await page.locator(".export-row button").all()) assert.equal(await b.isDisabled(), true);
      assert.match(await page.locator("#drawer-body .err").textContent(), /Text export cannot carry Assets/);
      // Oversized Playbook file is refused with a message; a Stack Entry can be a Playbook.
      await s.step(2);
      await page.locator("#playbook-file").setInputFiles({
        name: "huge-playbook.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Huge\n" + "x".repeat(17000)),
      });
      await page.waitForFunction(() => /limited to 16 KiB/.test(document.getElementById("notice").textContent));
      assert.equal(await page.locator(".pb.sel").count(), 1);
      await page.locator('select[aria-label="Use a Stack Entry as a Playbook"]').selectOption("entries/other.md");
      await page.waitForFunction(() => document.querySelectorAll(".pb.sel").length === 2);
      assert.match(await page.locator(".pb.sel .src").nth(1).textContent(), /stack: entries\/other\.md/);
      await s.step(1);
      await page.locator('#drawer-body input[aria-label="Include Asset assets/bytes.bin"]').uncheck();
      await page.waitForFunction(() => !document.querySelector('#drawer-body input[aria-label="Include Asset assets/bytes.bin"]').checked);
      await s.step(4);
      await page.locator('#drawer input[name="target"][value="text"]').check();
      await page.locator("#draft-consent").check();
      await page.waitForFunction(() => document.getElementById("draft-consent").checked);
      const { bytes: md } = await s.exportDownload("download-md");
      const cast = castOf(decode(md));
      assert.deepEqual(cast.assets, []);
      assert.ok(cast.playbooks.some((p) => p.source === "stack: entries/other.md" && p.content === original.text("entries/other.md")));
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 11. Reload recovery ---------------------------------------------------------------
  await scenario("11 reload: draft, exported and staged Dispatches recover; Abandon", async () => {
    const s = await session();
    try {
      const { page } = s;
      await s.importStack(sample());
      await s.open("entries/nested/note.md");
      await s.startDispatch({ objective: "Draft one stays a draft." });
      await page.keyboard.press("Escape");
      await s.drawerHidden();
      await s.startDispatch({ objective: "Dispatch two is exported." });
      await s.exportMd();
      await page.locator("#drawer-close").click();
      await s.drawerHidden();
      await s.startDispatch({ objective: "Dispatch three gets a staged Return." });
      const { cast } = await s.exportMd();
      await s.importReturn(encodeReturn(receiptFor(cast), new Map()));
      const before = await s.checks();
      await page.locator("#review-keep").click();
      await s.reviewHidden();
      await page.reload();
      await s.ready();
      assert.equal(await page.locator("#dispatches .dcard").count(), 3);
      assert.match(await s.cardChip(1), /Draft/);
      assert.match(await s.cardChip(2), /Exported · awaiting Return/);
      assert.match(await s.cardChip(3), /Return staged/);
      await s.card(1).click();
      await s.drawerVisible();
      assert.equal(await page.locator("#draft-objective").inputValue(), "Draft one stays a draft.");
      await s.card(3).click();
      await s.reviewVisible();
      assert.deepEqual(await s.checks(), before);
      await page.locator("#review-keep").click();
      await s.reviewHidden();
      await s.card(2).click();
      await s.drawerVisible();
      assert.match(await page.locator("#drawer-body").textContent(), /Waiting on you, outside Carbon/);
      await page.locator("#drawer-body details.adv summary", { hasText: "More" }).click();
      await page.getByRole("button", { name: "Abandon Dispatch" }).click();
      await page.waitForSelector("#dialog[open]");
      await s.accept();
      assert.match(await s.cardChip(2), /Abandoned/);
      assert.equal(await s.revision(), 3);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 11b. Damaged cached Dispatch records ---------------------------------------------------
  await scenario("11b reload with damaged cached Dispatch records: skipped with a notice, Stack and valid Dispatch recovered", async () => {
    const s = await session();
    try {
      const { page } = s;
      await s.importStack(sample());
      await s.open("entries/nested/note.md");
      await s.startDispatch({ objective: "This one survives." });
      await page.keyboard.press("Escape");
      await s.drawerHidden();
      await page.waitForTimeout(400);
      // Inject malformed records into the Stack's own carbon-vfs record, as a damaged or foreign store would.
      await page.evaluate(
        (id) =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("carbon-vfs");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const t = open.result.transaction("mounts", "readwrite"),
                store = t.objectStore("mounts"),
                get = store.get(id);
              get.onsuccess = () => {
                const value = get.result;
                value.dispatches = [{}, { assignmentId: "cast-x", status: "draft" }, ...value.dispatches, null];
                store.put(value, id);
              };
              t.oncomplete = () => {
                open.result.close();
                resolve();
              };
              t.onerror = () => reject(t.error);
            };
          }),
        sample().manifest.id,
      );
      await page.reload();
      await s.ready();
      assert.match(await page.locator("#notice").textContent(), /3 damaged Dispatch record\(s\) .* skipped/);
      assert.equal(await page.locator("#dispatches .dcard").count(), 1);
      assert.match(await s.cardChip(1), /Draft/);
      assert.equal(await s.revision(), 3);
      await s.card(1).click();
      await s.drawerVisible();
      assert.equal(await page.locator("#draft-objective").inputValue(), "This one survives.");
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- 12. Clipboard -------------------------------------------------------------------------
  await scenario("12 clipboard: Copy exports (same bytes as Download again); a failing clipboard keeps the draft", async () => {
    const s = await session();
    try {
      const { page } = s;
      await s.importStack(sample());
      await s.open("entries/nested/note.md");
      const stub = (ok) =>
        page.evaluate((ok) => {
          const writeText = (t) => {
            window.__copied = t;
            return ok ? Promise.resolve() : Promise.reject(new DOMException("Write permission denied", "NotAllowedError"));
          };
          if (navigator.clipboard) navigator.clipboard.writeText = writeText;
          else Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        }, ok);
      await stub(true);
      await s.startDispatch({ objective: "Copied question." });
      await s.toReview();
      await page.locator('#drawer [data-via="copy"]').click();
      await page.waitForFunction(() => document.getElementById("notice").textContent.includes("copied to the clipboard"));
      assert.match(await s.cardChip(1), /Exported · awaiting Return/);
      const copied = await page.evaluate(() => window.__copied);
      assert.match(copied, /^# Envoy Dispatch\n/);
      const event = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download again" }).click();
      const again = await readFile(await (await event).path(), "utf8");
      assert.equal(again, copied);
      await stub(false);
      await page.locator("#drawer-close").click();
      await s.drawerHidden();
      await s.startDispatch({ objective: "Clipboard will fail." });
      await s.toReview();
      await page.locator('#drawer [data-via="copy"]').click();
      await page.waitForFunction(() => document.getElementById("notice").className === "error");
      assert.match(await s.notice(), /Clipboard unavailable/);
      assert.match(await s.cardChip(2), /Draft/);
      assert.equal(await page.locator("#drawer-steps").isHidden(), false);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.network, []);
    } finally {
      await s.close();
    }
  });

  // ---- Regression: uncommitted wizard fields survive Esc closing the drawer ----------------
  // #draft-create, #draft-criteria and rename targets save on `change`; close() now blurs the
  // focused field before clearing the open record (previously the typed value was lost).
  const gap = {
    name: "Typed create path / criteria survive Esc closing the drawer",
    observed:
      "typing completion criteria in #draft-criteria (or a path in #draft-create) and pressing Esc before leaving the field: the reopened draft shows empty criteria (or entries/report.md)",
    expected: "the reopened draft shows entries/typed-path.md (and the typed completion criteria)",
  };
  await scenario(gap.name, async () => {
      const s = await session();
      try {
        const { page } = s;
        await s.importStack(sample());
        await s.open("entries/nested/note.md");
        await s.startDispatch({ preset: "report", objective: "Known gap probe." });
        await page.locator("#drawer-body details.adv summary", { hasText: "Completion criteria" }).click();
        await page.locator("#draft-criteria").fill("Every claim cites the note.");
        await page.keyboard.press("Escape");
        await s.drawerHidden();
        await s.card(1).click();
        await s.drawerVisible();
        assert.equal(await page.locator("#draft-criteria").inputValue(), "Every claim cites the note.");
        await s.step(3);
        await page.locator("#draft-create").fill("entries/typed-path.md");
        await page.keyboard.press("Escape");
        await s.drawerHidden();
        await s.card(1).click();
        await s.drawerVisible();
        assert.equal(await page.locator("#draft-create").inputValue(), "entries/typed-path.md");
      } finally {
        await s.close();
      }
    });

  assert.deepEqual(allErrors, []);
  assert.deepEqual(allNetwork, []);
  reportTimes.totalMs = Date.now() - started;
  return {
    browser: await browser.version(),
    scenarios,
    timings: { ...reportTimes, byScenario: Object.fromEntries(scenarios.map((x) => [x.name, x.ms])) },
    screenshots,
    contrasts,
    networkRequests: allNetwork,
    pageErrors: allErrors,
  };
}
