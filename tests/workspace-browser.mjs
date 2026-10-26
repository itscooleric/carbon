import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { sample } from "./helpers.js";
import { encode } from "../src/core/validate.js";
import { writeTar } from "../src/archives/tar.js";
import { editorView, editorText } from "./editor-browser-helpers.mjs";

export async function workspaceFlows(browser) {
  const checks = [],
    errors = [],
    network = [];
  for (const mobile of [false, true]) {
    console.log(`Workspace scenario: ${mobile ? "mobile" : "desktop"}`);
    const context = await browser.newContext({
      offline: true,
      viewport: mobile
        ? { width: 393, height: 852 }
        : { width: 1600, height: 1000 },
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    const page = await context.newPage();
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
    const current = () => page.locator("#current-path").textContent();
    const tab = (kind, path) =>
      page
        .locator(`#${kind}-tabs [role=tab]`)
        .filter({ hasText: path.split("/").pop() });
    const tree = async () => {
      if (mobile && !(await page.locator("#sidebar").isVisible()))
        await page.locator("#files-toggle").click();
    };
    const view = async (path) => {
      await tree();
      await page
        .getByRole("button", { name: `Open ${path} in Viewer`, exact: true })
        .click();
      await idle();
    };
    try {
      await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
      await page.waitForFunction(
        () =>
          document.querySelector("#notice").textContent !==
          "Opening local workspace…",
      );
      const s = sample().change({
        writes: new Map([
          ["assets/tall.png", new Uint8Array(await readFile("tests/fixtures/images/tall.png"))],
          ["entries/images.md", encode("# Long reference\n![Tall](../assets/tall.png)\n\nEnd of image reference.\n")],
          [
            "entries/reference.md",
            encode(
              "---\nid: ref-research\n---\n# Dataset research\n[[ent-note|Inventory note]]\n[External](https://example.com/private)\n" +
                "Reference detail\n\n".repeat(120),
            ),
          ],
          [
            "assets/inventory.csv",
            encode('Dataset,Status\nCensus,Available\n"Harbor, East",Review'),
          ],
          [
            "assets/requirements.json",
            encode(
              '{"count":9007199254740993,"unsafe":"<img src=x onerror=bad()>"}',
            ),
          ],
        ]),
      });
      await page.locator("#files").setInputFiles({
        name: "workspace.stack.tar",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(writeTar(s)),
      });
      await page.locator("#dialog-accept").click();
      await idle();
      await tree();
      await page.locator('#tree button[title="entries/other.md"]').click();
      await idle();
      await page.locator("#view").selectOption("edit");
      await editorView(page);
      const original = await editorText(page);
      const initialEditorTabs = await page
        .locator("#editor-tabs [role=tab]")
        .count();
      await page.locator("#editor .cm-content").press("Control+End");
      await page.keyboard.insertText(
        "\nWorking reconciliation draft" + "\nEvidence line".repeat(120),
      );
      const draft = await editorText(page);
      await page.evaluate(() => carbonTestSelect([[2, 7]]));
      const selection = await page.evaluate(() =>
        carbonTestView().state.selection.toJSON(),
      );
      for (const p of [
        "entries/reference.md",
        "assets/inventory.csv",
        "assets/requirements.json",
      ]) {
        await view(p);
        assert.equal(await current(), "entries/other.md");
        assert.equal(await editorText(page), draft);
        assert.deepEqual(
          await page.evaluate(() => carbonTestView().state.selection.toJSON()),
          selection,
        );
      }
      assert.equal(await page.locator("#viewer-tabs [role=tab]").count(), 3);
      assert.match(
        await page.locator("#viewer-content").textContent(),
        /9007199254740993/,
      );
      assert.equal(
        await page
          .locator("#viewer-content img, #viewer-content script")
          .count(),
        0,
      );
      await tab("viewer", "assets/inventory.csv").click();
      await idle();
      assert.equal(await page.locator("#viewer-content table tr").count(), 3);
      await tab("viewer", "entries/reference.md").click();
      await idle();
      await page
        .locator("#viewer-content")
        .evaluate((el) => (el.scrollTop = 500));
      await tab("viewer", "assets/inventory.csv").click();
      await idle();
      await tab("viewer", "entries/reference.md").click();
      await idle();
      assert.ok(
        (await page.locator("#viewer-content").evaluate((el) => el.scrollTop)) >
          300,
      );
      await page
        .locator("#viewer-content")
        .evaluate((el) => (el.scrollTop = 0));
      await page
        .locator('#viewer-content a[data-entry="entries/nested/note.md"]')
        .click();
      await idle();
      assert.equal(await current(), "entries/other.md");
      assert.equal(
        await page.locator("#viewer-path").textContent(),
        "entries/nested/note.md",
      );
      assert.equal(await page.locator("#viewer-tabs [role=tab]").count(), 4);
      await page.locator("#workspace-editor").click();
      await idle();
      assert.equal(await editorText(page), draft);
      await page.locator("#editor .cm-content").press("Control+z");
      assert.equal(await editorText(page), original);
      await page.locator("#editor .cm-content").press("Control+Shift+Z");
      assert.equal(await editorText(page), draft);
      await page.locator("#save-entry").click();
      await idle();
      await page.locator("#editor .cm-content").press("Control+End");
      await page.keyboard.insertText("\nSecond unsaved pass");
      const later = await editorText(page);
      await page.evaluate(() => {
        carbonTestSelect([[4, 9]]);
        carbonTestView().scrollDOM.scrollTop = 300;
      });
      await tree();
      await page
        .locator('#tree button[title="entries/nested/note.md"]')
        .click();
      await idle();
      await tab("editor", "entries/other.md").click();
      await idle();
      assert.equal(await editorText(page), later);
      assert.equal(
        await page.evaluate(() => carbonTestView().state.selection.main.anchor),
        4,
      );
      assert.ok(
        (await page.evaluate(() => carbonTestView().scrollDOM.scrollTop)) > 250,
      );
      await page.locator("#editor .cm-content").press("Control+z");
      assert.equal(await editorText(page), draft);
      await page.locator("#editor .cm-content").press("Control+Shift+Z");
      assert.equal(await editorText(page), later);
      // Palette navigation still targets Editor; Viewer tabs are retained.
      await page.locator("#palette-launcher").click();
      await page.locator("#palette-query").fill("Second unsaved pass");
      await page.locator(".palette-document summary").click();
      await page.locator(".palette-excerpts button[data-from]").first().click();
      await idle();
      await page.locator("#command-palette").waitFor({ state: "hidden" });
      assert.equal(await current(), "entries/other.md");
      assert.equal(await page.locator("#viewer-tabs [role=tab]").count(), 4);
      assert.equal(
        await page.locator(".cm-palette-hit").textContent(),
        "Second unsaved pass",
      );
      assert.equal(
        await page.locator("#editor-tabs [role=tab]").count(),
        initialEditorTabs + 1,
      );
      await page.locator("#workspace-viewer").click();
      await idle();
      await page.locator("#palette-launcher").click();
      await page.locator("#palette-query").fill("Toggle Preview");
      await page
        .locator("#palette-results button")
        .filter({ hasText: "Toggle Preview" })
        .click();
      await page.locator("#command-palette").waitFor({ state: "hidden" });
      await idle();
      assert.equal(await page.locator("#editor-pane").isVisible(), true);
      assert.equal(await page.locator("#view").inputValue(), "preview");
      assert.equal(await page.locator("#viewer-tabs [role=tab]").count(), 4);
      await page.locator("#view").selectOption("edit");
      if (!mobile) {
        await page.locator("#workspace-splitter").focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(
          await page
            .locator("#workspace-splitter")
            .getAttribute("aria-valuenow"),
          "55",
        );
        await page.locator("#swap-panes").click();
        await idle();
        const e = await page.locator("#editor-pane").boundingBox(),
          v = await page.locator("#viewer-pane").boundingBox();
        assert.ok(v.x < e.x);
      }
      await page.locator("#show-viewer").click();
      await idle();
      assert.equal(await page.locator("#viewer-pane").isVisible(), false);
      await page.locator("#show-viewer").click();
      await idle();
      assert.equal(await page.locator("#viewer-tabs [role=tab]").count(), 4);
      await page
        .getByRole("button", {
          name: "Close viewer tab assets/inventory.csv",
          exact: true,
        })
        .click();
      await idle();
      assert.equal(await page.locator("#viewer-tabs [role=tab]").count(), 3);
      assert.equal(await current(), "entries/other.md");
      await page.reload();
      await page.waitForFunction(() =>
        document
          .querySelector("#notice")
          .textContent.includes("Recovered local workspace"),
      );
      assert.equal(await page.locator("#viewer-tabs [role=tab]").count(), 3);
      assert.equal(
        await page.locator("#editor-tabs [role=tab]").count(),
        initialEditorTabs + 1,
      );
      assert.equal(await current(), "entries/other.md");
      assert.equal(await editorText(page), later);
      if (!mobile)
        assert.equal(
          await page
            .locator("#workspace-splitter")
            .getAttribute("aria-valuenow"),
          "55",
        );
      await page.locator("#workspace-viewer").click();
      await idle();
      await tab("viewer", "entries/reference.md").click();
      await idle();
      await page.keyboard.press("ArrowRight");
      await idle();
      assert.equal(
        await page.locator("#viewer-path").textContent(),
        "assets/requirements.json",
      );
      assert.equal(
        await page.evaluate(() => document.activeElement.getAttribute("role")),
        "tab",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      // A tab list has one sequential stop; its pointer/touch close controls use Delete on the tab.
      assert.equal(await page.locator('.document-tabs .close-tab[tabindex="0"]').count(), 0);
      const activeTab = page.locator('#viewer-tabs [role="tab"][aria-selected="true"]');
      await activeTab.focus(); await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains("close-tab")), false);
      // Hold image decode on revisiting a long reference; early clamping must not overwrite its saved offset.
      await view("entries/images.md");
      await page.waitForFunction(() => document.querySelector("#viewer-content img")?.naturalHeight === 2000);
      await page.waitForTimeout(80);
      await page.locator("#viewer-content").evaluate(el => { el.scrollTop = 1200; });
      await page.waitForTimeout(600);
      await view("assets/inventory.csv");
      await page.evaluate(() => {
        window.realDecode = HTMLImageElement.prototype.decode;
        HTMLImageElement.prototype.decode = async function() {
          if (window.holdViewerDecode) await new Promise(resolve => { window.releaseViewerDecode = resolve; });
          return window.realDecode.call(this);
        };
        window.holdViewerDecode = true;
      });
      await view("entries/images.md");
      await page.waitForFunction(() => !!window.releaseViewerDecode);
      await page.waitForTimeout(600);
      await page.evaluate(() => { window.holdViewerDecode = false; window.releaseViewerDecode(); });
      await page.waitForFunction(() => document.querySelector("#viewer-content").scrollTop === 1200);
      await page.reload();
      await page.waitForFunction(() => document.querySelector("#viewer-content").scrollTop === 1200);
      // A late decode from a previous tab must not reset the current document's scroll.
      await view("assets/inventory.csv");
      await page.evaluate(() => {
        const original = HTMLImageElement.prototype.decode;
        HTMLImageElement.prototype.decode = async function() {
          await new Promise(resolve => { window.releaseOldDecode = resolve; });
          return original.call(this);
        };
      });
      await view("entries/images.md");
      await page.waitForFunction(() => !!window.releaseOldDecode);
      await view("assets/inventory.csv");
      await page.evaluate(() => window.releaseOldDecode());
      await page.waitForTimeout(80);
      assert.equal(await page.locator("#viewer-content img").count(), 0);
      assert.equal(await page.locator("#viewer-path").textContent(), "assets/inventory.csv");
      await mkdir("test-results", { recursive: true });
      await page.screenshot({
        path: `test-results/carbon-workspace-${mobile ? "mobile" : "desktop"}.png`,
        fullPage: true,
      });
      checks.push(
        `${mobile ? "Touch viewport" : "Desktop"}: three reference types, independent links/tabs, draft/save/undo/selection, palette jump, closing/hiding, arrangement recovery and keyboard focus`,
      );
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  return {
    checks,
    pageErrors: errors,
    networkRequests: network,
    physicalAndroid: "Not tested",
  };
}
