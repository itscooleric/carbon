/**
 * carbon-vfs acceptance (RFC #25 rev 3, PR-A1): Scratch on first load, persistent independent
 * workspaces, atomic store transactions, quota and revision-conflict states, reload recovery,
 * strict Return scoping, and the pre-VFS database left untouched. Real file:// page, offline.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeTar } from "../src/archives/tar.js";
import { newStack } from "../src/core/stack.js";
import { decode } from "../src/core/validate.js";
import { encodeReturn } from "../cast-kit/src/kit.mjs";
import { sample } from "./helpers.js";
import { editorText, fillEditor } from "./editor-browser-helpers.mjs";
import { menuClick } from "./refinements-browser.mjs";
import { castOf, receiptFor } from "./dispatch-browser.mjs";

const DIST = pathToFileURL(resolve("dist/carbon.html")).href;
const NOTE = /^\d{4}-\d{2}-\d{2}\.md$/;

export async function vfsFlows(browser) {
  const checks = [],
    allErrors = [],
    allNetwork = [];
  async function context() {
    const ctx = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1440, height: 900 } });
    return ctx;
  }
  async function tab(ctx) {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => allErrors.push(e.message));
    page.on("request", (r) => {
      if (/^https?:/.test(r.url())) allNetwork.push(r.url());
    });
    page.on("dialog", (d) => d.accept());
    await page.goto(DIST);
    await ready(page);
    return page;
  }
  const ready = (page) =>
    page.waitForFunction(() => {
      const t = document.getElementById("notice").textContent;
      return t && t !== "Opening local workspace…" && document.getElementById("workspace").getAttribute("aria-busy") !== "true";
    });
  const idle = (page) => page.waitForFunction(() => document.getElementById("workspace").getAttribute("aria-busy") !== "true");
  const accept = async (page) => {
    await page.locator("#dialog-accept").click();
    await page.waitForFunction(() => !document.getElementById("dialog").open);
    await idle(page);
  };
  const notice = (page) => page.locator("#notice").textContent();
  const meta = (page) => page.locator("#stack-meta").textContent();
  const title = (page) => page.locator("#stack-title").textContent();
  const persistence = (page) => page.evaluate(() => ({ state: document.getElementById("persistence").dataset.state, text: document.getElementById("persistence").textContent }));
  const settle = (page) => page.waitForFunction(() => document.getElementById("persistence").dataset.state !== "saving").then(() => page.waitForTimeout(450));
  const reload = async (page) => {
    await settle(page);
    await page.reload();
    await ready(page);
  };
  const importStack = async (page, stack, name = "demo.stack.tar") => {
    await page.locator("#files").setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from(writeTar(stack)) });
    await page.waitForSelector("#dialog[open]");
    await accept(page);
  };
  const openCopy = async (page, name, text) => {
    await page.locator("#local-files").setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(text) });
    await page.locator("#dialog-title").filter({ hasText: "Open local folder copy?" }).waitFor();
    await accept(page);
  };
  /** Workspaces… dialog rows as text, then close it (or click `action` on the row matching `match`). */
  const workspaces = async (page, match = null, action = "Switch") => {
    await menuClick(page, "workspaces");
    await page.locator("#dialog-title").filter({ hasText: "Workspaces" }).waitFor();
    const rows = await page.locator("#dialog-content .workspace-list li").allTextContents();
    if (match) await page.locator("#dialog-content .workspace-list li", { hasText: match }).getByRole("button", { name: action, exact: action !== "Switch" }).first().click();
    else await page.locator("#dialog-cancel").click();
    await page.waitForFunction(() => !document.getElementById("dialog").open);
    await idle(page);
    return rows;
  };
  const scratch = async (page) => {
    await menuClick(page, "open-scratch");
    await page.waitForFunction(() => /^Scratch · /.test(document.getElementById("stack-meta").textContent));
    await idle(page);
  };
  const historyRows = async (page) => {
    await menuClick(page, "history");
    await page.locator("#dialog-title").filter({ hasText: "Revision history" }).waitFor();
    const rows = await page.locator("#dialog-content p").filter({ has: page.getByRole("button", { name: "Restore", exact: true }) }).allTextContents();
    await page.locator("#dialog-cancel").click();
    await idle(page);
    return rows;
  };
  /** Raw read of carbon-vfs (no version: never upgrades); always closes its connection. */
  const raw = (page, id = null) =>
    page.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open("carbon-vfs");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result,
              t = db.transaction(["mounts", "meta"]),
              out = {};
            const meta = t.objectStore("meta");
            meta.get("active").onsuccess = (e) => (out.active = e.target.result?.mountId ?? null);
            meta.get("index").onsuccess = (e) => (out.index = Object.keys(e.target.result || {}).sort());
            const mounts = t.objectStore("mounts");
            mounts.getAllKeys().onsuccess = (e) => (out.keys = e.target.result.map(String).sort());
            if (id)
              mounts.get(id).onsuccess = (e) => {
                const b = e.target.result;
                out.body = b && { rev: b.rev, kind: b.kind, title: b.title, files: Array.isArray(b.stack?.files) ? b.stack.files.map(([p, v]) => [p, new TextDecoder().decode(v)]) : b.stack?.files, drafts: b.drafts, history: b.history.length };
              };
            t.oncomplete = () => {
              db.close();
              resolve(out);
            };
            t.onabort = () => reject(t.error);
          };
        }),
      id,
    );
  const activeId = (page) => page.evaluate(() => document.getElementById("stack-id").textContent);

  async function scenario(name, fn) {
    const ctx = await context();
    try {
      await fn(ctx);
      checks.push(name);
    } catch (e) {
      e.message = `${name}: ${e.message}`;
      throw e;
    } finally {
      await ctx.close();
    }
  }

  // 1. Fresh profile: Scratch with an immediately editable note; reload restores text, tab and draft.
  await scenario("fresh profile opens Scratch with a focused, editable Markdown note; reload restores the exact draft, tab and status", async (ctx) => {
    const page = await tab(ctx);
    assert.match(await meta(page), /^Scratch · revision 0 · 1 files$/);
    const note = await page.locator("#current-path").textContent();
    assert.match(note, NOTE);
    assert.match(await notice(page), /Start typing in Scratch/);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("cm-content")), true, "the note has keyboard focus");
    assert.equal(await page.locator("#dispatch").isDisabled(), true, "Dispatch needs an Envoy Stack");
    // A pristine first visit never prompts on close.
    const warns = () => page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    assert.equal(await warns(), false);
    const started = Date.now();
    await page.keyboard.type("Groceries\n- eggs");
    assert.ok(Date.now() - started < 5000);
    await settle(page);
    assert.deepEqual(await persistence(page), { state: "saved", text: "Saved in this browser · revision 0 · last archive export: none" });
    const stored = await raw(page, "local-scratch");
    assert.equal(stored.active, null, "Scratch is the default; no switch recorded yet");
    assert.deepEqual(stored.body.drafts, [[note, "Groceries\n- eggs"]]);
    assert.equal(stored.body.kind, "scratch");
    await reload(page);
    assert.match(await notice(page), /Recovered local workspace/);
    assert.equal(await page.locator("#current-path").textContent(), note);
    assert.equal(await editorText(page), "Groceries\n- eggs");
    assert.equal(await page.locator('#editor-tabs [role="tab"]').count() >= 1, true);
    // Save commits the note into Scratch (History records the empty note), and still survives reload.
    await page.locator("#save-entry").click();
    await idle(page);
    assert.match(await notice(page), /Saved in Scratch in this browser/);
    assert.match(await meta(page), /^Scratch · revision 1 · /);
    await reload(page);
    assert.equal(await editorText(page), "Groceries\n- eggs");
    assert.equal((await raw(page, "local-scratch")).body.files[0][1], "Groceries\n- eggs");
    assert.equal((await historyRows(page)).length, 1);
    await page.close();
  });

  // 2. Independent workspaces: drafts, tabs, History and identity survive switching and reload.
  await scenario("switching parks drafts, tabs and History per workspace; reload opens the last workspace; Stack and copies keep independent identities", async (ctx) => {
    const page = await tab(ctx);
    await page.keyboard.type("Scratch draft");
    await settle(page);
    // Open a local copy: Scratch, with its unsaved draft, is parked (no "Save or discard" refusal).
    await openCopy(page, "notes.md", "# Notes\n");
    assert.match(await meta(page), /^Local copy · /);
    assert.match(await notice(page), /Opened a local copy/);
    const copyId = (await raw(page)).active;
    assert.match(copyId, /^local-[0-9a-f-]{36}$/);
    await page.locator('#tree button[title="notes.md"]').click();
    await idle(page);
    await fillEditor(page, "# Notes\n\ncopy draft");
    // A second copy of a same-named file is a separate workspace with its own identity.
    await openCopy(page, "notes.md", "# Other notes\n");
    const otherId = (await raw(page)).active;
    assert.notEqual(otherId, copyId);
    assert.equal(await editorText(page), "# Other notes\n");
    // A Stack is its own workspace too.
    const stack = sample();
    await importStack(page, stack);
    assert.match(await notice(page), /Complete Stack imported/);
    assert.equal(await activeId(page), stack.manifest.id);
    assert.deepEqual(await historyRows(page), [], "a new workspace starts with its own History");
    const stored = await raw(page);
    assert.deepEqual(stored.keys, [copyId, otherId, "local-scratch", stack.manifest.id].sort());
    assert.deepEqual(stored.index, stored.keys);
    // Back to Scratch: its draft is intact; the Stack's History never saw Scratch.
    await scratch(page);
    assert.equal(await editorText(page), "Scratch draft");
    assert.match(await page.locator("#current-path").textContent(), NOTE);
    // Switch to the first copy through Workspaces…, reload, and land there with its draft.
    const rows = await workspaces(page);
    assert.equal(rows.length, 4);
    // A parked workspace with unsaved drafts is not downloaded as a TAR that would drop them.
    await menuClick(page, "workspaces");
    await page.locator("#dialog-title").filter({ hasText: "Workspaces" }).waitFor();
    await page.locator("#dialog-content .workspace-list li", { hasText: "1 unsaved draft" }).filter({ hasText: "Local copy" }).getByRole("button", { name: "Download files (TAR)" }).click();
    await idle(page);
    assert.match(await notice(page), /1 unsaved draft, which a files-only TAR would not include/);
    assert.match(rows[0], /Scratch.*open now/);
    assert.match(rows.join("\n"), /1 unsaved draft/);
    await menuClick(page, "workspaces");
    await page.locator("#dialog-title").filter({ hasText: "Workspaces" }).waitFor();
    await page.locator("#dialog-content .workspace-list li", { hasText: "1 unsaved draft" }).filter({ hasText: "Local copy" }).getByRole("button", { name: /^Switch to / }).click();
    await page.waitForFunction(() => /^Local copy · /.test(document.getElementById("stack-meta").textContent));
    await idle(page);
    assert.equal(await page.locator("#current-path").textContent(), "notes.md");
    assert.equal(await editorText(page), "# Notes\n\ncopy draft");
    await reload(page);
    assert.equal((await raw(page)).active, copyId);
    assert.match(await meta(page), /^Local copy · /);
    assert.equal(await editorText(page), "# Notes\n\ncopy draft");
    // Each workspace keeps its own bytes: the second copy never saw the first copy's draft.
    await menuClick(page, "workspaces");
    await page.locator("#dialog-title").filter({ hasText: "Workspaces" }).waitFor();
    await page.locator("#dialog-content .workspace-list li").filter({ hasText: "Local copy" }).filter({ hasNotText: "open now" }).getByRole("button", { name: /^Switch to / }).click();
    await page.waitForFunction(() => !document.getElementById("dialog").open);
    await idle(page);
    assert.equal((await raw(page)).active, otherId);
    await scratch(page);
    assert.equal(await editorText(page), "Scratch draft");
    await reload(page);
    assert.equal(await editorText(page), "Scratch draft");
    const back = await raw(page, otherId);
    assert.deepEqual(back.body.files, [["notes.md", "# Other notes\n"]]);
    // Re-importing the stored Stack from Scratch previews against THAT Stack, not against Scratch.
    const trimmed = stack.change({ deletes: ["entries/other.md"] });
    await page.locator("#files").setInputFiles({ name: "again.stack.tar", mimeType: "application/octet-stream", buffer: Buffer.from(writeTar(trimmed)) });
    await page.waitForSelector("#dialog[open]");
    const preview = await page.locator("#dialog-content").textContent();
    assert.match(preview, /Absent from incoming snapshot:\s*entries\/other\.md/);
    assert.doesNotMatch(preview, /\d{4}-\d{2}-\d{2}\.md/, "Scratch files are not part of the comparison");
    assert.match(preview, /already stored in this browser: the snapshot replaces its revision 3/);
    await accept(page);
    assert.equal(await activeId(page), stack.manifest.id);
    assert.equal(await page.locator('#tree button[title="entries/other.md"]').count(), 0);
    assert.equal((await historyRows(page)).length, 1);
    await page.close();
  });

  // 3. Interrupted switch: one failing write aborts the whole transaction.
  await scenario("an interrupted transaction (index write fails after the body write) changes neither the window nor the store; reload recovers the prior workspace", async (ctx) => {
    const page = await tab(ctx);
    await page.keyboard.type("Before interruption");
    await settle(page);
    await importStack(page, sample());
    const stackId = await activeId(page);
    const before = await raw(page, stackId);
    const shown = { meta: await meta(page), title: await title(page) };
    await page.evaluate(() => {
      window.__put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.name === "meta") throw new DOMException("Injected interruption", "UnknownError");
        return window.__put.call(this, value, key);
      };
    });
    await menuClick(page, "open-scratch");
    await idle(page);
    assert.match(await notice(page), /Injected interruption/);
    assert.deepEqual({ meta: await meta(page), title: await title(page) }, shown);
    assert.deepEqual(await raw(page, stackId), before, "body, index and active pointer unchanged");
    // A new workspace (two bodies + index + active) is equally all-or-nothing.
    await page.locator("#files").setInputFiles({ name: "b.stack.tar", mimeType: "application/octet-stream", buffer: Buffer.from(writeTar(newStack("Interrupted B"))) });
    await page.waitForSelector("#dialog[open]");
    await accept(page);
    assert.match(await notice(page), /Injected interruption/);
    assert.deepEqual(await raw(page, stackId), before);
    // Re-importing the open Stack (same id) is equally atomic: no revision, History or flag change.
    const rows = await historyRows(page);
    await page.locator("#files").setInputFiles({ name: "same.stack.tar", mimeType: "application/octet-stream", buffer: Buffer.from(writeTar(sample().change({ deletes: ["entries/other.md"] }))) });
    await page.waitForSelector("#dialog[open]");
    await accept(page);
    assert.match(await notice(page), /Injected interruption/);
    assert.deepEqual({ meta: await meta(page), title: await title(page) }, shown);
    assert.deepEqual(await historyRows(page), rows);
    assert.equal(await page.locator('#tree button[title="entries/other.md"]').count(), 1);
    assert.deepEqual(await raw(page, stackId), before);
    await page.evaluate(() => (IDBObjectStore.prototype.put = window.__put));
    await reload(page);
    assert.equal(await activeId(page), stackId);
    await scratch(page);
    assert.equal(await editorText(page), "Before interruption");
    await page.close();
  });

  // 4. Quota failure reported asynchronously by the transaction (as real IndexedDB does).
  await scenario("an asynchronous QuotaExceededError keeps the last stored copy, shows the storage-full state, and the next change retries", async (ctx) => {
    const page = await tab(ctx);
    await page.keyboard.type("stored text");
    await settle(page);
    const before = await raw(page, "local-scratch");
    await page.evaluate(() => {
      window.__put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = window.__put.call(this, value, key);
        const t = this.transaction;
        if (this.name === "mounts" && !t.__quota) {
          t.__quota = true;
          request.addEventListener("success", () => {
            Object.defineProperty(t, "error", { value: new DOMException("Injected async quota", "QuotaExceededError") });
            t.abort();
          });
        }
        return request;
      };
    });
    await page.keyboard.type(" plus more");
    await page.waitForFunction(() => document.getElementById("persistence").dataset.state === "quota");
    assert.match(await notice(page), /Browser storage is full.*last saved copy in this browser is intact/);
    assert.match((await persistence(page)).text, /storage is full/);
    assert.deepEqual(await raw(page, "local-scratch"), before, "prior record intact");
    // The offered recovery download includes the unsaved draft without needing browser storage.
    const recovery = page.waitForEvent("download");
    await page.locator("button.notice-action", { hasText: "Download recovery copy" }).click();
    const file = await recovery;
    assert.match(file.suggestedFilename(), /^local-scratch-recovery-r0\.folder\.tar$/);
    const { readTarFiles } = await import("../src/archives/tar.js");
    const recovered = new Map(readTarFiles(new Uint8Array(await readFile(await file.path()))).files);
    assert.match(new TextDecoder().decode([...recovered.values()][0]), /^stored text plus more/);
    // An explicit save reports the failure and leaves the workspace unchanged (atomic commit).
    await page.locator("#save-entry").click();
    await idle(page);
    assert.match(await notice(page), /quota/i);
    assert.equal(await page.locator("button.notice-action", { hasText: "Download recovery copy" }).count(), 1, "an explicit Save failure offers the recovery download too");
    assert.match(await meta(page), /revision 0/);
    assert.equal(await page.locator("#save-entry").isDisabled(), false);
    // Storage recovers: the next change saves and the state returns to "saved".
    await page.evaluate(() => (IDBObjectStore.prototype.put = window.__put));
    await page.locator("#editor .cm-content").press("Control+End");
    await page.keyboard.type("!");
    await page.waitForFunction(() => document.getElementById("persistence").dataset.state === "saved");
    await settle(page);
    assert.deepEqual((await raw(page, "local-scratch")).body.drafts.map(([, t]) => t), ["stored text plus more!"]);
    await reload(page);
    assert.equal(await editorText(page), "stored text plus more!");
    await page.close();
  });

  // 5. Two tabs on one workspace: the stale tab gets a conflict instead of overwriting.
  await scenario("concurrent tabs: a stale tab's write is refused with a conflict state; the newer copy survives and a reload shows it", async (ctx) => {
    const a = await tab(ctx);
    const b = await tab(ctx);
    await a.keyboard.type("from tab A");
    await settle(a);
    assert.equal((await raw(a, "local-scratch")).body.rev, 1);
    await b.locator("#editor .cm-content").click();
    await b.keyboard.type("from tab B");
    await b.waitForFunction(() => document.getElementById("persistence").dataset.state === "conflict");
    assert.match(await notice(b), /changed in another Carbon tab/);
    assert.equal(await b.locator("button.notice-action", { hasText: "Reload" }).count(), 1);
    const stored = await raw(a, "local-scratch");
    assert.equal(stored.body.rev, 1);
    assert.deepEqual(stored.body.drafts.map(([, t]) => t), ["from tab A"]);
    // Further edits in the stale tab keep refusing; nothing is overwritten.
    await b.keyboard.type(" again");
    await b.waitForTimeout(700);
    assert.equal((await raw(a, "local-scratch")).body.rev, 1);
    // Switching away from the stale workspace is refused too (it would park a stale copy).
    await b.locator("#local-files").setInputFiles({ name: "x.md", mimeType: "text/markdown", buffer: Buffer.from("# X") });
    await b.locator("#dialog-title").filter({ hasText: "Open local folder copy?" }).waitFor();
    await accept(b);
    assert.match(await notice(b), /another Carbon tab/);
    assert.match(await meta(b), /^Scratch · /);
    await b.reload();
    await ready(b);
    assert.equal(await editorText(b), "from tab A");
    // After reloading, tab B owns the current revision and tab A becomes the stale one.
    await b.locator("#editor .cm-content").press("Control+End");
    await b.keyboard.type("!");
    await settle(b);
    await a.locator("#editor .cm-content").press("Control+End");
    await a.keyboard.type("?");
    await a.waitForFunction(() => document.getElementById("persistence").dataset.state === "conflict");
    assert.deepEqual((await raw(b, "local-scratch")).body.drafts.map(([, t]) => t), ["from tab A!"]);
    // A Stack previewed as new in tab A but stored by tab B meanwhile is not replaced unseen.
    const shared = sample();
    await a.locator("#files").setInputFiles({ name: "shared.stack.tar", mimeType: "application/octet-stream", buffer: Buffer.from(writeTar(shared)) });
    await a.waitForSelector("#dialog[open]");
    await b.locator("#files").setInputFiles({ name: "shared.stack.tar", mimeType: "application/octet-stream", buffer: Buffer.from(writeTar(shared)) });
    await b.waitForSelector("#dialog[open]");
    await accept(b);
    assert.equal(await activeId(b), shared.manifest.id);
    await accept(a);
    assert.match(await notice(a), /changed in browser storage .* after the preview/);
    await a.close();
    await b.close();
  });

  // 6. Returns are scoped to their own Stack workspace.
  await scenario("a Return for Stack A is refused while Scratch or Stack B is active and is accepted once Stack A is active again", async (ctx) => {
    const page = await tab(ctx);
    const stackA = sample();
    await importStack(page, stackA);
    await page.locator('#tree button[title="entries/nested/note.md"]').click();
    await idle(page);
    await menuClick(page, "dispatch-this");
    await page.waitForFunction(() => !document.getElementById("drawer").hidden && document.activeElement.id === "draft-objective");
    await page.locator("#draft-objective").fill("Answer from the note.");
    await page.waitForFunction(() => document.querySelector("#dispatches .dcard .obj")?.textContent.includes("Answer from"));
    if (!(await page.locator("#drawer-skip").isHidden())) await page.locator("#drawer-skip").click();
    else await page.locator("#drawer-steps button").nth(4).click();
    await page.locator("#draft-consent").check();
    const event = page.waitForEvent("download");
    await page.locator('#drawer [data-via="download-md"]').click();
    const cast = castOf(decode(new Uint8Array(await readFile(await (await event).path()))));
    await page.keyboard.press("Escape");
    await idle(page);
    const text = encodeReturn(receiptFor(cast), new Map());
    const tryReturn = async () => {
      await menuClick(page, "import-return");
      return page.waitForFunction(() => document.getElementById("notice").className === "error" || document.querySelector("#return-text")).then(async () => {
        if (await page.locator("#return-text").count()) {
          await page.locator("#return-text").fill(text);
          await page.locator("#dialog-accept").click();
          await page.waitForFunction(() => !document.getElementById("review").hidden || document.querySelector("#dialog .err"));
          const err = await page.evaluate(() => document.querySelector("#dialog .err b")?.textContent || null);
          if (err) {
            await page.locator("#dialog-cancel").click();
            await page.waitForFunction(() => !document.getElementById("dialog").open);
          }
          return err ?? "review";
        }
        return await notice(page);
      });
    };
    // Scratch active: Import Return is not available at all (Dispatch / Return requires a Stack).
    await scratch(page);
    assert.equal(await page.locator("#import-return").isDisabled(), true);
    assert.equal(await page.locator("#dispatches .dcard").count(), 0, "Stack A's Dispatch is not listed in Scratch");
    // Stack B active: the Return names Stack A's assignment, which Stack B does not have.
    await importStack(page, newStack("Stack B"));
    assert.match(await tryReturn(), /Original Cast not found/);
    assert.equal(await page.locator("#dispatches .dcard").count(), 0);
    // Stack A again (via Workspaces…): the same Return stages for review.
    await workspaces(page, stackA.manifest.title || stackA.manifest.id);
    await page.waitForFunction((id) => document.getElementById("stack-id").textContent === id, stackA.manifest.id);
    assert.equal(await page.locator("#dispatches .dcard").count(), 1);
    assert.equal(await tryReturn(), "review");
    // Save answer as Entry is ONE commit (receipt + Entry + History + selected path): a storage
    // failure leaves the Return staged and adds no Entry; the retry then stores both together.
    const revisionOf = async () => Number(/revision (\d+)/.exec(await meta(page))[1]);
    const storedA = async () => {
      const r = await page.evaluate(
        (id) =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("carbon-vfs");
            open.onsuccess = () => {
              const g = open.result.transaction("mounts").objectStore("mounts").get(id);
              g.onsuccess = () => { open.result.close(); resolve({ rev: g.result.rev, files: g.result.stack.files.map(([p]) => p), status: g.result.dispatches.map((d) => d.status) }); };
              g.onerror = () => reject(g.error);
            };
            open.onerror = () => reject(open.error);
          }),
        stackA.manifest.id,
      );
      return r;
    };
    const rev0 = await revisionOf(), stored0 = await storedA();
    assert.deepEqual(stored0.status, ["staged"]);
    await page.evaluate(() => {
      window.__put ??= IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = window.__put.call(this, value, key);
        const t = this.transaction;
        if (this.name === "mounts" && !t.__quota) {
          t.__quota = true;
          request.addEventListener("success", () => {
            Object.defineProperty(t, "error", { value: new DOMException("Injected async quota", "QuotaExceededError") });
            t.abort();
          });
        }
        return request;
      };
    });
    const saveAnswer = async () => {
      await page.locator("#review-save-answer").click();
      await page.locator("#dialog-title").filter({ hasText: "Save answer as a new Entry" }).waitFor();
      const path = await page.locator("#dialog input").inputValue();
      await accept(page);
      return path;
    };
    const answerPath = await saveAnswer();
    await page.waitForFunction(() => document.getElementById("notice").className === "error");
    assert.doesNotMatch(await notice(page), /Answer saved/);
    assert.equal(await revisionOf(), rev0, "no new revision");
    assert.deepEqual(await storedA(), stored0, "receipt not stored without the Entry (nor the Entry without the receipt)");
    assert.equal(await page.locator(`#tree button[title="${answerPath}"]`).count(), 0);
    assert.equal(await page.locator("#review").isHidden(), false, "the Return stays staged in review");
    await page.evaluate(() => (IDBObjectStore.prototype.put = window.__put));
    await page.locator("#notice .notice-close").click();
    await saveAnswer();
    await page.waitForFunction(() => /Answer saved as/.test(document.getElementById("notice").textContent));
    assert.equal(await revisionOf(), rev0 + 1);
    const stored1 = await storedA();
    assert.deepEqual(stored1.status, ["checkpoint"]);
    assert.ok(stored1.files.includes(answerPath));
    assert.equal(stored1.rev, stored0.rev + 1, "receipt and Entry landed in one store write");
    assert.equal(await page.locator("#current-path").textContent(), answerPath, "the selected Entry is part of the same revision");
    await page.close();
  });

  // 7. Memory-only window: workspaces still switch within the window, and the status says so.
  await scenario("IndexedDB unavailable: memory-only status, Scratch still editable, switching works within the window", async () => {
    const ctx = await context();
    try {
      await ctx.addInitScript(() => Object.defineProperty(window, "indexedDB", { value: undefined }));
      const page = await tab(ctx);
      assert.equal((await persistence(page)).state, "memory");
      assert.match((await persistence(page)).text, /Memory only.*unavailable/);
      await page.keyboard.type("memory note");
      await importStack(page, sample());
      // The Stack has nothing unsaved, but the parked Scratch draft exists only in this window.
      assert.equal(await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), true);
      await scratch(page);
      assert.equal(await editorText(page), "memory note");
      await page.close();
    } finally {
      await ctx.close();
    }
  });

  // 8. The pre-VFS database is never opened for writing, upgraded or deleted.
  await scenario("the legacy envoy-carbon-v1 database stays byte-identical at version 2 while the new build works", async (ctx) => {
    let page = await tab(ctx);
    // Seed a legacy record, then remove carbon-vfs so the next load is a fresh VFS profile.
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open("envoy-carbon-v1", 2);
          open.onupgradeneeded = () => {
            open.result.createObjectStore("workspace");
            open.result.createObjectStore("folders", { autoIncrement: true });
          };
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const t = open.result.transaction("workspace", "readwrite");
            t.objectStore("workspace").put({ stack: { files: [["entries/old.md", new TextEncoder().encode("# Old beta note")]], directories: [] }, marker: "legacy" }, "current");
            t.oncomplete = () => {
              open.result.close();
              const del = indexedDB.deleteDatabase("carbon-vfs");
              del.onsuccess = () => resolve();
              del.onerror = () => reject(del.error);
            };
          };
        }),
    );
    await page.reload();
    await ready(page);
    assert.match(await notice(page), /earlier Carbon test builds are not loaded here/);
    assert.match(await meta(page), /^Scratch · revision 0 · 1 files$/);
    await page.keyboard.type("new build note");
    await importStack(page, sample());
    await scratch(page);
    await reload(page);
    const legacy = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open("envoy-carbon-v1");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result,
              out = { version: db.version, stores: [...db.objectStoreNames].sort() };
            const t = db.transaction("workspace");
            t.objectStore("workspace").getAllKeys().onsuccess = (e) => (out.keys = e.target.result);
            t.objectStore("workspace").get("current").onsuccess = (e) => (out.current = { marker: e.target.result.marker, file: new TextDecoder().decode(e.target.result.stack.files[0][1]), keys: Object.keys(e.target.result).sort() });
            t.oncomplete = () => {
              db.close();
              resolve(out);
            };
          };
        }),
    );
    assert.deepEqual(legacy, { version: 2, stores: ["folders", "workspace"], keys: ["current"], current: { marker: "legacy", file: "# Old beta note", keys: ["marker", "stack"] } });
    assert.equal(await editorText(page), "new build note");
    page = null;
  });

  // 9. Damaged records are never overwritten; a damaged index is rebuilt; reserved identities are refused.
  await scenario("damaged workspace, index and Scratch records are left untouched (fallback to Scratch, then memory only); a Stack claiming a Carbon id is refused", async (ctx) => {
    const page = await tab(ctx);
    await page.keyboard.type("scratch survives");
    await settle(page);
    const stack = sample();
    await importStack(page, stack);
    await settle(page);
    const poke = (id, how) =>
      page.evaluate(
        ([id, how]) =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("carbon-vfs");
            open.onsuccess = () => {
              const t = open.result.transaction(["mounts", "meta"], "readwrite");
              if (how === "index") t.objectStore("meta").put("not an index", "index");
              else if (how === "rev") {
                const store = t.objectStore("mounts"),
                  get = store.get(id);
                get.onsuccess = () => store.put({ ...get.result, rev: "unreadable" }, id);
              }
              else {
                const store = t.objectStore("mounts"),
                  get = store.get(id);
                get.onsuccess = () => store.put({ ...get.result, stack: { files: "damaged", directories: [] } }, id);
              }
              t.oncomplete = () => {
                open.result.close();
                resolve();
              };
              t.onabort = () => reject(t.error);
            };
            open.onerror = () => reject(open.error);
          }),
        [id, how],
      );
    // A body that is valid except for its storage revision is not restored (it could never save).
    await poke(stack.manifest.id, "rev");
    await page.reload();
    await ready(page);
    assert.match(await notice(page), /storage revision is unreadable.*left untouched.*Opened Scratch/);
    assert.match(await meta(page), /^Scratch · /);
    // Importing the same id is refused before any preview: the damaged record is never replaced unseen.
    await page.locator("#files").setInputFiles({ name: "same.stack.tar", mimeType: "application/octet-stream", buffer: Buffer.from(writeTar(stack)) });
    await page.waitForFunction(() => document.getElementById("notice").className === "error" && /storage revision is unreadable/.test(document.getElementById("notice").textContent));
    await idle(page);
    assert.equal(await page.evaluate(() => document.getElementById("dialog").open), false);
    assert.match(await meta(page), /^Scratch · /);
    await poke(stack.manifest.id, "body");
    await poke(null, "index");
    const damaged = await raw(page, stack.manifest.id);
    await page.reload();
    await ready(page);
    assert.match(await notice(page), /could not be restored.*left untouched.*Opened Scratch/);
    assert.match(await meta(page), /^Scratch · /);
    assert.equal(await editorText(page), "scratch survives");
    await page.locator("#editor .cm-content").press("Control+End");
    await page.keyboard.type("!");
    await settle(page);
    const after = await raw(page, stack.manifest.id);
    assert.equal(after.body.rev, damaged.body.rev, "the damaged Stack record was not rewritten");
    assert.deepEqual(after.index, after.keys, "the index was rebuilt with every stored workspace");
    // The damaged workspace is listed, refuses to open, and can be removed.
    const rows = await workspaces(page);
    assert.equal(rows.length, 2);
    // Its revision is unreadable too, so the rebuilt entry is listed under its id.
    await workspaces(page, stack.manifest.id);
    assert.match(await notice(page), /could not be restored.*left untouched/);
    assert.match(await meta(page), /^Scratch · /);
    await menuClick(page, "workspaces");
    await page.locator("#dialog-title").filter({ hasText: "Workspaces" }).waitFor();
    await page.locator("#dialog-content .workspace-list li", { hasText: stack.manifest.id }).getByRole("button", { name: "Remove…" }).click();
    await page.locator("#dialog-title").filter({ hasText: "Remove this workspace" }).waitFor();
    await accept(page);
    assert.deepEqual((await raw(page)).keys, ["local-scratch"]);
    // A Stack archive claiming a Carbon workspace id never takes that workspace over.
    const yaml = stack.text("stack.yaml").replace("id: stk-test", "id: local-scratch");
    const { Stack } = await import("../src/core/stack.js");
    const { encode } = await import("../src/core/validate.js");
    const hijack = new Stack([...[...stack.files].filter(([p]) => p !== "stack.yaml"), ["stack.yaml", encode(yaml)]], stack.directories);
    await page.locator("#files").setInputFiles({ name: "hijack.stack.tar", mimeType: "application/octet-stream", buffer: Buffer.from(writeTar(hijack)) });
    await page.waitForFunction(() => document.getElementById("dialog").open || document.getElementById("notice").className === "error");
    if (await page.evaluate(() => document.getElementById("dialog").open)) await accept(page);
    assert.match(await notice(page), /reserved for Carbon's own workspaces/);
    assert.match(await meta(page), /^Scratch · /);
    // Format-valid ids that are also Object.prototype names import as ordinary new Stacks.
    const named = new Stack([...[...stack.files].filter(([p]) => p !== "stack.yaml"), ["stack.yaml", encode(stack.text("stack.yaml").replace("id: stk-test", "id: constructor"))]], stack.directories);
    await importStack(page, named, "constructor.stack.tar");
    assert.equal(await activeId(page), "constructor");
    await scratch(page);
    // An object-shaped index that omits stored bodies is rebuilt, so nothing disappears from the switcher.
    await settle(page);
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open("carbon-vfs");
      open.onsuccess = () => { const t = open.result.transaction("meta", "readwrite"); t.objectStore("meta").put({}, "index"); t.oncomplete = () => { open.result.close(); resolve(); }; t.onabort = () => reject(t.error); };
      open.onerror = () => reject(open.error);
    }));
    assert.equal((await workspaces(page)).length, 2);
    // An entry without a revision is rebuilt from its body too, so Remove stays revision-checked.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open("carbon-vfs");
      open.onsuccess = () => { const t = open.result.transaction("meta", "readwrite"); t.objectStore("meta").put({ "local-scratch": {}, constructor: {} }, "index"); t.oncomplete = () => { open.result.close(); resolve(); }; t.onabort = () => reject(t.error); };
      open.onerror = () => reject(open.error);
    }));
    const listing = await workspaces(page);
    assert.equal(listing.length, 2);
    // A damaged Scratch makes the window memory-only instead of overwriting it.
    await settle(page);
    await poke("local-scratch", "body");
    const before = await raw(page, "local-scratch");
    await page.reload();
    await ready(page);
    assert.equal((await persistence(page)).state, "memory");
    assert.match(await notice(page), /Scratch could not be restored.*left untouched/);
    await page.keyboard.type("in memory");
    await page.waitForTimeout(700);
    assert.equal((await raw(page, "local-scratch")).body.rev, before.body.rev);
    await page.close();
  });

  // 10. Envoy Stack saves are commit-first (owner review on #26): editor Save and Dispatch Context Save.
  await scenario("Stack Save Entry and Dispatch Context Save never report success before the carbon-vfs commit (async quota and stale-revision conflict)", async (ctx) => {
    const page = await tab(ctx);
    const stack = sample();
    await importStack(page, stack);
    const NOTE_PATH = "entries/nested/note.md";
    const stored = async () => {
      const r = await raw(page, stack.manifest.id);
      return { rev: r.body.rev, note: r.body.files.find(([p]) => p === NOTE_PATH)[1], drafts: r.body.drafts };
    };
    const revision = async () => Number(/revision (\d+)/.exec(await meta(page))[1]);
    const asyncQuota = () =>
      page.evaluate(() => {
        window.__put ??= IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          const request = window.__put.call(this, value, key);
          const t = this.transaction;
          if (this.name === "mounts" && !t.__quota) {
            t.__quota = true;
            request.addEventListener("success", () => {
              Object.defineProperty(t, "error", { value: new DOMException("Injected async quota", "QuotaExceededError") });
              t.abort();
            });
          }
          return request;
        };
      });
    const restorePut = () => page.evaluate(() => (IDBObjectStore.prototype.put = window.__put));
    const bumpStoredRev = () =>
      page.evaluate(
        (id) =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("carbon-vfs");
            open.onsuccess = () => {
              const t = open.result.transaction("mounts", "readwrite"), store = t.objectStore("mounts"), get = store.get(id);
              get.onsuccess = () => store.put({ ...get.result, rev: get.result.rev + 1 }, id); // another tab saved
              t.oncomplete = () => { open.result.close(); resolve(); };
              t.onabort = () => reject(t.error);
            };
            open.onerror = () => reject(open.error);
          }),
        stack.manifest.id,
      );
    const recoveredNote = async () => {
      const event = page.waitForEvent("download");
      await page.locator("button.notice-action", { hasText: "Download recovery copy" }).click();
      const file = await event;
      const { readTar } = await import("../src/archives/tar.js");
      return readTar(new Uint8Array(await readFile(await file.path()))).text(NOTE_PATH);
    };
    const failedSave = async (draft, kind) => {
      const before = await stored(), rev = await revision();
      await page.locator("#save-entry").click();
      await page.waitForFunction(() => document.getElementById("notice").className === "error");
      await idle(page);
      assert.match(await notice(page), kind === "quota" ? /quota/i : /another Carbon tab/);
      assert.doesNotMatch(await notice(page), /Entry saved/);
      if (kind === "conflict") assert.equal(await page.locator("button.notice-action", { hasText: "Reload" }).count(), 1);
      assert.equal(await revision(), rev, "no new revision in the window");
      assert.equal(await editorText(page), draft, "the draft is still in the editor");
      assert.equal(await page.locator("#save-entry").isDisabled(), false, "the draft is still unsaved");
      assert.equal((await stored()).rev, before.rev, "stored revision unchanged");
      assert.equal((await stored()).note, before.note, "stored bytes unchanged");
      assert.match(await recoveredNote(), new RegExp(draft.split("\n").pop()), "the recovery copy holds the draft");
    };
    await page.locator(`#tree button[title="${NOTE_PATH}"]`).click();
    await idle(page);
    // Editor Save Entry under an asynchronous quota abort.
    const quotaDraft = (await editorText(page)) + "\nquota draft line";
    await fillEditor(page, quotaDraft);
    await settle(page);
    await asyncQuota();
    await failedSave(quotaDraft, "quota");
    await restorePut();
    await page.locator("#save-entry").click();
    await idle(page);
    assert.match(await notice(page), /Entry saved as a new Stack revision/);
    assert.equal(await revision(), 4);
    assert.match((await stored()).note, /quota draft line/);
    // Editor Save Entry against a stale revision (another tab saved this Stack meanwhile).
    const conflictDraft = (await editorText(page)) + "\nconflict draft line";
    await fillEditor(page, conflictDraft);
    await bumpStoredRev();
    await failedSave(conflictDraft, "conflict");
    // Reload continues with the newer stored copy; the retry then succeeds.
    await page.reload();
    await ready(page);
    assert.equal(await revision(), 4);
    // Dispatch Context "Save Entry now" under an asynchronous quota abort.
    await page.locator(`#tree button[title="${NOTE_PATH}"]`).click();
    await idle(page);
    const contextDraft = (await editorText(page)) + "\ncontext draft line";
    await fillEditor(page, contextDraft);
    await settle(page);
    await menuClick(page, "dispatch-this");
    await page.waitForFunction(() => !document.getElementById("drawer").hidden);
    await page.locator("#draft-objective").fill("Check the context save path.");
    await page.locator("#drawer-steps button").nth(1).click();
    const saveNow = page.locator("#drawer-body button", { hasText: "Save Entry now" });
    await saveNow.waitFor();
    const before = await stored();
    await asyncQuota();
    await saveNow.click();
    await page.waitForFunction(() => document.getElementById("notice").className === "error");
    await idle(page);
    assert.doesNotMatch(await notice(page), /Entry saved/);
    assert.equal(await page.locator("button.notice-action", { hasText: "Download recovery copy" }).count(), 1);
    assert.equal(await revision(), 4);
    assert.deepEqual(await stored(), before);
    assert.equal(await saveNow.count(), 1, "the draft is still unsaved in the Context step");
    await restorePut();
    await saveNow.click();
    await idle(page);
    assert.match(await notice(page), /Entry saved as a new Stack revision/);
    assert.equal(await revision(), 5);
    assert.match((await stored()).note, /context draft line/);
    // Renaming a Stack Entry commits first and keeps its editor session (undo history) at the new path.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("drawer").hidden);
    await page.locator(`#tree button[title="${NOTE_PATH}"]`).click();
    await idle(page);
    const savedText = await editorText(page);
    await page.locator("#editor .cm-content").press("Control+End");
    await page.keyboard.type("\nundo me");
    await page.locator("#save-entry").click();
    await idle(page);
    await menuClick(page, "rename");
    await page.locator("#dialog input").fill("entries/nested/renamed.md");
    await accept(page);
    assert.equal(await page.locator("#current-path").textContent(), "entries/nested/renamed.md");
    assert.match(await editorText(page), /undo me$/);
    await page.locator("#editor .cm-content").press("Control+z");
    assert.equal(await editorText(page), savedText, "undo history survived the rename");
    await page.close();
  });

  assert.deepEqual(allErrors, []);
  assert.deepEqual(allNetwork, []);
  return { checks };
}
