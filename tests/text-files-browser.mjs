/**
 * A2 acceptance (RFC #25 rev 3): any bounded UTF-8 text is editable in ordinary workspaces, plain
 * text is never interpreted as Markdown/HTML, BOM and uniform line endings survive a save byte for
 * byte, mixed line endings are refused unless LF is chosen explicitly, unreadable files stay
 * read-only with a reason, save failures keep the draft, and strict Stacks stay Markdown-only.
 * Real file:// page, offline.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readTarFiles, writeTar } from "../src/archives/tar.js";
import { newStack, Stack } from "../src/core/stack.js";
import { encode, decode, LIMITS } from "../src/core/validate.js";
import { editorText, editorView } from "./editor-browser-helpers.mjs";
import { menuClick } from "./refinements-browser.mjs";

const BOM = "﻿";

export async function textFileFlows(browser) {
  const errors = [], network = [], checks = [];
  const nulLate = new Uint8Array(9000).fill(0x61);
  nulLate[8999] = 0;
  const files = new Map([
    ["notes.txt", encode(`${BOM}one\r\ntwo\r\n`)],
    ["classic.txt", encode("first\rsecond\r")],
    ["mixed.txt", encode("a\r\nb\nc\r\n")],
    ["config.yaml", encode("---\ntitle: Not frontmatter\n---\nkey: value\n")],
    ["page.html", encode('<script>window.pwned = 1</script><img src=x onerror="window.pwned = 2">\n')],
    ["src/tool.py", encode("def greet(name):\n    return name\n")],
    ["README", encode("no extension\n")],
    ["data.json", encode('{"n": 9007199254740993}\n')],
    ["a.md", encode("# A\n\nSee [[README]] and [[a]].\n")],
    ["bad.txt", new Uint8Array([0x61, 0xff, 0xfe, 0x0a])],
    ["late-nul.txt", nulLate],
    ["big.txt", new Uint8Array(LIMITS.text + 1).fill(0x61)],
  ]);
  const fixture = resolve("test-results/text-files-folder");
  await rm(fixture, { recursive: true, force: true });
  for (const [p, bytes] of files) {
    await mkdir(dirname(resolve(fixture, p)), { recursive: true });
    await writeFile(resolve(fixture, p), bytes);
  }
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (/^https?:/.test(r.url())) network.push(r.url()); });
  page.on("dialog", (d) => d.accept());
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
  const title = (text) => page.locator("#dialog-title").filter({ hasText: text }).waitFor();
  const notice = () => page.locator("#notice").textContent();
  const open = async (p) => { await page.locator(`#tree button[title="${p}"]`).click(); await idle(); };
  const label = () => page.locator("#editor .cm-content").getAttribute("aria-label");
  const type = async (text) => {
    await page.locator("#view").selectOption("edit");
    await page.locator("#editor .cm-content").press("Control+End");
    await page.keyboard.insertText(text);
    await page.waitForFunction(() => document.querySelector("#save-entry").disabled === false);
  };
  const save = async () => { await page.locator("#editor .cm-content").press("Control+s"); await idle(); };
  const committed = async () => {
    const download = page.waitForEvent("download");
    await menuClick(page, "export-tar");
    const d = await download;
    await idle();
    return new Map(readTarFiles(new Uint8Array(await readFile(await d.path()))).files);
  };
  const downloaded = async (click) => {
    const download = page.waitForEvent("download");
    await click();
    return new Uint8Array(await readFile(await (await download).path()));
  };
  const revision = async () => Number(/revision (\d+)/.exec(await page.locator("#stack-meta").textContent())[1]);
  try {
    await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
    await page.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
    await idle();
    await page.locator("#folders").setInputFiles(fixture);
    await title("Open local folder copy?");
    await accept();
    assert.equal(await page.locator("#current-path").textContent(), "a.md", "Markdown is opened first");

    // ---- every text type opens in the plain Text editor; Markdown keeps its editor ----
    for (const p of ["notes.txt", "classic.txt", "config.yaml", "page.html", "src/tool.py", "README", "data.json"]) {
      await open(p);
      assert.equal(await page.locator("#current-path").textContent(), p, p);
      assert.equal(await label(), "Text editor", p);
      assert.equal(await page.locator("#editor .cm-content").getAttribute("contenteditable"), "true", p);
      for (const id of ["format-bold", "toggle-task", "insert-image"]) assert.equal(await page.locator("#" + id).isDisabled(), true, `${p}: ${id}`);
      assert.equal(await page.locator("#select-next").isDisabled(), false, p);
    }
    assert.equal(await page.locator("#assets-section").isHidden(), false, "unreadable files are still listed");
    const assets = await page.locator("#assets .asset-row").evaluateAll((rows) => rows.map((r) => [r.title, r.querySelector(".tag").textContent]));
    assert.deepEqual(assets, [["bad.txt", "BIN"], ["big.txt", "TXT"], ["late-nul.txt", "TXT"]], "editable text is a document, not an Asset");
    await open("a.md");
    assert.equal(await label(), "Markdown editor");
    assert.equal(await page.locator("#format-bold").isDisabled(), false);
    checks.push(".txt, lone-CR, .yaml, .html, .py, extensionless and .json open in the Text editor; Markdown keeps the Markdown editor and commands");

    // ---- plain text is inert: no frontmatter, Markdown, HTML or wiki links ----
    await page.locator("#view").selectOption("split");
    await open("config.yaml");
    const yamlPreview = await page.locator("#preview").textContent();
    assert.match(yamlPreview, /Not a Markdown file/);
    assert.match(yamlPreview, /---\s*title: Not frontmatter\s*---\s*key: value/);
    assert.equal(await page.locator("#preview h1, #preview hr").count(), 0);
    assert.equal(await page.locator("#preview").getAttribute("aria-label"), "Plain text preview");
    await open("page.html");
    assert.match(await page.locator("#preview .code-body").textContent(), /<script>window\.pwned = 1<\/script>/);
    await page.getByRole("button", { name: "Open page.html in Viewer", exact: true }).click();
    await idle();
    assert.equal(await page.locator("#preview script, #preview img, #viewer-content script, #viewer-content img").count(), 0);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    // Lone-CR text previews line by line (CSS does not break at CR).
    await open("classic.txt");
    assert.equal(await page.locator("#preview .asset-preview pre").textContent(), "first\nsecond\n");
    // Wiki links resolve only to Markdown documents.
    await open("a.md");
    assert.equal(await page.locator('#preview a[data-entry="README"]').count(), 0, "[[README]] does not link plain text");
    assert.equal(await page.locator("#preview").getAttribute("aria-label"), "Markdown preview");
    checks.push("plain text previews inertly: a leading YAML block is content, HTML is text, wiki links never target plain text");

    // ---- Markdown editing behaviors stay off in plain text ----
    await open("README");
    await page.locator("#view").selectOption("edit");
    await editorView(page);
    await page.evaluate(() => carbonTestSelect([[0, 2]]));
    await page.locator("#editor .cm-content").press("Control+b");
    await page.locator("#editor .cm-content").press("Alt+c");
    assert.equal(await editorText(page), "no extension\n", "Mod-B / Alt-C do nothing in plain text");
    await page.evaluate(() => carbonTestSelect([[0, 2]]));
    await page.keyboard.type("*");
    assert.equal(await editorText(page), "* extension\n", "typing * replaces the selection; no surround");
    await page.locator("#editor .cm-content").press("Control+End");
    await page.keyboard.insertText("- item");
    await page.locator("#editor .cm-content").press("Enter");
    assert.equal(await editorText(page), "* extension\n- item\n", "Enter does not continue a list");
    // Paste carrying a file (as office apps and browsers send) is ordinary text paste, not image insertion.
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "clip.png", { type: "image/png" }));
      data.setData("text/plain", "pasted");
      document.querySelector("#editor .cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    assert.equal(await editorText(page), "* extension\n- item\npasted", "the text is pasted");
    assert.doesNotMatch(await notice(), /Open a Markdown Entry|image/i);
    await page.locator("#editor-status button", { hasText: "Discard draft" }).click();
    await accept();
    assert.equal(await editorText(page), "no extension\n");
    checks.push("plain text: no surround, Bold, task toggle or list continuation; paste with a file attached pastes text");

    // ---- BOM + CRLF and lone-CR files save byte for byte except the edit ----
    await open("notes.txt");
    assert.equal(await editorText(page), "one\ntwo\n", "the editor shows LF text without the BOM");
    await type("three\n");
    let before = await revision();
    await save();
    assert.equal(await revision(), before + 1);
    await open("classic.txt");
    await type("third\n");
    await save();
    let bytes = await committed();
    assert.deepEqual(bytes.get("notes.txt"), encode(`${BOM}one\r\ntwo\r\nthree\r\n`));
    assert.deepEqual(bytes.get("classic.txt"), encode("first\rsecond\rthird\r"));
    for (const p of ["config.yaml", "page.html", "src/tool.py", "README", "data.json", "bad.txt", "late-nul.txt", "big.txt", "mixed.txt"])
      assert.deepEqual(bytes.get(p), files.get(p), `${p} unchanged`);
    assert.deepEqual(await downloaded(() => menuClick(page, "download-file")), encode("first\rsecond\rthird\r"));
    checks.push("BOM + CRLF and lone-CR files save byte-identical except the edit; every other file keeps its bytes");

    // ---- mixed line endings: notice, refusal with exact download, explicit LF ----
    await open("mixed.txt");
    assert.match(await notice(), /mixed\.txt mixes line endings \(2 CRLF, 1 LF\)\. You can edit it; Save asks before changing them to LF\./);
    // Undoing every edit leaves no draft, although an LF draft can never equal the mixed original.
    await type("x");
    await page.locator("#editor .cm-content").press("Control+z");
    await page.waitForFunction(() => document.querySelector("#save-entry").disabled === true);
    assert.equal(await editorText(page), "a\nb\nc\n");
    await type("d\n");
    before = await revision();
    await page.locator("#editor .cm-content").press("Control+s");
    await title("Mixed line endings");
    assert.match(await page.locator("#dialog-content").textContent(), /Nothing has been saved; your draft is kept either way/);
    assert.equal(await page.locator("#dialog-accept").textContent(), "Save with LF line endings");
    assert.deepEqual(await downloaded(() => page.getByRole("button", { name: "Download original file", exact: true }).click()), files.get("mixed.txt"));
    await cancel();
    assert.match(await notice(), /Not saved: mixed\.txt keeps its mixed line endings\. Your draft is kept\./);
    assert.equal(await revision(), before);
    assert.equal(await editorText(page), "a\nb\nc\nd\n");
    assert.equal(await page.locator("#save-entry").isDisabled(), false, "the draft is still unsaved");
    await page.locator("#save-entry").click();
    await title("Mixed line endings");
    await accept();
    assert.match(await notice(), /line endings are now LF, as you chose; History keeps the previous version/);
    assert.equal(await revision(), before + 1);
    assert.deepEqual((await committed()).get("mixed.txt"), encode("a\nb\nc\nd\n"));
    checks.push("mixed line endings: one-time notice, Save refused (exact original downloadable, draft kept), explicit Save with LF line endings");

    // ---- unreadable files stay read-only with a reason and exact download ----
    for (const [p, reason] of [["bad.txt", /not valid UTF-8/], ["late-nul.txt", /NUL bytes/], ["big.txt", /larger than the 1 MiB text editing limit/]]) {
      const current = await page.locator("#current-path").textContent();
      await page.locator(`#tree button[title="${p}"]`).click(); // the dialog keeps the workspace busy until it closes
      await title("Asset");
      assert.match(await page.locator("#dialog-content").textContent(), reason, p);
      assert.match(await page.locator("#dialog-content").textContent(), /Read-only:/, p);
      assert.deepEqual(await downloaded(() => page.getByRole("button", { name: "Download Asset", exact: true }).click()), files.get(p), p);
      await cancel();
      assert.equal(await page.locator("#current-path").textContent(), current, `${p} did not open in the Editor`);
    }
    checks.push("invalid UTF-8, NUL after 8 KiB and 1 MiB + 1 stay read-only with a stated reason and exact download");

    // ---- a failed save keeps the draft and the revision; reload keeps the draft ----
    await open("src/tool.py");
    await type("# more\n");
    const draft = await editorText(page);
    before = await revision();
    await page.evaluate(() => {
      window.originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { throw new Error("Injected text save failure"); };
    });
    await page.locator("#save-entry").click();
    await idle();
    assert.match(await notice(), /Injected text save failure/);
    assert.equal(await revision(), before);
    assert.equal(await editorText(page), draft);
    assert.equal(await page.locator("#save-entry").isDisabled(), false);
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForFunction(() => /Recovered/.test(document.querySelector("#notice").textContent));
    await idle();
    assert.equal(await page.locator("#current-path").textContent(), "src/tool.py");
    assert.equal(await label(), "Text editor");
    assert.equal(await editorText(page), draft, "the draft survived the failed save and the reload");
    await save();
    assert.equal(await revision(), before + 1);
    assert.deepEqual((await committed()).get("src/tool.py"), encode(draft));
    checks.push("a failed browser-storage save keeps the draft and revision; the draft survives reload and saves afterwards");

    // ---- new files of any type, rename across modes ----
    await page.locator("#new-entry").click();
    await title("New file");
    const suggestion = await page.locator("#dialog-content input").inputValue();
    assert.match(suggestion, /^note-\d{8}-\d{3}\.md$/, "an ordinary folder suggests its root, not entries/");
    await page.locator("#dialog-content input").fill("CON.txt");
    await page.locator("#dialog-accept").click();
    assert.match(await page.locator("#dialog-error").textContent(), /Unsafe path/);
    await page.locator("#dialog-content input").fill("todo.txt");
    await accept();
    assert.equal(await page.locator("#current-path").textContent(), "todo.txt");
    assert.equal(await editorText(page), "", "a non-Markdown file starts empty");
    assert.equal(await label(), "Text editor");
    await type("- [ ] call\n");
    await save();
    await menuClick(page, "rename");
    await title("Rename or move file");
    await page.locator("#dialog-content input").fill("todo.md");
    await accept();
    assert.equal(await page.locator("#current-path").textContent(), "todo.md");
    assert.equal(await label(), "Markdown editor", "the renamed file takes Markdown mode");
    assert.equal(await page.locator("#format-bold").isDisabled(), false);
    await page.locator("#view").selectOption("split");
    assert.equal(await page.locator('#preview input[type="checkbox"]').count(), 1, "rendered as Markdown now");
    await menuClick(page, "rename");
    await title("Rename or move file");
    await page.locator("#dialog-content input").fill("notes/LICENSE");
    await accept();
    assert.equal(await label(), "Text editor");
    bytes = await committed();
    assert.deepEqual(bytes.get("notes/LICENSE"), encode("- [ ] call\n"));
    assert.equal(bytes.has("todo.txt") || bytes.has("todo.md"), false);
    checks.push("New file accepts any safe name (empty non-Markdown start, unsafe names refused); rename switches between Markdown and Text modes");
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
  } finally {
    await context.close();
  }

  // ---- Scratch: a plain text note is created, saved in the browser and back after a reload ----
  {
    const ctx = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 } });
    const scratchPage = await ctx.newPage();
    scratchPage.on("pageerror", (e) => errors.push(e.message));
    scratchPage.on("request", (r) => { if (/^https?:/.test(r.url())) network.push(r.url()); });
    const idleS = () => scratchPage.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") !== "true");
    try {
      await scratchPage.goto(pathToFileURL(resolve("dist/carbon.html")).href);
      await scratchPage.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
      await idleS();
      assert.equal(await scratchPage.locator("#stack-title").textContent(), "Scratch");
      await scratchPage.locator("#new-entry").click();
      await scratchPage.locator("#dialog-title").filter({ hasText: "New file" }).waitFor();
      await scratchPage.locator("#dialog-content input").fill("lists/groceries.txt");
      await scratchPage.locator("#dialog-accept").click();
      await scratchPage.waitForFunction(() => !document.querySelector("#dialog").open);
      await idleS();
      assert.equal(await scratchPage.locator("#editor .cm-content").getAttribute("aria-label"), "Text editor");
      await scratchPage.locator("#editor .cm-content").press("Control+End");
      await scratchPage.keyboard.insertText("milk\n*eggs*\n");
      await scratchPage.locator("#editor .cm-content").press("Control+s");
      await idleS();
      assert.equal(await scratchPage.locator("#save-entry").textContent(), "Save note");
      assert.match(await scratchPage.locator("#notice").textContent(), /Saved in Scratch in this browser/);
      await scratchPage.waitForFunction(() => document.getElementById("persistence").dataset.state === "saved");
      await scratchPage.waitForTimeout(450);
      await scratchPage.reload();
      await scratchPage.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
      await idleS();
      assert.equal(await scratchPage.locator("#current-path").textContent(), "lists/groceries.txt");
      assert.equal(await scratchPage.locator("#editor .cm-content").getAttribute("aria-label"), "Text editor");
      assert.equal(await editorText(scratchPage), "milk\n*eggs*\n");
      assert.equal(await scratchPage.locator("#save-entry").isDisabled(), true, "saved, not a draft");
      checks.push("Scratch: a .txt note is created, saved in this browser and reopened in the Text editor after reload");
    } finally {
      await ctx.close();
    }
  }

  // ---- BOM-prefixed Markdown: palette passages still navigate (offsets match the Editor's text) ----
  {
    const ctx = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 } });
    const bomPage = await ctx.newPage();
    bomPage.on("pageerror", (e) => errors.push(e.message));
    bomPage.on("request", (r) => { if (/^https?:/.test(r.url())) network.push(r.url()); });
    const idleB = () => bomPage.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") !== "true");
    try {
      await bomPage.goto(pathToFileURL(resolve("dist/carbon.html")).href);
      await bomPage.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
      await idleB();
      await bomPage.locator("#local-files").setInputFiles({ name: "bom.md", mimeType: "text/markdown", buffer: Buffer.from(encode(`${BOM}# Bom\r\n\r\nfind the needle here\r\n`)) });
      await bomPage.locator("#dialog-title").filter({ hasText: "Open local folder copy?" }).waitFor();
      await bomPage.locator("#dialog-accept").click();
      await bomPage.waitForFunction(() => !document.querySelector("#dialog").open);
      await idleB();
      assert.equal(await bomPage.locator("#current-path").textContent(), "bom.md");
      assert.equal(await editorText(bomPage), "# Bom\n\nfind the needle here\n");
      await bomPage.locator("#palette-launcher").click();
      await bomPage.locator("#palette-query").fill("needle");
      await bomPage.locator(".palette-document summary").first().waitFor();
      await bomPage.locator(".palette-document summary").first().click();
      await bomPage.locator(".palette-excerpts button").first().click();
      await idleB();
      assert.equal(await bomPage.locator(".cm-palette-hit").textContent(), "needle");
      assert.doesNotMatch(await bomPage.locator("#notice").textContent(), /This Entry changed/);
      checks.push("BOM-prefixed Markdown: a palette passage navigates to the exact match in the Editor");
    } finally {
      await ctx.close();
    }
  }

  // ---- strict Envoy Stack: Markdown-only editing is unchanged ----
  {
    const ctx = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const stackPage = await ctx.newPage();
    stackPage.on("pageerror", (e) => errors.push(e.message));
    stackPage.on("request", (r) => { if (/^https?:/.test(r.url())) network.push(r.url()); });
    const idleS = () => stackPage.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") !== "true");
    try {
      await stackPage.goto(pathToFileURL(resolve("dist/carbon.html")).href);
      await stackPage.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
      await idleS();
      const base = newStack("Strict text");
      const stack = new Stack([...base.files, ["entries/a.md", encode("---\r\nid: ent-a\r\n---\r\n# A\r\nbody\r\n")], ["assets/notes.txt", encode("plain\n")]]);
      await stackPage.locator("#files").setInputFiles({ name: "strict.stack.tar", mimeType: "application/octet-stream", buffer: Buffer.from(writeTar(stack)) });
      await stackPage.waitForSelector("#dialog[open]");
      await stackPage.locator("#dialog-accept").click();
      await stackPage.waitForFunction(() => !document.querySelector("#dialog").open);
      await idleS();
      await stackPage.locator('#tree button[title="assets/notes.txt"]').click();
      await stackPage.locator("#dialog-title").filter({ hasText: "Asset" }).waitFor();
      await stackPage.locator("#dialog-cancel").click();
      await stackPage.waitForFunction(() => !document.querySelector("#dialog").open);
      await idleS();
      assert.notEqual(await stackPage.locator("#current-path").textContent(), "assets/notes.txt", "a Stack Asset never opens in the Editor");
      await stackPage.locator('#tree button[title="entries/a.md"]').click();
      await idleS();
      assert.equal(await stackPage.locator("#editor .cm-content").getAttribute("aria-label"), "Markdown editor");
      await menuClick(stackPage, "rename");
      await stackPage.locator("#dialog-title").filter({ hasText: "Rename or move Entry" }).waitFor();
      await stackPage.locator("#dialog-content input").fill("entries/a.txt");
      await stackPage.locator("#dialog-accept").click();
      await stackPage.waitForFunction(() => !document.querySelector("#dialog").open);
      await idleS();
      assert.match(await stackPage.locator("#notice").textContent(), /Entry path must end in \.md/);
      await stackPage.locator("#new-entry").click();
      await stackPage.locator("#dialog-title").filter({ hasText: "Create Entry" }).waitFor();
      await stackPage.locator("#dialog-content input").fill("entries/b.txt");
      await stackPage.locator("#dialog-accept").click();
      assert.match(await stackPage.locator("#dialog-error").textContent(), /must end in \.md/);
      await stackPage.locator("#dialog-cancel").click();
      await stackPage.waitForFunction(() => !document.querySelector("#dialog").open);
      await idleS();
      // A managed Entry keeps its frontmatter bytes and CRLF body on save.
      await stackPage.locator("#view").selectOption("edit");
      await stackPage.locator("#editor .cm-content").press("Control+End");
      await stackPage.keyboard.insertText("more\n");
      await stackPage.locator("#editor .cm-content").press("Control+s");
      await idleS();
      const download = stackPage.waitForEvent("download");
      await menuClick(stackPage, "export-tar");
      const tar = new Map(readTarFiles(new Uint8Array(await readFile(await (await download).path()))).files);
      assert.equal(decode(tar.get("entries/a.md")), "---\r\nid: ent-a\r\n---\r\n# A\r\nbody\r\nmore\r\n");
      assert.deepEqual(tar.get("assets/notes.txt"), encode("plain\n"));
      checks.push("Envoy Stack: Assets stay read-only, Entries must stay .md (rename and create), managed Entry keeps frontmatter bytes and CRLF");
    } finally {
      await ctx.close();
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  return { checks, pageErrors: errors, networkRequests: network };
}
