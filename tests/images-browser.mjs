import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sample } from "./helpers.js";
import { encode } from "../src/core/validate.js";
import { writeTar, readTar } from "../src/archives/tar.js";
import { gunzip } from "../src/archives/gzip.js";
import {
  editorView,
  editorText,
  fillEditor,
} from "./editor-browser-helpers.mjs";
import { menuClick } from "./refinements-browser.mjs";

export async function imageFlows(browser) {
  const errors = [],
    network = [],
    checks = [];
  const check = (message) => {
    checks.push(message);
    console.log(message);
  };
  const context = await browser.newContext({
    offline: true,
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) network.push(r.url());
  });
  page.on("dialog", (d) => d.accept());
  const idle = () =>
    page.waitForFunction(
      () =>
        document.querySelector("#workspace").getAttribute("aria-busy") !==
        "true",
    );
  const content = page.locator("#editor .cm-content");
  const fixture = async (ext) => ({
    name: `grid.${ext}`,
    mimeType: `image/${ext === "jpg" ? "jpeg" : ext}`,
    buffer: await readFile(`tests/fixtures/images/grid.${ext}`),
  });
  const pick = async (files) => {
    const pending = page.waitForEvent("filechooser");
    await menuClick(page, "insert-image");
    await (await pending).setFiles(files);
    await idle();
  };
  const paths = () =>
    page
      .locator("#tree button[title]")
      .evaluateAll((bs) =>
        bs
          .map((b) => b.title)
          .filter((p) => /image-.*\.(png|jpg|webp)$/.test(p)),
      );
  const paste = async (file, type = "paste", point = null) =>
    page.evaluate(
      ({ bytes, name, mimeType, type, point }) => {
        const data = new DataTransfer();
        data.items.add(
          new File([new Uint8Array(bytes)], name, { type: mimeType }),
        );
        const e =
          type === "paste"
            ? new ClipboardEvent("paste", {
                clipboardData: data,
                bubbles: true,
                cancelable: true,
              })
            : new DragEvent("drop", {
                dataTransfer: data,
                bubbles: true,
                cancelable: true,
                clientX: point.x,
                clientY: point.y,
              });
        document.querySelector("#editor .cm-content").dispatchEvent(e);
      },
      {
        bytes: [...file.buffer],
        name: file.name,
        mimeType: file.mimeType,
        type,
        point,
      },
    );
  const exportStack = async (id) => {
    const pending = page.waitForEvent("download");
    await menuClick(page, id);
    const b = new Uint8Array(await readFile(await (await pending).path()));
    return readTar(id === "export-gzip" ? await gunzip(b) : b);
  };
  try {
    await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
    await page.waitForFunction(
      () =>
        document.querySelector("#notice").textContent !==
        "Opening local workspace…",
    );
    const stack = sample().change({
      writes: new Map([
        [
          "entries/images.md",
          encode(
            "# Image research\n\nInsert here.\n\n![remote](https://invalid.example/x.png)\n![svg](../assets/active.svg)\n",
          ),
        ],
        [
          "assets/active.svg",
          encode(
            '<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=true"/>',
          ),
        ],
      ]),
    });
    await page.locator("#files").setInputFiles({
      name: "images.stack.tar",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(writeTar(stack)),
    });
    await page.locator("#dialog-accept").click();
    await idle();
    await page.locator('#tree button[title="entries/images.md"]').click();
    await idle();
    await page.locator("#view").selectOption("split");
    await editorView(page);
    const before = await editorText(page),
      at = before.indexOf("Insert here.");
    await page.evaluate((at) => carbonTestSelect([[at, at + 12]]), at);
    const png = await fixture("png"),
      jpg = await fixture("jpg"),
      webp = await fixture("webp");
    await pick(png);
    await page.waitForFunction(() =>
      document
        .querySelector("#notice")
        .textContent.includes("1 image inserted"),
    );
    const inserted = await editorText(page),
      first = (await paths())[0];
    assert.ok(first);
    assert.equal(
      inserted,
      before.slice(0, at) + `![Image](../${first})` + before.slice(at + 12),
    );
    await page.waitForFunction(
      () => document.querySelector("#preview img")?.naturalWidth === 32,
    );
    assert.equal(await page.locator("#preview img").count(), 1);
    assert.match(
      await page.locator("#preview img").getAttribute("src"),
      /^blob:/,
    );
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    assert.match(csp, /img-src blob:/);
    assert.match(csp, /connect-src 'none'/);
    assert.doesNotMatch(csp, /img-src[^;]*(?:https|data:|file:)/);
    await page.locator("#preview .local-image").click();
    await page.locator("#image-dialog").waitFor({ state: "visible" });
    await page.locator("#image-actual").click();
    assert.match(await page.locator("#image-scale").textContent(), /100%/);
    await page.locator("#image-in").click();
    assert.match(await page.locator("#image-scale").textContent(), /125%/);
    await page.locator("#image-pan-right").click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#image-dialog").isVisible(), false);
    assert.equal(
      await page.evaluate(() =>
        document.activeElement.classList.contains("local-image"),
      ),
      true,
    );
    await content.press("Control+z");
    assert.equal(await editorText(page), before);
    assert.deepEqual(await paths(), [first]);
    await content.press("Control+Shift+Z");
    assert.equal(await editorText(page), inserted);
    check(
      "Picker replaces selection atomically; validated local raster preview; remote/SVG inert; original-size inspector, zoom, pan, Escape/focus; undo/redo retains asset",
    );

    // Paste at the current cursor, then drop at a different exact text coordinate.
    await page.evaluate(() =>
      carbonTestSelect([[carbonTestView().state.doc.length]]),
    );
    await paste(jpg);
    await idle();
    assert.equal((await paths()).length, 2);
    const afterPaste = await editorText(page);
    const point = await page.evaluate(() => {
      const r = carbonTestView().coordsAtPos(2);
      return { x: r.left, y: (r.top + r.bottom) / 2 };
    });
    await paste(webp, "drop", point);
    await idle();
    const afterDrop = await editorText(page),
      all = await paths();
    assert.equal(all.length, 3);
    const dropped = all.find((p) => p.endsWith("webp"));
    assert.equal(
      afterDrop,
      afterPaste.slice(0, 2) + `![Image](../${dropped})` + afterPaste.slice(2),
    );
    await page
      .getByRole("button", { name: `Open ${dropped} in Viewer`, exact: true })
      .click();
    await idle();
    await page.waitForFunction(
      () => document.querySelector("#viewer-content img")?.naturalWidth === 32,
    );
    assert.equal(
      await page.locator("#current-path").textContent(),
      "entries/images.md",
    );
    assert.equal(await editorText(page), afterDrop);
    check(
      "JPEG paste and WebP drop use insertion positions; independent image Viewer preserves working draft",
    );

    // The original asset modal also offers a working nested image inspector.
    await page.locator(`#tree button[title="${first}"]`).click();
    await page.locator("#dialog-content .local-image").click();
    await page.locator("#image-dialog").waitFor({ state: "visible" });
    await page.locator("#image-close").click();
    await page.locator("#dialog-cancel").click();
    await idle();

    // No partial batch on validation failure or actual persistence failure.
    const revision = await page.locator("#stack-meta").textContent();
    await page.locator("#workspace-editor").click();
    await idle();
    await pick([
      png,
      {
        name: "fake.png",
        mimeType: "image/png",
        buffer: Buffer.from("<svg>unsupported</svg>"),
      },
    ]);
    await page.waitForFunction(
      () => document.querySelector("#notice").className === "error",
    );
    assert.equal(await editorText(page), afterDrop);
    assert.deepEqual(await paths(), all);
    assert.equal(await page.locator("#stack-meta").textContent(), revision);
    const jpeg = await fixture("jpg");
    await pick({ ...jpeg, name:"truncated.jpg", buffer:jpeg.buffer.subarray(0, -2) });
    await page.waitForFunction(() => /JPEG/.test(document.querySelector("#notice").textContent));
    assert.equal(await editorText(page), afterDrop);
    assert.deepEqual(await paths(), all);
    assert.equal(await page.locator("#stack-meta").textContent(), revision);
    // Invalid compressed image data with valid chunk checksums must fail decoding.
    const broken = Buffer.from(png.buffer);
    broken.fill(0, 41, broken.length - 16);
    for (let at=8; at<broken.length;) {
      const size=broken.readUInt32BE(at); let crc=0xffffffff;
      for (const byte of broken.subarray(at+4,at+8+size)) {
        crc^=byte; for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
      }
      broken.writeUInt32BE((crc^0xffffffff)>>>0,at+8+size); at+=size+12;
    }
    await pick({ name: "corrupt.png", mimeType: "image/png", buffer: broken });
    await idle();
    assert.equal(await editorText(page), afterDrop);
    assert.deepEqual(await paths(), all);
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      window.imagePut = put;
      IDBObjectStore.prototype.put = function (...args) {
        throw Error("Injected image persistence failure");
      };
    });
    await pick(png);
    await page.waitForFunction(() =>
      document
        .querySelector("#notice")
        .textContent.includes("Injected image persistence failure"),
    );
    assert.equal(await editorText(page), afterDrop);
    assert.deepEqual(await paths(), all);
    assert.equal(await page.locator("#stack-meta").textContent(), revision);
    await page.evaluate(() => {
      IDBObjectStore.prototype.put = window.imagePut;
    });
    // The native picker may be open while the document changes: reject its stale offset.
    const pending = page.waitForEvent("filechooser");
    await menuClick(page, "insert-image");
    const chooser = await pending;
    await page.evaluate(() =>
      carbonTestView().dispatch({
        changes: { from: 0, insert: "Updated " },
        userEvent: "input.paste",
      }),
    );
    await chooser.setFiles(png);
    await idle();
    await page.waitForFunction(() =>
      document.querySelector("#notice").textContent.includes("Entry changed"),
    );
    assert.deepEqual(await paths(), all);
    assert.equal(await editorText(page), "Updated " + afterDrop);
    check(
      "Invalid batch, corrupt codec, IndexedDB failure and stale picker preserve assets, revision and draft",
    );

    await page.locator("#save-entry").click();
    await idle();
    const saved = await editorText(page);
    for (const id of ["export-tar", "export-gzip"]) {
      const s = await exportStack(id);
      assert.equal(s.text("entries/images.md"), saved);
      for (const p of all) {
        const f = p.endsWith("png") ? png : p.endsWith("jpg") ? jpg : webp;
        assert.deepEqual(s.files.get(p), new Uint8Array(f.buffer));
      }
    }
    // Recover both references and original assets in a fresh offline context.
    const exported = await exportStack("export-tar"),
      other = await browser.newContext({ offline: true });
    const restored = await other.newPage();
    try {
      await restored.goto(page.url());
      await restored.waitForFunction(
        () =>
          document.querySelector("#notice").textContent !==
          "Opening local workspace…",
      );
      await restored.locator("#files").setInputFiles({
        name: "restored.stack.tar",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(writeTar(exported)),
      });
      await restored.locator("#dialog-accept").click();
      await restored.waitForFunction(
        () =>
          document.querySelector("#workspace").getAttribute("aria-busy") !==
          "true",
      );
      await restored.locator('#tree button[title="entries/images.md"]').click();
      await restored.locator("#view").selectOption("preview");
      await restored.waitForFunction(
        () => document.querySelectorAll("#preview img").length === 3,
      );
      await restored.locator("#view").selectOption("split");
      await fillEditor(
        restored,
        "# Bounded gallery\n" +
          Array.from(
            { length: 13 },
            () => `[![Gallery](../${first})](https://invalid.example/)`,
          ).join("\n\n"),
      );
      await restored.waitForFunction(
        () => document.querySelectorAll("#preview img").length === 12,
      );
      await restored
        .getByRole("button", { name: "Open image: Gallery", exact: true })
        .click();
      await restored.locator("#image-dialog").waitFor({ state: "visible" });
      assert.equal(await restored.locator("#preview button button").count(), 0);
      await restored.locator("#image-close").click();
    } finally {
      await other.close();
    }
    await page.reload();
    await page.waitForFunction(() =>
      document
        .querySelector("#notice")
        .textContent.includes("Recovered local workspace"),
    );
    assert.deepEqual(await paths(), all);
    // Touch viewport: launcher, picker and image inspector remain usable without paste.
    await page.setViewportSize({ width: 393, height: 852 });
    await page.locator("#workspace-editor").click();
    await idle();
    await page.locator("#view").selectOption("edit");
    await pick(png);
    await idle();
    assert.equal((await paths()).length, 4);
    await page.locator("#view").selectOption("preview");
    await page.locator("#preview .local-image").first().click();
    await page.locator("#image-fit").click();
    await page.locator("#image-close").click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "test-results/carbon-images-mobile.png",
      fullPage: true,
    });
    check(
      "TAR and TAR.GZ retain original bytes; fresh offline import and cache reload; narrow-screen picker and inspector",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    return {
      checks,
      pageErrors: errors,
      networkRequests: network,
      physicalAndroid:
        "Not tested; synthetic clipboard/drop and viewport tests do not verify physical device input",
    };
  } finally {
    await context.close();
  }
}
