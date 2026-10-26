import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { sample } from "./helpers.js";
import { newStack } from "../src/core/stack.js";
import { encode } from "../src/core/validate.js";
import { writeTar, readTar } from "../src/archives/tar.js";
import { editorText } from "./editor-browser-helpers.mjs";
import { menuClick } from "./refinements-browser.mjs";

export async function consolidationFlows(browser) {
  const context = await browser.newContext({ offline:true, acceptDownloads:true });
  const page = await context.newPage(), errors = [], network = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (/^https?:/.test(r.url())) network.push(r.url()); });
  page.on("dialog", d => d.accept());
  const idle = () => page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") !== "true");
  const ready = () => page.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
  const upload = async stack => {
    await page.locator("#files").setInputFiles({name:"test.tar",mimeType:"application/octet-stream",buffer:Buffer.from(writeTar(stack))});
    await page.locator("#dialog-accept").click(); await idle();
  };
  const pick = async buffer => {
    const event=page.waitForEvent("filechooser");
    await menuClick(page, "insert-image");
    await (await event).setFiles({name:"screen.png",mimeType:"image/png",buffer});
    await idle();
  };
  const images = () => page.locator('#tree button[title]').evaluateAll(nodes => nodes.map(n=>n.title).filter(p=>/image-.*\.png$/.test(p)));
  try {
    await page.goto(pathToFileURL(resolve("dist/carbon.html")).href); await ready();
    await upload(sample());
    const path="entries/other.md";
    await page.locator(`#tree button[title="${path}"]`).click(); await idle();
    await page.getByRole("button",{name:`Open ${path} in Viewer`,exact:true}).click(); await idle();
    await page.locator("#swap-panes").click(); await idle();
    const different = newStack().change({writes:new Map([[path,encode("# Different Stack document")]])});
    await upload(different);
    assert.equal(await page.locator('#editor-tabs [role="tab"]').count(),0);
    assert.equal(await page.locator('#viewer-tabs [role="tab"]').count(),0);
    assert.equal(await page.locator("#documents").evaluate(el=>el.classList.contains("viewer-first")),true);
    await page.reload(); await ready();
    assert.equal(await page.locator('#editor-tabs [role="tab"]').count(),0);
    await page.locator(`#tree button[title="${path}"]`).click(); await idle();
    const original = await editorText(page), png = await readFile("tests/fixtures/images/grid.png");
    const corrupt=Buffer.from(png); corrupt[29]^=1; // IHDR CRC only: dimensions/data remain intact.
    await pick(corrupt);
    assert.match(await page.locator("#notice").textContent(),/PNG chunk CRC/);
    assert.equal(await editorText(page),original); assert.deepEqual(await images(),[]);
    await page.waitForTimeout(650);
    await page.evaluate(() => { IDBObjectStore.prototype.put = function(){ throw Error("Persistent quota fixture"); }; });
    await pick(png);
    assert.match(await page.locator("#notice").textContent(),/Image insertion was not saved/);
    assert.match(await page.locator("#persistence").textContent(),/storage unavailable.*export before closing/);
    assert.equal(await editorText(page),original); assert.deepEqual(await images(),[]);
    await pick(png); // Same failing writer remains installed: retry is an explicit in-memory transaction.
    assert.equal((await images()).length,1);
    assert.match(await page.locator("#notice").textContent(),/No recovery cache/);
    await page.locator("#save-entry").click(); await idle();
    const event=page.waitForEvent("download"); await menuClick(page,"export-tar");
    const download=await event, exported=readTar(new Uint8Array(await readFile(await download.path())));
    const asset=(await images())[0];
    assert.deepEqual(exported.files.get(asset),new Uint8Array(png));
    assert.ok(exported.text(path).includes(asset));
    await page.reload(); await ready();
    assert.deepEqual(await images(),[],"in-memory retry never claims durable browser recovery");
    assert.deepEqual(errors,[]); assert.deepEqual(network,[]);
    return {
      tests: ["cross-Stack tab reset and reload", "PNG CRC refusal", "atomic cache failure with explicit in-memory retry and original-byte export"],
      networkRequests: network, pageErrors: errors,
    };
  } finally {await context.close();}
}
