/**
 * Linked-folder acceptance (A3, RFC #25 rev 3: virtual-first linked folders) against dist/carbon.html.
 *
 * The folder lives in the Node process (tests/linked-fake-fs.js) and the page talks to it through
 * a persistent exposed binding, so the test can inspect the "disk", count every write attempt,
 * inject faults, and reload the page without losing it. In the page, handles are class instances
 * whose own properties are plain data, so Chromium can store them in IndexedDB exactly like a real
 * FileSystemDirectoryHandle (the clone loses its prototype; a small IDBRequest shim revives it after
 * a reload, standing in for the platform's own handle cloning). Physical-device behaviour is not
 * covered here.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { editorText } from "./editor-browser-helpers.mjs";
import { menuClick } from "./refinements-browser.mjs";
import { fakeFolder } from "./linked-fake-fs.js";

const hasDialog = (page, title) => page.locator("#dialog-title").filter({ hasText: title }).waitFor();

/** Bridge installed in every page: fake picker, fake handles, disk-history test seam, IDB revival. */
function pageBridge() {
  const call = async (...args) => {
    const r = await window.__fsrpc(...args);
    if (r && r.error) throw Object.assign(new Error(r.error.message), { name: r.error.name });
    return r;
  };
  class FakeHandle {
    constructor(kind, name, id) {
      this.kind = kind;
      this.name = name;
      this.id = id;
      this.fake = true;
    }
    async isSameEntry(other) {
      return !!other && other.fake === true && other.id === this.id;
    }
    queryPermission({ mode }) { return call("query", this.id, mode); }
    requestPermission({ mode }) { return call("request", this.id, mode); }
    async getFileHandle(name, { create = false } = {}) {
      const r = await call("child", this.id, { name, want: "file", create });
      return new FakeHandle("file", name, r.id);
    }
    async getDirectoryHandle(name, { create = false } = {}) {
      const r = await call("child", this.id, { name, want: "directory", create });
      return new FakeHandle("directory", name, r.id);
    }
    async *entries() {
      for (const [name, kind] of await call("list", this.id)) yield [name, new FakeHandle(kind, name, this.id + (this.id.endsWith("|") ? "" : "/") + name)];
    }
    removeEntry(name) { return call("remove", this.id, name); }
    async getFile() {
      const r = await call("getFile", this.id);
      return new File([new Uint8Array(r.bytes)], this.name, { lastModified: r.modified });
    }
    async createWritable() {
      const token = await call("wopen", this.id);
      const w = async (op, bytes) => {
        const r = await window.__fsw(op, token, bytes);
        if (r && r.error) throw Object.assign(new Error(r.error.message), { name: r.error.name });
      };
      return { write: (b) => w("wwrite", Array.from(b)), close: () => w("wclose"), abort: () => w("wabort") };
    }
  }
  window.__FakeHandle = FakeHandle;
  window.__pick = { fs: 0, name: "Field notes" };
  window.__pickCalls = [];
  window.showDirectoryPicker = async (options) => {
    window.__pickCalls.push(options?.mode);
    return new FakeHandle("directory", window.__pick.name, `${window.__pick.fs}|`);
  };
  window.__historyFail = null;
  // Test seam read by app.js: a stand-in for history/disk.js writing through the same fake handles.
  window.__historyOpens = [];
  window.carbonTestDiskHistory = async (root, options) => {
    window.__historyOpens.push(options ?? null);
    if (window.__historyFail) throw new Error(window.__historyFail);
    if (options?.create === false) return { list: async () => [] }; // browsing: read-only, never creates the directory
    const dir = await root.getDirectoryHandle(".carbon-history", { create: true });
    return {
      preserve: async (path, bytes, { modified }) => {
        const file = await dir.getFileHandle(`${encodeURIComponent(path)}@${modified}`, { create: true });
        const w = await file.createWritable();
        await w.write(bytes);
        await w.close();
        return { id: `${path}@${modified}` };
      },
    };
  };
  // Revive handles that came back from IndexedDB as plain data.
  const revive = (v) => {
    if (v && typeof v === "object") {
      if (v.link?.handle?.fake === true && !(v.link.handle instanceof FakeHandle)) {
        const h = v.link.handle;
        v.link.handle = new FakeHandle(h.kind, h.name, h.id);
      }
      if (v.handle?.fake === true && !(v.handle instanceof FakeHandle)) {
        const h = v.handle;
        v.handle = new FakeHandle(h.kind, h.name, h.id);
      }
    }
    return v;
  };
  for (const [proto, prop] of [[IDBRequest.prototype, "result"], [IDBCursorWithValue.prototype, "value"]]) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(proto, prop, { ...d, get() { return revive(d.get.call(this)); } });
  }
}

/** Node side of the bridge. `fakes[n]` is the folder behind picker id `n`. */
async function serve(page, fakes) {
  const writers = new Map();
  let token = 0;
  const parse = (id) => {
    const [n, path] = [id.slice(0, id.indexOf("|")), id.slice(id.indexOf("|") + 1)];
    return { fs: fakes[Number(n)], path };
  };
  await page.exposeFunction("__fsrpc", async (op, id, arg) => {
    try {
      const { fs, path } = parse(id);
      const h = fs.at(path);
      if (op === "query") return fs.ctl.perm[arg];
      if (op === "request") {
        fs.ctl.requests++;
        if (fs.ctl.request === "granted") { fs.ctl.perm[arg] = "granted"; if (arg === "readwrite") fs.ctl.perm.read = "granted"; }
        return fs.ctl.request;
      }
      if (!h) throw Object.assign(new Error(`${path} not found`), { name: "NotFoundError" });
      if (op === "list") {
        const out = [];
        for await (const [name, child] of h.entries()) out.push([name, child.kind]);
        return out;
      }
      if (op === "child") {
        const child = arg.want === "file" ? await h.getFileHandle(arg.name, { create: arg.create }) : await h.getDirectoryHandle(arg.name, { create: arg.create });
        return { id: `${id}${path ? "/" : ""}${arg.name}` };
      }
      if (op === "getFile") {
        const f = await h.getFile();
        return { bytes: [...new Uint8Array(await f.arrayBuffer())], modified: f.lastModified };
      }
      if (op === "remove") return void (await h.removeEntry(arg));
      if (op === "wopen") {
        writers.set(++token, await h.createWritable());
        return token;
      }
      throw new Error(`unknown op ${op}`);
    } catch (e) {
      return { error: { name: e.name, message: e.message } };
    }
  });
  // Writable operations are keyed by token, not path.
  await page.exposeFunction("__fsw", async (op, tok, bytes) => {
    try {
      const w = writers.get(tok);
      if (op === "wwrite") await w.write(new Uint8Array(bytes));
      else if (op === "wclose") { await w.close(); writers.delete(tok); }
      else if (op === "wabort") { await w.abort(); writers.delete(tok); }
      return null;
    } catch (e) {
      return { error: { name: e.name, message: e.message } };
    }
  });
}

/** Every fake-handle operation that could create or write anything on the "disk". */
const writeAttempts = (fs) => fs.ctl.writes.length + fs.ctl.creates;

export async function linkedFlows(browser) {
  const errors = [], network = [], checks = [];
  const fixtureDir = resolve("test-results/copy-fixture");
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(resolve(fixtureDir, "copy.md"), "# Copy\n");

  const newPage = async ({ picker = true } = {}) => {
    const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => { if (/^https?:/.test(r.url())) network.push(r.url()); });
    page.on("dialog", (d) => d.accept());
    const fakes = [];
    await serve(page, fakes);
    await context.addInitScript(
      picker ? `(${pageBridge.toString()})();`
        : "Object.defineProperty(window, 'showDirectoryPicker', { value: undefined });",
    );
    await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
    await page.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
    return { context, page, fakes };
  };
  const helpers = (page) => {
    const idle = () => page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") !== "true");
    const accept = async () => {
      await page.locator("#dialog-accept").click();
      await page.waitForFunction(() => !document.querySelector("#dialog").open);
      await idle();
    };
    const cancel = async () => {
      await page.locator("#dialog-cancel").click();
      await page.waitForFunction(() => !document.querySelector("#dialog").open);
      await idle();
    };
    const notice = () => page.locator("#notice .notice-text").textContent();
    const saveState = () => page.locator("#save-state").textContent();
    const fileState = () => page.locator("#save-state").getAttribute("data-state");
    const edit = async (text) => {
      await page.locator("#view").selectOption("edit");
      await page.locator("#editor .cm-content").press("Control+End");
      await page.keyboard.insertText(text);
      await page.waitForFunction(() => document.querySelector("#save-entry").disabled === false);
    };
    const ctrlS = async () => {
      await page.locator("#editor .cm-content").press("Control+s");
      await page.waitForFunction(() => document.querySelector("#save-entry").disabled === true);
      await idle();
    };
    const open = async (p) => { await page.locator(`#tree button[title="${p}"]`).click(); await idle(); };
    const tree = () => page.locator("#tree > ul button[title]").evaluateAll((bs) => bs.map((b) => b.title).sort());
    const treeTag = (p) => page.locator(`#tree button[title="${p}"] .tag.source`).textContent();
    const refresh = async () => { await page.locator("#refresh-folder").click(); await idle(); };
    /** Sync file to folder…; with `dialog` the caller handles the consent dialog that follows. */
    const sync = async ({ dialog = false } = {}) => {
      await menuClick(page, "sync-file");
      if (!dialog) await idle();
    };
    const reloadPage = async () => {
      await page.waitForTimeout(700);
      await page.reload();
      await page.waitForFunction(() => /Recovered/.test(document.querySelector("#notice").textContent));
    };
    /** Click a button in the per-file source dialog (opened from #save-state). */
    const fileAction = async (label) => {
      await page.locator("#save-state").click();
      await page.waitForSelector("#dialog[open]");
      const title = await page.locator("#dialog-title").textContent();
      await page.locator("#dialog-content button", { hasText: label }).click();
      // The choice closes the file dialog; some choices open another dialog (Compare, Open folder's version, confirmations).
      await page.waitForFunction((t) => !document.querySelector("#dialog").open || document.querySelector("#dialog-title").textContent !== t, title);
      if (!(await page.locator("#dialog").evaluate((d) => d.open))) await idle();
    };
    const closeDialog = async () => {
      await page.locator("#dialog-cancel").click();
      await page.waitForFunction(() => !document.querySelector("#dialog").open);
      await idle();
    };
    return { idle, accept, cancel, notice, saveState, fileState, edit, ctrlS, open, tree, treeTag, refresh, sync, reloadPage, fileAction, closeDialog };
  };

  // ---- unsupported browser: accurate notice, then the independent-copy route ----
  {
    const { context, page } = await newPage({ picker: false });
    const h = helpers(page);
    assert.equal(await page.evaluate(() => typeof window.showDirectoryPicker), "undefined");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), menuClick(page, "open-folder")]);
    assert.match(await h.notice(), /cannot link a folder for saving.*independent copy.*never changed/);
    assert.equal(chooser.isMultiple(), true);
    await chooser.setFiles(fixtureDir);
    await hasDialog(page, "Open local folder copy?");
    assert.doesNotMatch(await page.locator("#dialog-content").textContent(), /linked/i);
    await h.accept();
    assert.equal(await page.locator("#save-entry").textContent(), "Save in copy");
    assert.equal(await page.locator("#link-status").textContent(), "Local copy");
    assert.equal(await page.locator("#sync-file").evaluate((n) => n.hidden), true);
    await context.close();
    checks.push("no showDirectoryPicker: accurate notice and the #folders import route; result is an independent copy without Sync");
  }

  // ---- imported copy while a picker exists: never a consent dialog, never a write ----
  {
    const { context, page, fakes } = await newPage();
    const fs = fakeFolder({ "never.md": "# never\n" });
    fakes.push(fs);
    const h = helpers(page);
    await page.locator("#folders").setInputFiles(fixtureDir);
    await hasDialog(page, "Open local folder copy?");
    await h.accept();
    await h.open("copy.md");
    await h.edit("more\n");
    await h.ctrlS();
    assert.equal(await page.locator("#dialog").evaluate((d) => d.open), false);
    assert.match(await h.notice(), /Saved in this local copy/);
    assert.equal(await page.locator("#save-entry").textContent(), "Save in copy");
    assert.equal(await page.locator("#reconnect-folder").isHidden(), true);
    assert.equal(await page.locator("#refresh-folder").isHidden(), true, "Refresh from folder is for linked workspaces only");
    assert.equal(await page.locator("#save-state").isHidden(), true);
    assert.equal(writeAttempts(fs), 0);
    assert.deepEqual(await page.evaluate(() => window.__pickCalls), []);
    await context.close();
    checks.push("imported copy: Ctrl+S saves the working copy, no consent dialog, no picker use, no writes");
  }

  // ---- the exit condition (#31): empty linked folder, virtual test.txt, zero writes, survives switch + reload, Refresh observes, conflict, Sync ----
  {
    const { context, page, fakes } = await newPage();
    const fs = fakeFolder({}, { name: "Empty" });
    fakes.push(fs);
    const h = helpers(page);
    await page.evaluate(() => { window.__pick.name = "Empty"; });
    await menuClick(page, "open-folder");
    await hasDialog(page, "Open linked folder?");
    const dialog = await page.locator("#dialog-content").textContent();
    assert.match(dialog, /writes nothing/i);
    assert.match(dialog, /Save, New file, Rename and Delete change only Carbon's copy/);
    assert.match(dialog, /Sync file to folder… writes one file/);
    assert.match(dialog, /\(empty folder\)/);
    await h.accept();
    assert.deepEqual(await page.evaluate(() => window.__pickCalls), ["read"]);
    assert.equal(fs.ctl.requests, 0, "opening never requests write permission");
    assert.match(await page.locator("#link-status").textContent(), /Linked: Empty/);
    assert.match(await page.locator("#stack-id").textContent(), /Save keeps changes in this browser only; Sync file to folder… writes one file/);
    assert.match(await page.locator("#stack-status").textContent(), /^All files synced · folder read .+\.$/);
    // New file is available in an empty linked folder.
    for (const id of ["new-entry", "new-folder"]) assert.equal(await page.locator("#" + id).isDisabled(), false, id);
    await page.locator("#new-entry").click();
    await hasDialog(page, "New file");
    await page.locator("#dialog input").fill("test.txt");
    await h.accept();
    assert.equal(await page.locator("#current-path").textContent(), "test.txt");
    assert.equal(await page.locator("#editor .cm-content").getAttribute("aria-label"), "Text editor");
    assert.equal(await h.saveState(), "◌ Only in Carbon");
    assert.equal(await h.fileState(), "virtual");
    assert.equal(await h.treeTag("test.txt"), "◌ Only in Carbon");
    await h.edit("hello virtual\n");
    assert.equal(await page.locator("#save-entry").textContent(), "Save in Carbon");
    assert.equal(await page.locator("#editor-status").evaluate((e) => e.firstChild.textContent), "● unsaved");
    await h.ctrlS();
    assert.match(await h.notice(), /Saved in Carbon \(this browser\) only\. The folder is unchanged; use Sync file to folder… to write test\.txt there\./);
    assert.equal(await page.locator("#dialog").evaluate((d) => d.open), false, "no consent dialog on Save");
    assert.equal(writeAttempts(fs), 0, "zero writes on Save");
    assert.equal(fs.ctl.requests + fs.ctl.queries, 0, "Save never touches folder permission");
    assert.equal(fs.has("test.txt"), false);
    assert.match(await page.locator("#stack-status").textContent(), /^1 file not synced to the folder · folder read/);
    assert.equal(await page.locator("#editor-status").evaluate((e) => e.firstChild.textContent), "◌ only in carbon");
    // Switch away, reload, come back: bytes, path and draft intact.
    await h.edit("draft line\n");
    const draft = await editorText(page);
    await page.waitForTimeout(400);
    await menuClick(page, "open-scratch");
    await page.waitForFunction(() => /^Scratch · /.test(document.querySelector("#stack-meta").textContent));
    await h.idle();
    await h.reloadPage();
    await menuClick(page, "workspaces");
    await hasDialog(page, "Workspaces");
    await page.locator("#dialog-content .workspace-list li", { hasText: "Linked folder" }).getByRole("button", { name: /^Switch to / }).click();
    await page.waitForFunction(() => /^Linked folder · /.test(document.querySelector("#stack-meta").textContent));
    await h.idle();
    assert.equal(await page.locator("#current-path").textContent(), "test.txt");
    assert.equal(await editorText(page), draft, "the draft survived switch and reload");
    assert.match(await page.locator("#link-status").textContent(), /Reconnect needed|Linked: Empty/);
    assert.equal(writeAttempts(fs), 0);
    await h.ctrlS();
    assert.equal(writeAttempts(fs), 0);
    // Refresh without access is refused and changes nothing; Reconnect never refreshes by itself.
    fs.ctl.perm.read = "prompt";
    fs.ctl.perm.readwrite = "prompt";
    fs.ctl.request = "granted";
    const bytesBefore = await editorText(page);
    await menuClick(page, "reconnect-folder").catch(() => {});
    await h.idle();
    assert.equal(await editorText(page), bytesBefore);
    // Refresh is read-only: a file appears on disk; Carbon's tree keeps only test.txt until Import.
    fs.put("incoming.md", "# from disk\n");
    fs.put("test.txt", "hello virtual\ndraft line\n"); // the same bytes copied by hand: matched
    await h.refresh();
    assert.match(await h.notice(), /^Read Empty: 1 new in folder\. Nothing in Carbon was changed; 1 file not synced to the folder\.$/);
    assert.deepEqual(await h.tree(), ["test.txt"], "incoming files are listed, not added");
    assert.equal(await h.saveState(), "✓ Same as folder, not recorded as synced");
    assert.equal(await page.locator("#tree details.source-sec summary").textContent(), "+ New in folder (1)");
    assert.equal(writeAttempts(fs), 0, "Refresh writes nothing");
    // Import the incoming file from the explorer section.
    await page.getByRole("button", { name: "Import incoming.md" }).click();
    await h.idle();
    assert.deepEqual(await h.tree(), ["incoming.md", "test.txt"]);
    assert.match(await h.notice(), /Imported incoming\.md from Empty into Carbon's copy\. The folder is unchanged\./);
    assert.equal(await h.treeTag("incoming.md").catch(() => "none"), "none", "a synced file carries no tag");
    // Sync test.txt: matched bytes are recorded as synced with no write; then a real edit syncs with consent.
    await h.sync({ dialog: true });
    await hasDialog(page, "Sync to the original folder?");
    assert.match(await page.locator("#dialog-content").textContent(), /modify the original files in “Empty” and create the files you sync there/);
    await h.cancel();
    assert.match(await h.notice(), /Sync cancelled\. Nothing in the folder was modified/);
    assert.equal(writeAttempts(fs), 0);
    await h.sync({ dialog: true });
    await hasDialog(page, "Sync to the original folder?");
    await h.accept();
    assert.match(await h.notice(), /already held these bytes; recorded as synced, nothing written/);
    assert.equal(fs.ctl.writes.length, 0);
    assert.equal(await h.saveState(), "✓ Same as folder");
    await h.edit("synced line\n");
    await h.ctrlS();
    assert.equal(fs.text("test.txt"), "hello virtual\ndraft line\n", "Save still writes nothing");
    await h.sync();
    assert.match(await h.notice(), /Synced Empty\/test\.txt \(written and read back\)\. The previous version is in local history\./);
    assert.equal(fs.text("test.txt"), "hello virtual\ndraft line\nsynced line\n");
    assert.equal(fs.ctl.writes.map(([p]) => p).filter((p) => !p.startsWith(".carbon-history")).length, 1, "exactly one file write");
    assert.ok(fs.list(".carbon-history").some((n) => n.startsWith("test.txt@")), "the previous disk version was backed up");
    assert.equal(await h.saveState(), "✓ Same as folder");
    assert.equal(fs.has("incoming.md"), true);
    // A draft blocks Sync.
    await h.edit("unsaved\n");
    await menuClick(page, "sync-file");
    await page.waitForFunction(() => /Save or discard the draft/.test(document.querySelector("#notice").textContent));
    await h.idle();
    assert.equal(fs.text("test.txt"), "hello virtual\ndraft line\nsynced line\n");
    await context.close();
    checks.push("exit condition: empty linked folder, New file, Save = virtual with zero writes and no permission use, draft survives switch + reload, Refresh lists an incoming file without adding it, Import, Sync (consent, matched = no write, edit = one verified write with backup), draft blocks Sync");
  }

  // ---- refresh as observation: external edit / delete / rename leave every virtual byte alone; conflict both ways ----
  {
    const { context, page, fakes } = await newPage();
    const fs = fakeFolder(
      { "a.md": "# Alpha\n", "b.md": "# Beta\n", "c.md": "# Gamma\n", "notes/d.md": "# Delta\n", "data.csv": "x,y\n1,2\n", ".carbon-history/old.txt": "earlier" },
      { name: "Field notes" },
    );
    fakes.push(fs);
    const h = helpers(page);
    await menuClick(page, "open-folder");
    await hasDialog(page, "Open linked folder?");
    await h.accept();
    assert.equal(await page.locator("#refresh-folder").isVisible(), true);
    assert.deepEqual(await h.tree(), ["a.md", "b.md", "c.md", "data.csv", "notes/d.md"]);
    assert.equal(fs.has(".carbon-history/old.txt"), true);
    await h.refresh();
    assert.match(await h.notice(), /no difference from Carbon's copy/);
    // Edit a.md in Carbon (virtual) and draft notes/d.md.
    await h.open("a.md");
    await h.edit("mine\n");
    await h.ctrlS();
    await h.open("notes/d.md");
    await h.edit("Draft survives\n");
    const draft = await editorText(page);
    const virtualBefore = await page.evaluate(() => [...document.querySelectorAll("#tree > ul button[title]")].map((b) => b.title));
    // External: a.md edited (conflict), b.md deleted (missing), c.md renamed (missing + incoming, exact bytes), d.md edited (external change, draft kept), new file.
    fs.put("a.md", "# Alpha from another editor\n");
    fs.remove("b.md");
    fs.put("renamed.md", fs.bytes("c.md"));
    fs.remove("c.md");
    fs.put("notes/d.md", "# Delta on disk\n");
    fs.put("extra.txt", "added outside\n");
    const revisionBefore = await page.locator("#persistence").textContent();
    await h.refresh();
    assert.deepEqual(await h.tree(), virtualBefore.sort(), "the tree is unchanged by Refresh");
    assert.equal(await page.locator("#persistence").textContent(), revisionBefore, "no revision was made");
    assert.equal(await editorText(page), draft, "the draft is untouched");
    assert.equal(await page.locator("#current-path").textContent(), "notes/d.md");
    const text = await h.notice();
    assert.match(text, /^Read Field notes: 2 new in folder, 1 changed in folder, 1 changed in folder and in Carbon, 2 missing from folder\. Nothing in Carbon was changed; 1 file not synced to the folder\.$/);
    assert.deepEqual(await page.locator("#notice .notice-action").allTextContents(), ["Folder changes…"]);
    assert.equal(await h.treeTag("a.md"), "⚠ Changed in folder and in Carbon");
    assert.equal(await h.treeTag("b.md"), "∅ Missing from folder");
    assert.equal(await h.treeTag("c.md"), "∅ Missing from folder");
    assert.equal(await page.locator('#tree button[title="c.md"] .tag.source').getAttribute("title"), "Missing from folder (moved in folder to renamed.md)");
    assert.equal(await h.treeTag("notes/d.md"), "⇣ Changed in folder");
    assert.equal(writeAttempts(fs), 0, "Refresh never writes to the folder");
    // Every virtual byte is still what Carbon held: the Viewer shows Carbon's copy of the externally changed CSV-untouched file and a.md.
    await h.open("a.md");
    assert.equal(await editorText(page), "# Alpha\nmine\n");
    // Accept move with a draft on the moved file is refused (as Rename): the draft would be left at the old path.
    await h.open("c.md");
    await h.edit("moving draft\n");
    const moving = await editorText(page);
    await page.locator("#source-changes").evaluate((b) => b.click());
    await hasDialog(page, "Folder changes · Field notes");
    await page.locator("#dialog-content button", { hasText: "Accept move to renamed.md" }).click();
    await page.waitForFunction(() => /Save or discard the draft of c\.md first/.test(document.querySelector("#notice").textContent));
    await h.idle();
    assert.equal(await page.locator("#current-path").textContent(), "c.md");
    assert.equal(await editorText(page), moving, "the draft stays with its file");
    assert.deepEqual(await h.tree(), virtualBefore.sort(), "nothing was moved");
    await page.locator("#editor-status button", { hasText: "Discard draft" }).click();
    await hasDialog(page, "Discard this draft?");
    await h.accept();
    await h.refresh();
    // Folder changes dialog: Accept move, Import, Compare, Keep mine.
    await page.locator("#notice .notice-action", { hasText: "Folder changes…" }).click();
    await hasDialog(page, "Folder changes · Field notes");
    const changes = await page.locator("#dialog-content").textContent();
    assert.match(changes, /New in folder \(2\)/);
    assert.match(changes, /Changed in folder \(1\)/);
    assert.match(changes, /Changed in folder and in Carbon \(1\)/);
    assert.match(changes, /Missing from folder \(2\)/);
    assert.match(changes, /moved in folder to renamed\.md/);
    await page.locator("#dialog-content button", { hasText: "Accept move to renamed.md" }).click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    await h.idle();
    assert.match(await h.notice(), /Accepted the move: c\.md is now renamed\.md in Carbon/);
    assert.deepEqual(await h.tree(), ["a.md", "b.md", "data.csv", "notes/d.md", "renamed.md"]);
    assert.equal(await h.treeTag("renamed.md").catch(() => "none"), "none");
    // External change with a draft: the draft is kept through Take folder version and saves with the taken bytes.
    // A2.1 (#29) under A3: Show invisibles and Text details describe Carbon's copy, which lives in this browser
    // (never "the bytes last read from disk"), and size a kept draft as Save would write it now.
    const setInvisibles = async (on) => {
      await page.locator("#menu-doc summary").click();
      await page.locator("#show-invisibles").setChecked(on);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.getElementById("menu-doc").open);
    };
    const textDetails = async () => {
      await menuClick(page, "text-details");
      await hasDialog(page, "Text details");
      const text = await page.locator("#dialog-content").textContent();
      await page.locator("#dialog-cancel").click();
      await page.waitForFunction(() => !document.querySelector("#dialog").open);
      return text;
    };
    await h.open("notes/d.md");
    assert.equal(await editorText(page), draft);
    assert.equal(await page.locator("#editor-status").evaluate((e) => e.firstChild.textContent), "● unsaved");
    await setInvisibles(true);
    assert.match(await h.notice(), /line ends \(␊: the committed file's convention\)/);
    assert.equal(await page.locator("#editor .cm-eol").first().getAttribute("title"), "Line break (this file uses LF)");
    let details = await textDetails();
    assert.match(details, /Linked folder: Carbon's copy in this browser/);
    assert.doesNotMatch(details, /last read from disk|writes the original file/);
    assert.match(details, /LF throughout/);
    assert.match(details, new RegExp(`Yes, unsaved: it would save as ${Buffer.byteLength(draft)} bytes with the same line endings`));
    await setInvisibles(false);
    assert.equal(await editorText(page), draft, "the draft stays in the Editor");
    // The folder's version changes again, now to BOM + CRLF; Refresh observes it (nothing in Carbon changes).
    const crlf = "\uFEFF# Delta on disk\r\nwith CRLF\r\n";
    fs.put("notes/d.md", crlf);
    await h.refresh();
    assert.equal(await editorText(page), draft, "Refresh keeps the draft");
    await h.fileAction("Take folder version…");
    await hasDialog(page, "Take the folder's version?");
    assert.match(await page.locator("#dialog-content").textContent(), /Your unsaved draft stays a draft/);
    await h.accept();
    assert.equal(await editorText(page), draft, "the draft stays in the Editor");
    assert.match(await h.notice(), /Your unsaved draft is still here/);
    // The kept draft is sized against the taken bytes: Save rebuilds it with their BOM and CRLF.
    details = await textDetails();
    assert.match(details, /Present \(UTF-8 BOM, 3 bytes\)/);
    assert.match(details, /CRLF throughout/);
    const wouldSave = Buffer.byteLength("\uFEFF" + draft.replace(/\n/g, "\r\n"));
    assert.match(details, new RegExp(`Yes, unsaved: it would save as ${wouldSave} bytes with the same BOM and line endings`));
    assert.deepEqual(errors, [], "Show invisibles and Text details in a linked folder throw nothing");
    await h.ctrlS();
    assert.equal(await h.saveState(), "● Edited in Carbon, not synced");
    assert.deepEqual(fs.bytes("notes/d.md"), new TextEncoder().encode(crlf), "Save wrote nothing to the folder");
    // Compare a.md (conflict): both versions inspectable; nothing changes.
    await h.open("a.md");
    await h.fileAction("Compare");
    await hasDialog(page, "Compare a.md with the folder");
    assert.match(await page.locator("#dialog-content").textContent(), /Carbon's copy \(\d+ bytes\) on the left, the folder's version \(\d+ bytes\)/);
    assert.ok((await page.locator("#dialog-content table.udiff").count()) === 1, "a line diff is shown");
    await h.closeDialog();
    await h.fileAction("Open folder's version");
    await hasDialog(page, "Folder's version of a.md");
    assert.match(await page.locator("#dialog-content").textContent(), /Alpha from another editor/);
    await h.closeDialog();
    assert.equal(await editorText(page), "# Alpha\nmine\n", "inspecting changes nothing");
    assert.equal(writeAttempts(fs), 0);
    // Keep mine: virtual bytes unchanged, state modified; Sync then writes with a backup of the external version.
    await h.fileAction("Keep mine");
    assert.match(await h.notice(), /Kept your version of a\.md\. The folder's version is now the baseline/);
    assert.equal(await h.saveState(), "● Edited in Carbon, not synced");
    assert.equal(await editorText(page), "# Alpha\nmine\n");
    // A later external change after Keep mine makes Sync refuse (no stale agreement).
    fs.put("a.md", "# Alpha changed again\n");
    await menuClick(page, "sync-file");
    await hasDialog(page, "Sync to the original folder?");
    await h.accept();
    await page.waitForFunction(() => /changed in the folder since Carbon last read it/.test(document.querySelector("#notice").textContent));
    await h.idle();
    assert.equal(fs.text("a.md"), "# Alpha changed again\n", "nothing overwritten");
    assert.equal(await h.saveState(), "⚠ Sync refused");
    assert.deepEqual(await page.locator("#notice .notice-action").allTextContents(), ["Refresh from folder"]);
    await page.locator("#notice .notice-action", { hasText: "Refresh from folder" }).click();
    await h.idle();
    assert.equal(await h.saveState(), "⚠ Changed in folder and in Carbon");
    // Take folder version: confirmed, History first, recoverable.
    await h.fileAction("Take folder version…");
    await hasDialog(page, "Take the folder's version?");
    assert.match(await page.locator("#dialog-content").textContent(), /previous version in Carbon goes to History/);
    await h.accept();
    assert.match(await h.notice(), /Took the folder's version of a\.md\. The previous version is in History\./);
    assert.equal(await editorText(page), "# Alpha changed again\n");
    assert.equal(await h.saveState(), "✓ Same as folder");
    await menuClick(page, "history");
    await hasDialog(page, "Revision history");
    const restores = page.getByRole("button", { name: "Restore", exact: true });
    assert.ok((await restores.count()) > 0);
    assert.equal(await restores.first().isDisabled(), false, "History restore is a virtual action in a linked folder");
    assert.match(await page.locator("#dialog-content").textContent(), /Before taking a\.md from the folder/);
    await restores.first().click();
    await h.idle();
    assert.match(await h.notice(), /Restored as a new revision in Carbon\. The folder is unchanged until you Sync file to folder…\./);
    assert.equal(await editorText(page), "# Alpha\nmine\n", "History brought Carbon's version back");
    assert.equal(fs.text("a.md"), "# Alpha changed again\n");
    assert.equal(writeAttempts(fs), 0, "still nothing written");
    // Missing file: Carbon keeps it; Sync offers Recreate.
    await h.open("b.md");
    assert.equal(await h.saveState(), "∅ Missing from folder");
    assert.equal(await editorText(page), "# Beta\n");
    await menuClick(page, "sync-file");
    await page.waitForFunction(() => /no longer in the folder/.test(document.querySelector("#notice").textContent));
    await h.idle();
    assert.equal(fs.has("b.md"), false);
    assert.deepEqual(await page.locator("#notice .notice-action").allTextContents(), ["Recreate in folder", "Refresh from folder"]);
    await page.locator("#notice .notice-action", { hasText: "Recreate in folder" }).click();
    await h.idle();
    assert.equal(fs.text("b.md"), "# Beta\n");
    assert.equal(await h.saveState(), "✓ Same as folder");
    // Virtual delete keeps the folder's version listed and restorable; nothing is deleted on disk.
    await h.open("data.csv");
    await menuClick(page, "delete");
    await hasDialog(page, "Delete Entry?");
    await h.accept();
    assert.equal(fs.has("data.csv"), true);
    assert.deepEqual(await h.tree(), ["a.md", "b.md", "notes/d.md", "renamed.md"]);
    assert.equal(await page.locator("#tree details.source-sec summary", { hasText: "Deleted in Carbon" }).textContent(), "⌫ Deleted in Carbon (1)");
    await page.getByRole("button", { name: "Restore data.csv" }).click();
    await h.idle();
    assert.deepEqual(await h.tree(), ["a.md", "b.md", "data.csv", "notes/d.md", "renamed.md"]);
    assert.match(await h.notice(), /Restored data\.csv in Carbon's copy/);
    // Palette lists the A3 commands; the write-through label is gone.
    await page.locator("#palette-launcher").click();
    await page.locator("#palette-query").fill("Sync file");
    await page.locator("#palette-results").getByText("Sync file to folder…").first().waitFor();
    await page.locator("#palette-query").fill("Folder changes");
    await page.locator("#palette-results").getByText("Folder changes…").first().waitFor();
    await page.locator("#palette-query").fill("Rename");
    await page.locator("#palette-results").getByText("Rename / move Entry…").first().waitFor();
    await page.locator("#palette-query").fill("Save");
    await page.waitForTimeout(300);
    assert.doesNotMatch(await page.locator("#palette-results").textContent(), /Save to folder/);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#command-palette").open);
    // Reload keeps every state: baseline, observation, drafts.
    await h.reloadPage();
    assert.deepEqual(await h.tree(), ["a.md", "b.md", "data.csv", "notes/d.md", "renamed.md"]);
    await h.open("notes/d.md");
    assert.equal(await h.saveState(), "● Edited in Carbon, not synced");
    await context.close();
    checks.push("Refresh as observation: external edit/delete/rename leave every virtual byte, draft, tab and revision unchanged; states shown as text + glyph; Accept move (exact bytes), Compare and Open folder's version, Keep mine then a later disk change refuses Sync, Take folder version is confirmed and recoverable via History, Recreate for a missing file, draft kept through Take, virtual delete + Restore, palette commands, states survive reload");
  }

  // ---- image insertion is a virtual revision; plain text in a linked folder keeps BOM + CRLF through Save and Sync; mixed endings ----
  {
    const { context, page, fakes } = await newPage();
    const fs = fakeFolder({ "notes.txt": "﻿one\r\ntwo\r\n", "mixed.txt": "a\r\nb\n", "a.md": "# A\n" }, { name: "Text folder" });
    fakes.push(fs);
    const h = helpers(page);
    const backups = () => fs.list(".carbon-history"); // the page's test seam keeps snapshots flat: <path>@<modified>
    await page.evaluate(() => { window.__pick.name = "Text folder"; });
    await menuClick(page, "open-folder");
    await hasDialog(page, "Open linked folder?");
    await h.accept();
    await h.open("a.md");
    assert.equal(await page.locator("#insert-image").isDisabled(), false, "image insertion is a virtual change in a linked folder");
    // A real image (the images suite's fixture): the asset is a virtual file, the reference a draft; both
    // survive a reload with the link intact, and nothing reaches the folder.
    const chooser = page.waitForEvent("filechooser");
    await menuClick(page, "insert-image");
    await (await chooser).setFiles({ name: "grid.png", mimeType: "image/png", buffer: await readFile("tests/fixtures/images/grid.png") });
    await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("1 image inserted"));
    await h.idle();
    const asset = (await h.tree()).find((p) => /image-.*\.png$/.test(p));
    assert.ok(asset, "the asset is a file in Carbon's copy");
    const withImage = await editorText(page);
    assert.ok(/!\[Image\]\(/.test(withImage) && withImage.includes(asset.split("/").pop()), "the reference is in the draft");
    assert.equal(await h.treeTag(asset), "◌ Only in Carbon");
    assert.equal(writeAttempts(fs), 0, "an inserted image never reaches the folder");
    await h.reloadPage();
    assert.ok((await h.tree()).includes(asset), "the asset survives a reload");
    assert.match(await page.locator("#link-status").textContent(), /Linked: Text folder|Reconnect needed/);
    await h.open("a.md");
    assert.equal(await editorText(page), withImage, "the reference draft survives a reload");
    assert.equal(fs.has(asset), false);
    assert.equal(writeAttempts(fs), 0);
    if (/Reconnect needed/.test(await page.locator("#link-status").textContent())) {
      await menuClick(page, "reconnect-folder");
      await h.idle();
    }
    await h.open("notes.txt");
    assert.equal(await page.locator("#editor .cm-content").getAttribute("aria-label"), "Text editor");
    assert.equal(await editorText(page), "one\ntwo\n");
    await h.edit("three\n");
    await h.ctrlS();
    assert.deepEqual(fs.bytes("notes.txt"), new TextEncoder().encode("﻿one\r\ntwo\r\n"), "Save writes nothing");
    await h.sync({ dialog: true });
    await hasDialog(page, "Sync to the original folder?");
    await h.accept();
    assert.deepEqual(fs.bytes("notes.txt"), new TextEncoder().encode("﻿one\r\ntwo\r\nthree\r\n"), "BOM and CRLF kept on disk");
    assert.match(await h.notice(), /Synced Text folder\/notes\.txt \(written and read back\)\. The previous version is in local history\./);
    const writes = fs.ctl.writes.length;
    await h.open("mixed.txt");
    assert.match(await h.notice(), /mixes line endings \(1 CRLF, 1 LF\)/);
    await h.edit("c\n");
    await page.locator("#editor .cm-content").press("Control+s");
    await hasDialog(page, "Mixed line endings");
    await h.cancel();
    assert.equal(fs.ctl.writes.length, writes, "refusing writes nothing");
    assert.equal(fs.text("mixed.txt"), "a\r\nb\n");
    assert.equal(await page.locator("#editor-status").evaluate((e) => e.firstChild.textContent), "● unsaved");
    await page.locator("#editor .cm-content").press("Control+s");
    await hasDialog(page, "Mixed line endings");
    await h.accept();
    assert.equal(fs.text("mixed.txt"), "a\r\nb\n", "the explicit LF choice is saved in Carbon only");
    assert.equal(await h.saveState(), "● Edited in Carbon, not synced");
    await h.sync();
    assert.equal(fs.text("mixed.txt"), "a\nb\nc\n", "Sync writes the LF bytes");
    assert.ok(backups().some((n) => n.startsWith("mixed.txt@") && fs.text(`.carbon-history/${n}`) === "a\r\nb\n"), "the mixed original was backed up first");
    // An unreadable Markdown replacement on disk: Take folder version is refused while the draft exists, and adopts the
    // bytes read-only once the draft is discarded (the recovery the refusal names). Nothing is written.
    {
      const writes = fs.ctl.writes.length;
      const bad = new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]);
      await h.open("a.md");
      await h.edit("Mine\n");
      const mine = await editorText(page);
      fs.put("a.md", bad);
      await h.refresh();
      assert.equal(await h.saveState(), "⇣ Changed in folder");
      await h.fileAction("Take folder version…");
      await hasDialog(page, "Take the folder's version?");
      await h.accept();
      await page.waitForFunction(() => /can no longer be edited as text/.test(document.querySelector("#notice").textContent));
      await h.idle();
      assert.match(await h.notice(), /not valid UTF-8.*Carbon's copy and your draft are unchanged/);
      assert.equal(await page.locator("#current-path").textContent(), "a.md");
      assert.equal(await editorText(page), mine, "the draft stays in the Editor");
      await page.locator("#editor-status button", { hasText: "Discard draft" }).click();
      await hasDialog(page, "Discard this draft?");
      await h.accept();
      await h.fileAction("Take folder version…");
      await hasDialog(page, "Take the folder's version?");
      await h.accept();
      await page.waitForFunction(() => /Took the folder's version of a\.md/.test(document.querySelector("#notice").textContent));
      await h.idle();
      await page.locator('#tree button[title="a.md"]').click();
      await hasDialog(page, "Asset");
      assert.match(await page.locator("#dialog-content").textContent(), /Read-only:.*not valid UTF-8|not valid UTF-8.*Read-only:/s);
      await h.closeDialog();
      assert.deepEqual(fs.bytes("a.md"), bad, "the folder's bytes are untouched");
      assert.equal(fs.ctl.writes.length, writes, "nothing was written to the folder");
    }
    await context.close();
    checks.push("linked plain text: image insertion is virtual; BOM + CRLF .txt saves in Carbon and syncs byte-exact through consent and backup; a mixed file is rewritten only by the explicit LF choice and reaches the disk only on Sync; unreadable Markdown on disk is refused while drafted and adopted read-only after Discard draft");
  }

  // ---- the failure surface: permission, backup failure, storage failure after a verified write, two-tab conflict ----
  const { context, page, fakes } = await newPage();
  const fs = fakeFolder({ "notes/a.md": "# Alpha\n", "notes/b.md": "# Beta\n", "readme.txt": "hello" }, { name: "Field notes" });
  fakes.push(fs);
  const h = helpers(page);
  const { idle, accept, notice, saveState, edit, ctrlS, open, sync, reloadPage } = h;
  const diskHistory = () => fs.list(".carbon-history");
  await menuClick(page, "open-folder");
  await hasDialog(page, "Open linked folder?");
  await accept();
  assert.equal(fs.ctl.requests, 0);
  assert.match(await page.locator("#stack-meta").textContent(), /^Linked folder · revision \d+ · \d+ files$/);
  await open("notes/a.md");
  await edit("First edit\n");
  await ctrlS();
  assert.equal(writeAttempts(fs), 0);
  // Consent accepted with remember: Sync writes with backup.
  await sync({ dialog: true });
  await hasDialog(page, "Sync to the original folder?");
  assert.equal(await page.locator("#consent-history").isChecked(), true);
  await page.locator("#consent-remember").check();
  await accept();
  assert.equal(fs.text("notes/a.md"), "# Alpha\nFirst edit\n");
  assert.equal(diskHistory().length, 1);
  assert.equal(await page.locator("#forget-folder").evaluate((el) => el.hidden), false, "remembered consent can be withdrawn");
  checks.push("Sync: consent with remember, verified write, backup");

  // Permission denied at Sync: nothing written, Carbon's copy kept, Reconnect offered; editing continues.
  fs.ctl.perm.readwrite = "prompt";
  fs.ctl.request = "denied";
  await edit("Second edit\n");
  await ctrlS();
  const before = fs.text("notes/a.md");
  await menuClick(page, "sync-file");
  await page.waitForFunction(() => /write permission denied/.test(document.querySelector("#notice").textContent));
  await idle();
  assert.equal(fs.text("notes/a.md"), before);
  assert.match(await page.locator("#link-status").textContent(), /Reconnect needed/);
  assert.equal(await page.locator("#reconnect-folder").evaluate((el) => el.hidden), false);
  await edit("Still editing\n");
  await ctrlS();
  assert.match(await notice(), /Saved in Carbon \(this browser\) only/);
  await menuClick(page, "sync-file");
  await page.waitForFunction(() => /Reconnect folder/.test(document.querySelector("#notice").textContent));
  await idle();
  assert.deepEqual(await page.locator("#notice .notice-action").allTextContents(), ["Reconnect folder…"]);
  fs.ctl.request = "granted";
  await menuClick(page, "reconnect-folder");
  await page.waitForFunction(() => document.querySelector("#reconnect-folder").hidden);
  await idle();
  assert.match(await notice(), /Nothing was read or written/);
  assert.deepEqual(await page.locator("#notice .notice-action").allTextContents(), ["Refresh from folder"]);
  await sync();
  assert.match(fs.text("notes/a.md"), /Still editing/);
  checks.push("permission denied: nothing written, editing continues, Sync refused until Reconnect (which reads nothing), then synced");

  // Backup failure: the original must stay unchanged; the one-off override works.
  await page.evaluate(() => { window.__historyFail = "disk full"; });
  await edit("Third edit\n");
  await ctrlS();
  const keep = fs.text("notes/a.md"), snapshots = diskHistory().length;
  await menuClick(page, "sync-file");
  await page.waitForFunction(() => /Sync stopped: the backup could not be written \(disk full\)\. The original file is unchanged\./.test(document.querySelector("#notice").textContent));
  await idle();
  assert.equal(fs.text("notes/a.md"), keep);
  assert.equal(diskHistory().length, snapshots);
  assert.equal(await saveState(), "⚠ Sync failed");
  assert.deepEqual(await page.locator("#notice .notice-action").allTextContents(), ["Sync without history…"]);
  await page.evaluate(() => { window.__historyFail = null; });
  await sync();
  assert.match(fs.text("notes/a.md"), /Third edit/);
  checks.push("backup failure: sync stopped, file and history unchanged; retry syncs");

  // Browser storage fails AFTER a verified disk write: the notice says both things, storage stays on, other workspaces
  // stay reachable, and after a reload the file reads "same as folder, not recorded" instead of a conflict.
  const storeFault = (kind) =>
    page.evaluate((kind) => {
      window.__put ??= IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = window.__put.call(this, value, key);
        const t = this.transaction;
        if (this.name === "mounts" && !t.__fault) {
          t.__fault = true;
          request.addEventListener("success", () => {
            if (kind === "quota") Object.defineProperty(t, "error", { value: new DOMException("Injected async quota", "QuotaExceededError") });
            t.abort();
          });
        }
        return request;
      };
    }, kind);
  const storeRestore = () => page.evaluate(() => (IDBObjectStore.prototype.put = window.__put));
  const persistenceState = () => page.evaluate(() => document.getElementById("persistence").dataset.state);
  const linkedId = () =>
    page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open("carbon-vfs");
      open.onsuccess = () => {
        const g = open.result.transaction("meta").objectStore("meta").get("active");
        g.onsuccess = () => { open.result.close(); resolve(g.result.mountId); };
      };
    }));
  await edit("Quota after disk\n");
  await ctrlS();
  await page.waitForTimeout(400);
  await storeFault("quota");
  await menuClick(page, "sync-file");
  await page.waitForFunction(() => /Synced .*Browser storage did not record the sync: it is full/.test(document.querySelector("#notice").textContent));
  await idle();
  assert.match(fs.text("notes/a.md"), /Quota after disk/, "the verified disk write stands");
  assert.equal(await persistenceState(), "quota", "storage stays on (not disabled) in the storage-full state");
  assert.equal(await page.locator("button.notice-action", { hasText: "Download recovery copy" }).count(), 1);
  assert.equal(await saveState(), "✓ Same as folder", "in this window the baseline is the verified disk");
  await storeRestore();
  await menuClick(page, "open-scratch");
  await page.waitForFunction(() => /^Scratch · /.test(document.querySelector("#stack-meta").textContent));
  await idle();
  await menuClick(page, "workspaces");
  await hasDialog(page, "Workspaces");
  await page.locator("#dialog-content .workspace-list li", { hasText: "Linked folder" }).getByRole("button", { name: /^Switch to / }).click();
  await page.waitForFunction(() => /^Linked folder · /.test(document.querySelector("#stack-meta").textContent));
  await idle();
  await open("notes/a.md");
  await edit("After quota\n");
  await ctrlS();
  await sync();
  assert.match(fs.text("notes/a.md"), /Quota after disk\nAfter quota/);
  // Revision conflict (another tab wrote this workspace) BEFORE the disk write: the stale window writes nothing.
  const id = await linkedId();
  const bump = () => page.evaluate((id) => new Promise((resolve) => {
    const open = indexedDB.open("carbon-vfs");
    open.onsuccess = () => {
      const t = open.result.transaction(["mounts", "meta"], "readwrite"), store = t.objectStore("mounts"), g = store.get(id);
      g.onsuccess = () => {
        const body = { ...g.result, rev: g.result.rev + 1 };
        store.put(body, id);
        const meta = t.objectStore("meta"), gi = meta.get("index");
        gi.onsuccess = () => meta.put({ ...gi.result, [id]: { ...gi.result[id], rev: body.rev } }, "index");
      };
      t.oncomplete = () => { open.result.close(); resolve(); };
    };
  }), id);
  await edit("Stale window\n");
  await ctrlS();
  await page.waitForTimeout(400);
  await bump();
  const onDisk = fs.text("notes/a.md");
  const writesBefore = fs.ctl.writes.length;
  await menuClick(page, "sync-file");
  await page.waitForFunction(() => /another Carbon tab/.test(document.querySelector("#notice").textContent));
  await idle();
  assert.equal(fs.text("notes/a.md"), onDisk, "a stale window never writes the folder");
  assert.equal(fs.ctl.writes.length, writesBefore);
  assert.equal(await saveState(), "⚠ Sync failed");
  assert.equal(await persistenceState(), "conflict");
  // Reload continues with the stored copy: the edit saved before the other tab's write is there, still not synced, and the disk is untouched.
  await reloadPage();
  await open("notes/a.md");
  assert.match(await editorText(page), /Stale window/);
  assert.equal(await saveState(), "● Edited in Carbon, not synced");
  assert.equal(fs.text("notes/a.md"), onDisk);
  checks.push("storage quota after a verified write: two-part notice, store stays on, other workspaces reachable; a stale window (another tab's revision) writes nothing to the disk");

  // carbon-vfs: picking the open folder again is that same workspace (isSameEntry); remembered consent and Forget.
  const dropLinkedWorkspace = async () => {
    await menuClick(page, "open-folder");
    await page.waitForFunction(() => /already the open workspace/.test(document.querySelector("#notice").textContent));
    await idle();
    await menuClick(page, "open-scratch");
    await page.waitForFunction(() => /^Scratch · /.test(document.querySelector("#stack-meta").textContent));
    await idle();
    await menuClick(page, "open-folder");
    await page.waitForFunction(() => /^Linked folder · /.test(document.querySelector("#stack-meta").textContent));
    await idle();
    assert.match(await notice(), /Switched to Field notes/);
    await menuClick(page, "open-scratch");
    await page.waitForFunction(() => /^Scratch · /.test(document.querySelector("#stack-meta").textContent));
    await idle();
    await menuClick(page, "workspaces");
    await hasDialog(page, "Workspaces");
    await page.locator("#dialog-content .workspace-list li", { hasText: "Linked folder" }).getByRole("button", { name: "Remove…" }).click();
    await hasDialog(page, "Remove this workspace from the browser?");
    await accept();
  };
  await dropLinkedWorkspace();
  await menuClick(page, "open-folder");
  await hasDialog(page, "Open linked folder?");
  await accept();
  await open("notes/b.md");
  await edit("Remembered\n");
  await ctrlS();
  const requestsBefore = fs.ctl.requests;
  fs.ctl.perm.readwrite = "prompt";
  await sync();
  assert.equal(await page.locator("#dialog").evaluate((d) => d.open), false);
  assert.equal(fs.ctl.requests, requestsBefore + 1, "remembered consent still asks the browser for permission");
  assert.match(fs.text("notes/b.md"), /Remembered/);
  checks.push("remembered consent: reopening the same folder (isSameEntry) skips the dialog; permission is still requested");

  assert.equal(await page.locator("#forget-folder").evaluate((el) => el.hidden), false);
  await menuClick(page, "forget-folder");
  await hasDialog(page, "Forget remembered consent?");
  await accept();
  assert.match(await notice(), /Forgot remembered consent for Field notes/);
  assert.equal(await page.locator("#forget-folder").evaluate((el) => el.hidden), true);
  await dropLinkedWorkspace();
  await menuClick(page, "open-folder");
  await hasDialog(page, "Open linked folder?");
  await accept();
  await open("notes/b.md");
  await edit("After forgetting\n");
  await ctrlS();
  await menuClick(page, "sync-file");
  await hasDialog(page, "Sync to the original folder?");
  await h.cancel();
  assert.doesNotMatch(fs.text("notes/b.md"), /After forgetting/);
  // Browsing local history needs no write consent and is read-only; Restore puts the version into Carbon's copy.
  const opensBefore = await page.evaluate(() => window.__historyOpens.length);
  await menuClick(page, "disk-history");
  await hasDialog(page, "Local file history (on disk)");
  assert.match(await page.locator("#dialog-content").textContent(), /No earlier versions of this file/);
  assert.deepEqual(await page.evaluate((n) => window.__historyOpens.slice(n), opensBefore), [{ create: false }]);
  await h.cancel();
  checks.push("Forget remembered consent…: record deleted, next folder open asks again; Local file history… opens read-only (create:false) without any granted consent");

  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  await context.close();
  return { checks, pageErrors: errors, networkRequests: network, physicalDevices: "Not covered: fake in-page handles are not real File System Access behaviour." };
}
