/**
 * A2.1 acceptance (#29): Text details reports the committed bytes, BOM and line endings apart from
 * the unsaved draft; Show invisibles marks spaces, tabs, unusual spaces, trailing whitespace and
 * line ends (labelled with the committed file's convention) without touching bytes, revisions or
 * drafts; Inspect characters lists code points (surrogate pairs as one) with targeted warnings;
 * everything is reachable from the Document menu, the palette and a phone-sized viewport.
 * Real file:// page, offline.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readTarFiles } from "../src/archives/tar.js";
import { encode } from "../src/core/validate.js";
import { editorText, editorView } from "./editor-browser-helpers.mjs";
import { menuClick } from "./refinements-browser.mjs";

const BOM = "\uFEFF";
// "hi" hidden in Unicode tag characters between a LANGUAGE TAG and a CANCEL TAG (review P2).
const TAGGED = "\u{E0001}\u{E0068}\u{E0069}\u{E007F}";

export async function textInspectFlows(browser) {
  const errors = [], network = [], checks = [];
  const inspectBytes = encode(`${BOM}a\u00A0b\u200Bc\r\n\tx \r\n😀\u202Eabc\r\n`);
  const files = new Map([
    ["inspect.txt", inspectBytes],
    ["plain.md", encode("# P\n\nlf only\n")],
    ["mixed.txt", encode("a\r\nb\nc\r\n")],
    ["cr.txt", encode("one\rtwo\r")],
    ["none.txt", encode("abc")],
    ["tags.txt", encode(`ok${TAGGED}\nx\u200Dy\u202Az\u2068w\n`)],
  ]);
  const fixture = resolve("test-results/text-inspect-folder");
  await rm(fixture, { recursive: true, force: true });
  for (const [p, bytes] of files) {
    await mkdir(dirname(resolve(fixture, p)), { recursive: true });
    await writeFile(resolve(fixture, p), bytes);
  }
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (/^https?:/.test(r.url())) network.push(r.url()); });
  const idle = () => page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") !== "true");
  const closeDialog = async () => {
    await page.locator("#dialog-cancel").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    await idle();
  };
  const title = (text) => page.locator("#dialog-title").filter({ hasText: text }).waitFor();
  const dialog = () => page.locator("#dialog-content").textContent();
  const open = async (p) => { await page.locator(`#tree button[title="${p}"]`).click(); await idle(); };
  const revision = async () => Number(/revision (\d+)/.exec(await page.locator("#stack-meta").textContent())[1]);
  const setInvisibles = async (on) => {
    await page.locator("#menu-doc summary").click();
    await page.locator("#show-invisibles").setChecked(on);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("menu-doc").open);
  };
  const count = (selector) => page.locator(`#editor ${selector}`).count();
  const eols = () => page.locator("#editor .cm-eol").evaluateAll((nodes) => nodes.map((n) => n.textContent));
  const committed = async () => {
    const download = page.waitForEvent("download");
    await menuClick(page, "export-tar");
    const d = await download;
    await idle();
    return new Map(readTarFiles(new Uint8Array(await readFile(await d.path()))).files);
  };
  try {
    await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
    await page.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
    await idle();
    await page.locator("#folders").setInputFiles(fixture);
    await title("Open local folder copy?");
    await page.locator("#dialog-accept").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    await idle();
    assert.equal(await page.locator("#text-details").isDisabled(), false);
    assert.equal(await page.locator("#inspect-chars").isDisabled(), false);

    // ---- Text details: committed bytes, BOM, CRLF, no draft, invisible-character counts ----
    await open("inspect.txt");
    assert.equal(await editorText(page), "a\u00A0b\u200Bc\n\tx \n😀\u202Eabc\n", "the Editor shows LF text without the BOM");
    const before = await revision();
    await menuClick(page, "text-details");
    await title("Text details");
    let text = await dialog();
    assert.match(text, new RegExp(`inspect\\.txt · ${inspectBytes.length} committed bytes \\(editing limit 1 MiB\\)`));
    assert.match(text, /Local copy in this browser, not on disk/);
    assert.match(text, /Present \(UTF-8 BOM, 3 bytes\)\. The Editor hides it; Save keeps it\./);
    assert.match(text, /CRLF throughout \(3 line breaks\); Save keeps it\./);
    assert.match(text, /None: the Editor shows the committed text\./);
    assert.match(text, /tabs: 1 · unusual spaces: 1 · zero-width: 1 · bidirectional controls: 1 · other controls: 0 · line\/paragraph separators: 0 · noncharacters: 0 · tag characters: 0 · other invisible: 0 · lone surrogates: 0 · lines ending in whitespace: 1/);
    assert.match(text, /invisible or change text direction/);
    assert.equal(await page.locator("#dialog-accept").isHidden(), true, "read-only: Close only");
    await closeDialog();
    assert.equal(await revision(), before);
    checks.push("Text details: committed byte count, BOM present, CRLF with line-break count, no draft, counts of tab / NBSP / zero-width / bidi / trailing whitespace with a targeted warning");

    // ---- Show invisibles: display-only markers, line ends labelled CRLF; bytes, revision and draft unchanged ----
    await setInvisibles(true);
    assert.match(await page.locator("#notice").textContent(), /Showing spaces \(·\), tabs \(→\), unusual spaces \(⍽\), trailing whitespace and line ends \(␍␊: the committed file's convention\)\. Markers are display only/);
    assert.equal(await count(".cm-highlightTab"), 1);
    assert.equal(await count(".cm-highlightSpace"), 1);
    assert.equal(await count(".cm-oddSpace"), 1, "the NBSP is marked");
    assert.equal(await page.locator("#editor .cm-oddSpace").getAttribute("title"), "Unusual space U+00A0");
    assert.equal(await count(".cm-trailingSpace"), 1);
    assert.ok((await count(".cm-specialChar")) >= 2, "zero-width and bidi controls keep their placeholders");
    assert.deepEqual(await eols(), ["␍␊", "␍␊", "␍␊"], "one line-end marker per line break, as the committed file writes it");
    assert.match(await page.locator("#editor .cm-eol").first().getAttribute("title"), /this file uses CRLF; the Editor works in LF/);
    assert.equal(await editorText(page), "a\u00A0b\u200Bc\n\tx \n😀\u202Eabc\n", "the document is unchanged");
    assert.equal(await page.locator("#save-entry").isDisabled(), true, "no draft was created");
    assert.equal(await revision(), before);
    // Markers are not document text: copying the whole document yields the exact text.
    await page.locator("#editor .cm-content").press("Control+a");
    await page.locator("#editor .cm-content").press("Control+c");
    await page.locator("#editor .cm-content").press("End");
    await page.locator("#search").focus();
    await page.locator("#search").press("Control+v");
    const pasted = await page.locator("#search").inputValue();
    assert.doesNotMatch(pasted, /[·→⍽␍␊¶]/, "pasted text carries no markers");
    assert.equal(pasted.replace(/\s/g, ""), "ab\u200Bcx😀\u202Eabc", "pasted text is the document's own characters (an input folds line breaks)");
    await page.locator("#search").fill("");
    const exported = await committed();
    for (const [p, bytes] of files) assert.deepEqual(exported.get(p), bytes, `${p} exported byte for byte with markers shown`);
    assert.equal(await revision(), before);
    checks.push("Show invisibles marks spaces, tabs, NBSP, trailing whitespace and CRLF line ends; document, draft, revision, copy and exact export are unchanged");

    // ---- a draft is reported apart from the committed bytes; undo clears it with markers on ----
    await page.locator("#view").selectOption("edit");
    await page.locator("#editor .cm-content").press("Control+End");
    await page.keyboard.insertText("z");
    await page.waitForFunction(() => document.querySelector("#save-entry").disabled === false);
    await menuClick(page, "text-details");
    await title("Text details");
    text = await dialog();
    assert.match(text, new RegExp(`${inspectBytes.length} committed bytes`), "committed bytes are unchanged by the draft");
    assert.match(text, new RegExp(`Yes, unsaved: it would save as ${inspectBytes.length + 1} bytes with the same BOM and line endings\\. The committed bytes above are unchanged until Save\\.`));
    await closeDialog();
    assert.deepEqual(await eols(), ["␍␊", "␍␊", "␍␊"], "the last line has no line break yet");
    await page.locator("#editor .cm-content").press("Control+z");
    await page.waitForFunction(() => document.querySelector("#save-entry").disabled === true);
    assert.equal(await editorText(page), "a\u00A0b\u200Bc\n\tx \n😀\u202Eabc\n");
    checks.push("Text details reports an unsaved draft and its would-be size apart from the committed bytes; undo with markers on leaves no draft");

    // ---- Inspect characters: selection and caret, by code point, with targeted warnings ----
    await editorView(page);
    await page.evaluate(() => carbonTestSelect([[3, 4]]));
    await menuClick(page, "inspect-chars");
    await title("Inspect characters");
    text = await dialog();
    assert.match(text, /Selection from line 1, column 4: 1 code point in 1 UTF-16 unit\./);
    assert.match(text, /U\+200B\s*ZERO WIDTH SPACE\s*⚠ zero width: invisible/);
    await closeDialog();
    await page.evaluate(() => carbonTestSelect([[10, 13]]));
    await menuClick(page, "inspect-chars");
    await title("Inspect characters");
    text = await dialog();
    assert.match(text, /Selection from line 3, column 1: 2 code points in 3 UTF-16 units\./);
    assert.match(text, /U\+1F600\s*😀\s*\(no name data bundled\)/, "an emoji is one code point and gets no invented name");
    assert.match(text, /U\+202E\s*RIGHT-TO-LEFT OVERRIDE\s*⚠ bidirectional control/);
    await closeDialog();
    await page.evaluate(() => carbonTestSelect([[1]]));
    await menuClick(page, "inspect-chars");
    await title("Inspect characters");
    text = await dialog();
    assert.match(text, /At the cursor \(line 1, column 2\): the next character\./);
    assert.match(text, /U\+00A0\s*\u00A0\s*NO-BREAK SPACE\s*unusual space/);
    await closeDialog();
    assert.equal(await page.locator("#save-entry").isDisabled(), true);
    assert.equal(await revision(), before);
    checks.push("Inspect characters: ZWSP and RLO carry warnings, an emoji is one code point without an invented name, the caret inspects the next character");

    // ---- tag characters and the invisibles CodeMirror leaves unshown: counted, warned, marked (review P2) ----
    await open("tags.txt");
    const tagsText = `ok${TAGGED}\nx\u200Dy\u202Az\u2068w\n`;
    assert.equal(await editorText(page), tagsText);
    const tagsRev = await revision();
    await menuClick(page, "text-details");
    await title("Text details");
    text = await dialog();
    assert.match(text, /zero-width: 1 · bidirectional controls: 2 · .* · tag characters: 4 · other invisible: 0/);
    assert.match(text, /invisible or change text direction/, "a hidden tag payload triggers the warning");
    await closeDialog();
    await page.evaluate(() => carbonTestSelect([[2, 10]]));
    await menuClick(page, "inspect-chars");
    await title("Inspect characters");
    text = await dialog();
    assert.match(text, /4 code points in 8 UTF-16 units/);
    assert.match(text, /U\+E0001\s*LANGUAGE TAG\s*⚠ tag character: invisible; can hide ASCII text/);
    assert.match(text, /U\+E0068\s*\(no name data bundled\)\s*⚠ tag character: invisible; can hide ASCII text \(stands for "h"\)/);
    assert.match(text, /U\+E0069[^]*\(stands for "i"\)/);
    assert.match(text, /U\+E007F\s*CANCEL TAG\s*⚠ tag/);
    const cells = await page.locator("#dialog-content table.code-points td:nth-child(2)").evaluateAll((n) => n.map((x) => x.textContent));
    assert.deepEqual(cells, ["", "", "", ""], "invisible characters are not copied into the dialog");
    await closeDialog();
    const specials = () => page.locator("#editor .cm-specialChar").evaluateAll((n) => n.map((x) => x.title));
    // Markers are on from above: every tag character, the ZWJ, LRE and FSI get a placeholder.
    assert.deepEqual((await specials()).sort(), ["Control character 0x202a", "Control character 0x2068", "Control character 0xe0001",
      "Control character 0xe0068", "Control character 0xe0069", "Control character 0xe007f", "Control character zero width joiner"]);
    assert.equal(await editorText(page), tagsText, "placeholders are display only");
    assert.equal(await page.locator("#save-entry").isDisabled(), true);
    await setInvisibles(false);
    assert.deepEqual(await specials(), [], "with the option off CodeMirror's own placeholders apply (none of these)");
    await setInvisibles(true);
    assert.equal((await specials()).length, 7);
    const tagExport = await committed();
    for (const [p, bytes] of files) assert.deepEqual(tagExport.get(p), bytes, `${p} exported byte for byte with placeholders shown`);
    assert.equal(await revision(), tagsRev);
    checks.push("tag characters (hidden ASCII), ZWJ, LRE and FSI: counted with a warning in Text details, ⚠ with the hidden ASCII in Inspect characters, placeholders with Show invisibles; document, revision and exact export unchanged");

    // ---- toggling keeps the cursor, the selection, undo and each file's cached session ----
    const selection = () => page.evaluate(() => { const { anchor, head } = carbonTestView().state.selection.main; return [anchor, head]; });
    await open("plain.md");
    await page.locator("#editor .cm-content").press("Control+End");
    await page.keyboard.insertText("q");
    await page.waitForFunction(() => document.querySelector("#save-entry").disabled === false);
    await page.evaluate(() => carbonTestSelect([[2, 5]]));
    await setInvisibles(false);
    assert.deepEqual(await selection(), [2, 5], "turning markers off keeps the selection");
    await setInvisibles(true);
    assert.deepEqual(await selection(), [2, 5], "turning markers on keeps the selection");
    await open("inspect.txt");
    await setInvisibles(false);
    await setInvisibles(true);
    await open("plain.md");
    assert.deepEqual(await selection(), [2, 5], "the cached session of another file survives toggling");
    assert.equal(await editorText(page), "# P\n\nlf only\nq");
    await page.locator("#editor .cm-content").press("Control+z");
    await page.waitForFunction(() => document.querySelector("#save-entry").disabled === true);
    assert.equal(await editorText(page), "# P\n\nlf only\n", "undo history survives toggling and switching files");
    checks.push("toggling Show invisibles keeps the cursor/selection, the undo history and another file's cached session");

    // ---- same glyph, new meaning: a file without line breaks gains one and is saved as LF ----
    await open("none.txt");
    assert.deepEqual(await eols(), []);
    await page.locator("#editor .cm-content").press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("d");
    await page.waitForFunction(() => document.querySelectorAll("#editor .cm-eol").length === 1);
    assert.equal(await page.locator("#editor .cm-eol").getAttribute("title"), "Line break (new; the file had none, LF will be used)");
    await page.locator("#save-entry").click();
    await page.waitForFunction(() => document.querySelector("#save-entry").disabled === true);
    await idle();
    assert.equal(await page.locator("#editor .cm-eol").getAttribute("title"), "Line break (this file uses LF)", "the marker is redrawn when only its title changes");
    checks.push("a saved first line break turns the ␊ marker's title from \"the file had none\" to \"this file uses LF\"");

    // ---- the line-end marker follows each file's committed convention; off means no markers ----
    await open("plain.md");
    assert.deepEqual(await eols(), ["␊", "␊", "␊"]);
    await open("mixed.txt");
    assert.deepEqual(await eols(), ["¶", "¶", "¶"], "a mixed file never claims a per-line convention");
    assert.match(await page.locator("#editor .cm-eol").first().getAttribute("title"), /committed file mixes line endings/);
    await open("cr.txt");
    assert.deepEqual(await eols(), ["␍", "␍"]);
    await setInvisibles(false);
    assert.equal(await count(".cm-eol"), 0);
    assert.equal(await count(".cm-highlightSpace, .cm-highlightTab, .cm-oddSpace, .cm-trailingSpace"), 0);
    await open("inspect.txt");
    assert.equal(await count(".cm-eol"), 0, "the setting stays off across files");
    checks.push("line-end markers read ␊ / ¶ / ␍ for LF, mixed and lone-CR files; turning the option off removes every marker");

    // ---- the palette lists both actions ----
    await page.locator("#palette-launcher").click();
    await page.locator("#palette-query").fill("inspect");
    const commands = page.locator('#palette-results section[aria-label="Commands"] button');
    await commands.first().waitFor();
    const labels = await commands.evaluateAll((b) => b.map((x) => x.textContent));
    assert.ok(labels.some((l) => l.includes("Text details…")), labels.join(" | "));
    assert.ok(labels.some((l) => l.includes("Inspect characters…")), labels.join(" | "));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("command-palette").open);
    checks.push("the palette offers Text details and Inspect characters");
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
  } finally {
    await context.close();
  }

  // ---- phone-sized viewport, Scratch: the dialogs open and close without trapping focus ----
  {
    const ctx = await browser.newContext({ offline: true, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const phone = await ctx.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    phone.on("request", (r) => { if (/^https?:/.test(r.url())) network.push(r.url()); });
    const idleP = () => phone.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") !== "true");
    try {
      await phone.goto(pathToFileURL(resolve("dist/carbon.html")).href);
      await phone.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
      await idleP();
      assert.equal(await phone.locator("#stack-title").textContent(), "Scratch");
      await phone.locator("#menu-doc summary").tap();
      await phone.locator("#text-details").tap();
      await phone.locator("#dialog-title").filter({ hasText: "Text details" }).waitFor();
      const text = await phone.locator("#dialog-content").textContent();
      assert.match(text, /Scratch: saved in this browser only, not on disk\./);
      assert.match(text, /0 committed bytes/);
      assert.match(text, /No line breaks\. Lines you add will use LF\./);
      await phone.locator("#dialog-cancel").tap();
      await phone.waitForFunction(() => !document.querySelector("#dialog").open);
      await idleP();
      await phone.locator("#menu-doc summary").tap();
      await phone.locator("#show-invisibles").tap();
      await phone.waitForFunction(() => document.getElementById("show-invisibles").checked);
      await phone.locator("#menu-doc summary").tap();
      await phone.waitForFunction(() => !document.getElementById("menu-doc").open);
      await phone.locator("#editor .cm-content").tap();
      await phone.keyboard.insertText("a b\n");
      await phone.waitForFunction(() => document.querySelectorAll("#editor .cm-eol").length === 1);
      assert.equal(await phone.locator("#editor .cm-highlightSpace").count(), 1);
      assert.equal(await editorText(phone), "a b\n");
      assert.equal(await phone.locator("#dialog").isVisible(), false);
      checks.push("phone viewport: Text details opens and closes from the Document menu, Show invisibles toggles by touch, typing continues");
    } finally {
      await ctx.close();
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  return { checks, pageErrors: errors, networkRequests: network };
}
