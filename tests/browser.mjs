import { localFileFlows, localTransitionFlows } from "./local-files-browser.mjs";
import { linkedFlows } from "./linked-browser.mjs";
import { codeViewerFlows } from "./code-viewer-browser.mjs";
import { textFileFlows } from "./text-files-browser.mjs";
import { textInspectFlows } from "./text-inspect-browser.mjs";
import { editorText, fillEditor } from "./editor-browser-helpers.mjs";
/** Real file:// acceptance. Usage: npm run test:browser (install Playwright Chromium first).
 * Optional CARBON_BROWSER_PATH points to a locally supplied Chromium executable.
 */
import { chromium } from "playwright";
import { refinements, menuClick } from "./refinements-browser.mjs";
import { editorFlows } from "./editor-browser.mjs";
import { workspaceFlows } from "./workspace-browser.mjs";
import { consolidationFlows } from "./consolidation-browser.mjs";
import { imageFlows } from "./images-browser.mjs";
import { paletteFlows } from "./palette-browser.mjs";
import { dispatchFlows } from "./dispatch-browser.mjs";
import { shellFlows } from "./shell-browser.mjs";
import { vfsFlows } from "./vfs-browser.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sample } from "./helpers.js";
import { writeTar, readTar } from "../src/archives/tar.js";
import { gunzip } from "../src/archives/gzip.js";
import { parseHandoff } from "../src/core/handoff.js";
import { equal } from "../src/core/validate.js";
await mkdir("test-results", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CARBON_BROWSER_PATH || undefined,
  args: process.env.CARBON_BROWSER_PATH
    ? [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--disable-gpu",
      ]
    : [],
});
const context = await browser.newContext({
  acceptDownloads: true,
  offline: true,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [],
  network = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (/^https?:/.test(r.url())) network.push(r.url());
});
page.on("dialog", (d) => d.accept());
const popups = [];
context.on("page", (p) => popups.push(p.url()));
const ready = () =>
  page.waitForFunction(
    () =>
      document.getElementById("notice").textContent !==
      "Opening local workspace…",
  );
const accept = async () => {
  await page.locator("#dialog-accept").click();
  await page.waitForFunction(() => !document.getElementById("dialog").open);
  await page.waitForFunction(() => document.getElementById("workspace").getAttribute("aria-busy") !== "true");
};
const upload = async (name, buffer) =>
  page.locator("#files").setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(buffer),
  });
const download = async (id) => {
  const event = page.waitForEvent("download");
  await menuClick(page, id);
  const d = await event;
  return new Uint8Array(await readFile(await d.path()));
};
try {
  await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
  await ready();
  const capability = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    protocol: location.protocol,
    secureContext: isSecureContext,
    directoryPicker: typeof showDirectoryPicker === "function",
    directoryUpload: "webkitdirectory" in document.getElementById("folders"),
    gzip: typeof CompressionStream === "function",
    gunzip: typeof DecompressionStream === "function",
    draftCache: document.getElementById("persistence").textContent,
  }));
  const original = sample();
  await upload("demo.stack.tar", writeTar(original));
  await accept();
  await page.locator('#tree button[title="entries/nested/note.md"]').click();
  assert.match(await editorText(page), /# Original/);
  const edited =
    (await editorText(page)).replace(
      "# Original",
      "# Browser edited",
    ) +
    '\n```javascript\nconst answer = 42;\n```\n\n<script>window.pwned=1</script>\n<img src="https://invalid.example/tracker" onerror="window.pwned=2">\n[bad](javascript:alert(1))\n![remote](https://invalid.example/pixel)\n\n[Example](https://invalid.example/page)\n<https://invalid.example/auto>\n';
  await fillEditor(page, edited);
  await page.waitForFunction(() =>
    document.querySelector("#preview .hljs-keyword"),
  );
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(
    await page
      .locator("#preview script,#preview img,#preview iframe,#preview svg")
      .count(),
    0,
  );
  assert.equal(
    await page.locator('#preview a[href^="javascript:"]').count(),
    0,
  );
  // CB-1: external links are inert buttons; no http/mailto href exists in the preview DOM.
  await page.waitForFunction(() =>
    document.querySelector("#preview .external-link"),
  );
  assert.equal(await page.locator('#preview a[href^="http"]').count(), 0);
  assert.equal(await page.locator("#preview a[href]:not([href='#'])").count(), 0);
  assert.ok((await page.locator("#preview .external-link").count()) >= 2);
  const external = page.locator("#preview .external-link[data-href]").first();
  assert.equal(await external.getAttribute("href"), null);
  assert.equal(
    await external.getAttribute("data-href"),
    "https://invalid.example/page",
  );
  const pageUrl = page.url();
  await external.click({ button: "middle" });
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#dialog").isVisible(), false);
  await external.click({ modifiers: ["Control"] });
  await page.waitForFunction(() => document.getElementById("dialog").open);
  assert.match(
    await page.locator("#dialog-content pre").textContent(),
    /^https:\/\/invalid\.example\/page$/,
  );
  await page.locator("#dialog-cancel").click();
  await page.waitForFunction(() => !document.getElementById("dialog").open);
  await external.press("Enter");
  await page.waitForFunction(() => document.getElementById("dialog").open);
  assert.match(
    await page.locator("#dialog-title").textContent(),
    /Link destination/,
  );
  await page.locator("#dialog-cancel").click();
  await page.waitForFunction(() => !document.getElementById("dialog").open);
  await page.waitForFunction(() => document.getElementById("workspace").getAttribute("aria-busy") !== "true");
  assert.equal(page.url(), pageUrl);
  assert.equal(context.pages().length, 1);
  assert.deepEqual(popups, []);
  assert.deepEqual(network, []);
  await menuClick(page, "export-tar");
  await page.waitForFunction(() =>
    document.getElementById("notice").textContent.includes("Save or discard"),
  );
  await page.locator("#save-entry").click();
  await page.waitForFunction(() =>
    document.getElementById("stack-meta").textContent.includes("revision 4"),
  );
  await page.locator("#search").fill("Browser edited");
  assert.equal(await page.locator("#tree button[title]").count(), 1);
  await page.locator("#search").fill("");
  await menuClick(page, "rename");
  await page.locator("#dialog input").fill("entries/moved/note.md");
  await accept();
  assert.equal(
    await page.locator("#current-path").textContent(),
    "entries/moved/note.md",
  );
  assert.ok(
    (await page.locator("#links").textContent()).includes("entries/other.md"),
  );
  await page
    .locator(
      '#tree input[aria-label="Include entries/moved/note.md in Needlecast"]',
    )
    .check();
  await menuClick(page, "export-handoff");
  const handoffEvent = page.waitForEvent("download");
  await accept();
  const handoffDownload = await handoffEvent;
  const handoff = await readFile(await handoffDownload.path(), "utf8");
  const parsed = parseHandoff(handoff);
  assert.ok(parsed.meta.omitted_files.includes("assets/bytes.bin"));
  assert.equal(parsed.meta.included_files.length, 2);
  await upload(
    "returned.handoff.md",
    Buffer.from(handoff.replace("# Browser edited", "# AI proposed")),
  );
  await page.waitForSelector(".diff .added");
  await page.locator("#dialog-cancel").click();
  assert.match(await editorText(page), /# Browser edited/);
  await upload(
    "returned.handoff.md",
    Buffer.from(handoff.replace("# Browser edited", "# AI proposed")),
  );
  await page.waitForSelector(".diff .removed");
  await accept();
  await page.waitForFunction(() =>
    document.getElementById("stack-meta").textContent.includes("revision 6"),
  );
  assert.match(await editorText(page), /# AI proposed/);
  const exported = readTar(await gunzip(await download("export-gzip")));
  assert.equal(exported.manifest.revision, 6);
  assert.deepEqual(
    exported.files.get("assets/bytes.bin"),
    original.files.get("assets/bytes.bin"),
  );
  assert.equal(
    exported.text("entries/moved/note.md"),
    edited.replace("# Browser edited", "# AI proposed"),
  );
  assert.equal(exported.manifest.entrypoint, "entries/moved/note.md");
  await upload(
    "stale.handoff.md",
    Buffer.from(handoff.replace("# Browser edited", "# Stale")),
  );
  await page.waitForFunction(
    () => document.getElementById("notice").className === "error",
  );
  assert.equal(await page.locator("#dialog").isVisible(), false);
  // History persists the pre-Return revision and can export and restore it.
  await menuClick(page, "history");
  const first = page.locator("#dialog-content p").nth(1);
  const priorEvent = page.waitForEvent("download");
  await first.getByRole("button", { name: "Download TAR" }).click();
  const prior = readTar(
    new Uint8Array(await readFile(await (await priorEvent).path())),
  );
  assert.match(prior.text("entries/moved/note.md"), /# Browser edited/);
  assert.equal(prior.manifest.revision, 5);
  await first.getByRole("button", { name: "Restore", exact: true }).click();
  await page.waitForFunction(() =>
    document.getElementById("stack-meta").textContent.includes("revision 7"),
  );
  assert.match(await editorText(page), /# Browser edited/);
  // Plain Markdown import, template creation, delete and explicit folder creation.
  await upload("ordinary.md", Buffer.from("# Ordinary\nNo frontmatter"));
  await accept();
  await page.locator('#tree button[title="entries/ordinary.md"]').click();
  assert.equal(
    await editorText(page),
    "# Ordinary\nNo frontmatter",
  );
  await page.locator("#new-entry").click();
  await page.locator("#dialog input").fill("entries/new/meeting.md");
  await page.locator("#dialog select").selectOption("meeting");
  await accept();
  assert.match(await editorText(page), /kind: meeting/);
  await menuClick(page, "delete");
  await accept();
  assert.equal(
    await page.locator('#tree button[title="entries/new/meeting.md"]').count(),
    0,
  );
  await page.locator("#new-folder").click();
  await page.locator("#dialog input").fill("empty-two");
  await accept();
  // Reload retains a draft, then recover the complete exported Stack in a separate context.
  await page.locator('#tree button[title="entries/ordinary.md"]').click();
  await fillEditor(page, "# Unsaved recovered draft");
  await page.waitForTimeout(500);
  await page.reload();
  await ready();
  assert.equal(
    await editorText(page),
    "# Unsaved recovered draft",
  );
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await accept();
  await page.screenshot({ path: "test-results/carbon.png", fullPage: true });
  const restoredContext = await browser.newContext({
    offline: true,
    acceptDownloads: true,
  });
  const restoredPage = await restoredContext.newPage();
  await restoredPage.goto(pathToFileURL(resolve("dist/carbon.html")).href);
  await restoredPage.waitForFunction(
    () =>
      document.getElementById("notice").textContent !==
      "Opening local workspace…",
  );
  await restoredPage.locator("#files").setInputFiles({
    name: "restored.stack.tar",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(writeTar(exported)),
  });
  await restoredPage.locator("#dialog-accept").click();
  await restoredPage.waitForFunction(() =>
    document.getElementById("stack-meta").textContent.includes("revision 6"),
  );
  await restoredPage
    .locator('#tree button[title="entries/moved/note.md"]')
    .click();
  assert.match(
    await editorText(restoredPage),
    /# AI proposed/,
  );
  await restoredContext.close();
  // Exercise policy-denied APIs: only the import/download fallback is available.
  const fallbackContext = await browser.newContext({
    offline: true,
    acceptDownloads: true,
  });
  await fallbackContext.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", { value: undefined });
    Object.defineProperty(window, "CompressionStream", { value: undefined });
    Object.defineProperty(window, "DecompressionStream", { value: undefined });
    window.showDirectoryPicker = async () => {
      throw new DOMException("Folder policy denied", "NotAllowedError");
    };
  });
  const fallback = await fallbackContext.newPage();
  await fallback.goto(pathToFileURL(resolve("dist/carbon.html")).href);
  await fallback.waitForFunction(() =>
    document.getElementById("persistence").textContent.includes("unavailable"),
  );
  await menuClick(fallback, "open-folder");
  await fallback.waitForFunction(() =>
    document
      .getElementById("notice")
      .textContent.includes("Folder policy denied"),
  );
  await fallback
    .locator("#folders")
    .setInputFiles(resolve("examples/supplier-lead-times.stack"));
  await fallback.locator("#dialog-accept").click();
  await fallback.waitForFunction(
    () =>
      document.getElementById("stack-title").textContent ===
      "Supplier lead-time investigation",
  );
  await menuClick(fallback, "export-gzip");
  await fallback.waitForFunction(() =>
    document
      .getElementById("notice")
      .textContent.includes("Gzip streams unavailable"),
  );
  const fallbackDownload = fallback.waitForEvent("download");
  await menuClick(fallback, "export-tar");
  const fallbackTar = readTar(
    new Uint8Array(await readFile(await (await fallbackDownload).path())),
  );
  assert.equal(fallbackTar.files.get("assets/example-marker.bin").length, 256);
  await fallbackContext.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  const localFilesReport = await localFileFlows(browser);
  const localTransitionReport = await localTransitionFlows(browser);
  const linkedReport = await linkedFlows(browser);
  const codeViewerReport = await codeViewerFlows(browser);
  const textFilesReport = await textFileFlows(browser);
  const textInspectReport = await textInspectFlows(browser);
  const refinementReport = await refinements(browser);
  const dispatchReport = await dispatchFlows(browser);
  const editorReport = await editorFlows(browser);
  const paletteReport = await paletteFlows(browser);
  const workspaceReport = await workspaceFlows(browser);
  const imageReport = await imageFlows(browser);
  const consolidationReport = await consolidationFlows(browser);
  const shellReport = await shellFlows(browser);
  const vfsReport = await vfsFlows(browser);
  const report = {
    vfs: vfsReport,
    shell: shellReport,
    localFiles: localFilesReport,
    localTransitions: localTransitionReport,
    linkedFolders: linkedReport,
    codeViewer: codeViewerReport,
    textFiles: textFilesReport,
    textInspect: textInspectReport,
    consolidation: consolidationReport,
    workspace: workspaceReport,
    images: imageReport,
    palette: paletteReport,
    editor: editorReport,
    refinements: refinementReport,
    dispatchFlows: dispatchReport,
    browser: await browser.version(),
    capability,
    tests: [
      "file:// offline boot",
      "TAR import confirmation",
      "Markdown live preview and highlighting",
      "hostile preview sanitization",
      "inert external preview links (CB-1): no http href, middle/Ctrl-click and Enter open no window",
      "unsaved export refusal",
      "nested rename and stable-ID backlink",
      "search",
      "partial Needlecast export",
      "Return diff/reject/accept",
      "omitted binary preservation",
      "stale Return rejection",
      "history download and restore",
      "ordinary Markdown import",
      "template create/delete",
      "folder creation",
      "draft reload recovery",
      "TAR.GZ download",
      "fresh-context Stack restore",
      "toolbar menus (Import ▾ / Export Stack ▾) drive the existing routes",
    ],
    fallbackTests: [
      "directory upload and TAR download with denied native picker",
      "unavailable IndexedDB warning",
      "unavailable gzip warning and TAR fallback",
    ],
    networkRequests: network,
    popups,
    pageErrors: errors,
  };
  await writeFile(
    "test-results/browser.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
  await browser.close();
}
