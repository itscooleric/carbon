import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { sample } from "./helpers.js";
import { encode } from "../src/core/validate.js";
import { writeTar } from "../src/archives/tar.js";
import { editorView, editorText } from "./editor-browser-helpers.mjs";

export async function paletteFlows(browser) {
  const checks = [],
    errors = [],
    network = [];
  for (const mobile of [false, true]) {
    console.log(`Palette scenario: ${mobile ? "mobile" : "desktop"}`);
    const context = await browser.newContext({
      offline: true,
      timezoneId: "America/New_York",
      viewport: mobile
        ? { width: 393, height: 852 }
        : { width: 1440, height: 1000 },
      ...(mobile
        ? {
            isMobile: true,
            hasTouch: true,
            userAgent:
              "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
          }
        : {}),
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (/^https?:/.test(r.url())) network.push(r.url());
    });
    page.on("dialog", (d) => d.accept());
    const content = page.locator("#editor .cm-content"),
      palette = page.locator("#command-palette"),
      query = page.locator("#palette-query");
    const idle = () =>
      page.waitForFunction(
        () =>
          document.querySelector("#workspace").getAttribute("aria-busy") !==
          "true",
      );
    const settled = () =>
      page.waitForFunction(
        () =>
          !/^(Indexing|Searching)/.test(
            document.querySelector("#palette-status").textContent,
          ),
      );
    const launch = async () => {
      if (mobile) await page.locator("#palette-launcher").tap();
      else await page.keyboard.press("Control+Shift+P");
      await palette.waitFor({ state: "visible" });
      await settled();
    };
    const search = async (text) => {
      await query.fill(text);
      await settled();
    };
    const done = async () => {
      await palette.waitFor({ state: "hidden" });
      await idle();
    };
    const entryResult = () =>
      page
        .locator('#palette-results section[aria-label="Entries"] button')
        .first();
    const documentResult = () => page.locator(".palette-document").first();
    const command = (name) =>
      page
        .locator('#palette-results section[aria-label="Commands"]')
        .getByRole("button", { name, exact: false });
    try {
      await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
      await page.waitForFunction(
        () =>
          document.querySelector("#notice").textContent !==
          "Opening local workspace…",
      );
      const alpha =
        "---\r\nid: ent-alpha\r\ntitle: Launch plan\r\n---\r\n# Launch plan\r\n" +
        "filler line\r\n".repeat(1500) +
        "first needle\r\n" +
        "more filler\r\n".repeat(100) +
        "second needle\r\n";
      const normalized = alpha.replace(/\r\n/g, "\n");
      const stack = sample().change({
        writes: new Map([
          ["entries/alpha.md", encode(alpha)],
          [
            "entries/repeated.md",
            encode(
              "# Repeats\n" +
                "repeat-token ".repeat(5000) +
                "\nlate phrase\n<img src=x onerror=bad()>\n",
            ),
          ],
          [
            "entries/links.md",
            encode(
              "[[ent-alpha|Rhea]] [[note|Ambiguous]] [[ent-alpha|Shared]] [[ent-note|Shared]]",
            ),
          ],
        ]),
      });
      await page
        .locator("#files")
        .setInputFiles({
          name: "palette.stack.tar",
          mimeType: "application/octet-stream",
          buffer: Buffer.from(writeTar(stack)),
        });
      await page.locator("#dialog-accept").click();
      await idle();
      if (mobile) await page.locator("#files-toggle").click();
      await page.locator('#tree button[title="entries/other.md"]').click();
      await idle();
      if (mobile && await page.locator("#sidebar").isVisible()) await page.locator("#files-toggle").click();
      await editorView(page);
      const original = await editorText(page);
      await page.locator("#tree details").evaluateAll((folders) => {
        for (const folder of folders)
          if (folder.querySelector(":scope > summary").textContent === "nested")
            folder.open = false;
      });
      await content.press("Control+End");
      await page.keyboard.insertText(" draftOnly");
      const draft = await editorText(page);
      await page.evaluate(() => carbonTestSelect([[2, 7]]));
      const selection = await page.evaluate(() =>
        carbonTestView().state.selection.toJSON(),
      );
      await launch();
      assert.equal(
        await query.evaluate((el) => el === document.activeElement),
        true,
      );
      await query.press("Escape");
      await done();
      assert.deepEqual(
        await page.evaluate(() => carbonTestView().state.selection.toJSON()),
        selection,
      );
      assert.equal(
        await page.evaluate(
          () =>
            document.activeElement.id === "palette-launcher" ||
            document.activeElement.classList.contains("cm-content"),
        ),
        true,
      );

      if (!mobile) {
        await page.keyboard.press("Meta+Shift+P");
        await palette.waitFor({ state: "visible" });
        await settled();
        await query.press("Escape");
        await done();
      }
      await launch();
      await search("Launch");
      await query.press("ArrowDown");
      await page.keyboard.press("Control+Shift+P");
      assert.equal(await query.evaluate((el) => el === document.activeElement), true);
      assert.deepEqual(
        await page
          .locator("#palette-results section")
          .evaluateAll((nodes) =>
            nodes.map((n) => n.getAttribute("aria-label")),
          ),
        ["Entries", "Content"],
      );
      await entryResult().click();
      await done();
      assert.equal(await editorText(page), normalized);
      assert.equal(await page.locator("#tree details").evaluateAll((folders) =>
        folders.find((folder) => folder.querySelector(":scope > summary").textContent === "nested").open
      ), false);
      await launch();
      await search("needle");
      assert.match(
        await documentResult().locator("summary").textContent(),
        /2 occurrences/,
      );
      await documentResult().locator("summary").click();
      await documentResult().locator(".palette-excerpts button").nth(1).click();
      await done();
      const second = normalized.lastIndexOf("needle");
      assert.equal(
        await page.evaluate(() => carbonTestView().state.selection.main.head),
        second,
      );
      assert.equal(await editorText(page), normalized);
      await page.waitForFunction(
        () => carbonTestView().scrollDOM.scrollTop > 0,
      );
      assert.equal(
        await page.locator(".cm-palette-hit").textContent(),
        "needle",
      );
      await page
        .locator(".cm-palette-hit")
        .waitFor({ state: "hidden", timeout: 7000 });

      await launch();
      await search("draftOnly");
      await documentResult().locator("summary").click();
      await documentResult()
        .locator(".palette-excerpts button")
        .first()
        .click();
      await done();
      assert.equal(await editorText(page), draft);
      await content.press("Control+z");
      assert.equal(await editorText(page), original);
      await content.press("Control+Shift+Z");
      assert.equal(await editorText(page), draft);
      assert.equal(await page.locator(".cm-palette-hit").count(), 0);

      await launch();
      await search("Rhea");
      assert.equal(
        await page
          .locator('#palette-results section[aria-label="Entities"] button')
          .count(),
        1,
      );
      await page
        .locator('#palette-results section[aria-label="Entities"] button')
        .click();
      await done();
      assert.equal(
        await page.locator("#current-path").textContent(),
        "entries/alpha.md",
      );
      assert.equal(await page.locator(".cm-palette-hit").count(), 0);
      await launch();
      await search("Shared");
      assert.equal(
        await page
          .locator('#palette-results section[aria-label="Entities"]')
          .count(),
        0,
      );
      assert.match(
        await page.locator("#palette-status").textContent(),
        /ambiguous/,
      );
      await search("repeat-token");
      assert.match(
        await documentResult().locator("summary").textContent(),
        /5000 occurrences/,
      );
      await query.press("ArrowDown");
      await page.keyboard.press("Enter");
      await documentResult()
        .locator(".palette-excerpts button[data-from]")
        .first()
        .waitFor();
      assert.equal(
        await documentResult().locator("button[data-from]").count(),
        5,
      );
      await documentResult()
        .getByRole("button", { name: "Show more occurrences" })
        .click();
      assert.equal(
        await documentResult().locator("button[data-from]").count(),
        25,
      );
      const offsets = await documentResult()
        .locator("button[data-from]")
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.from));
      assert.equal(new Set(offsets).size, 25);
      await search("<img");
      await documentResult().locator("summary").click();
      assert.equal(
        await page
          .locator("#palette-results img,#palette-results script")
          .count(),
        0,
      );
      assert.equal(
        await page.locator("#palette-results mark").first().textContent(),
        "<img",
      );
      await query.fill("repeat-token");
      await query.fill("no-results-xyz");
      await settled();
      assert.match(
        await page.locator("#palette-status").textContent(),
        /No results/,
      );
      assert.equal(await page.locator("#palette-results button").count(), 0);
      await query.press("Shift+Tab");
      assert.equal(
        await page.evaluate(() =>
          document
            .querySelector("#command-palette")
            .contains(document.activeElement),
        ),
        true,
      );
      await page.keyboard.press("Escape");
      await done();

      await launch();
      await search("Go to Entry");
      await command("Go to Entry").click();
      await settled();
      assert.equal(await page.locator("#palette-all").isVisible(), true);
      await search("ent-note");
      await query.press("Enter");
      await done();
      assert.equal(
        await page.locator("#current-path").textContent(),
        "entries/nested/note.md",
      );
      await launch();
      assert.equal(await page.locator("#palette-all").isVisible(), false);
      await search("Toggle Preview");
      await command("Toggle Preview").click();
      await done();
      assert.equal(await page.locator("#view").inputValue(), "preview");
      await launch();
      await search("needle");
      await documentResult().locator("summary").click();
      await documentResult().locator("button[data-from]").first().click();
      await done();
      assert.equal(await page.locator("#view").inputValue(), "edit");

      // Stale draft offsets are rejected, not applied to another passage.
      await launch();
      await search("needle");
      await documentResult().locator("summary").click();
      await page.evaluate(() =>
        carbonTestView().dispatch({
          changes: { from: 0, insert: "changed " },
          userEvent: "input.paste",
        }),
      );
      await documentResult().locator("button[data-from]").first().click();
      await page.waitForFunction(() =>
        /Entry changed/.test(
          document.querySelector("#palette-status").textContent,
        ),
      );
      assert.equal(await palette.isVisible(), true);
      await query.press("Escape");
      await done();
      await content.press("Control+z");

      // A failed IndexedDB commit must not create an Entry or advance revision/history.
      await page.waitForTimeout(350);
      const before = await page.locator("#stack-meta").textContent();
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (window.failPaletteWrite)
            throw Error("Injected palette persistence failure");
          return put.apply(this, args);
        };
        window.failPaletteWrite = true;
      });
      await launch();
      await search("Open Today's Log");
      await command("Open Today's Log").click();
      await page.waitForFunction(() =>
        /Injected palette persistence failure/.test(
          document.querySelector("#palette-status").textContent,
        ),
      );
      assert.equal(await page.locator("#stack-meta").textContent(), before);
      assert.equal(
        await page.locator("#current-path").textContent(),
        "entries/alpha.md",
      );
      await page.evaluate(() => {
        window.failPaletteWrite = false;
      });
      await command("Open Today's Log").click();
      await done();
      const today = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      });
      assert.equal(
        await page.locator("#current-path").textContent(),
        `entries/logbook/${today}.md`,
      );
      assert.match(await editorText(page), new RegExp(`# Log ${today}`));
      const revision = await page.locator("#stack-meta").textContent();
      await launch();
      await search("Open Today's Log");
      await command("Open Today's Log").click();
      await done();
      assert.equal(await page.locator("#stack-meta").textContent(), revision);
      await page.reload();
      await page.waitForFunction(
        () =>
          document.querySelector("#notice").textContent !==
          "Opening local workspace…",
      );
      await launch();
      await search("draftOnly");
      await documentResult().locator("summary").click();
      await documentResult().locator("button[data-from]").first().click();
      await done();
      assert.equal(await editorText(page), draft);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      if (mobile) {
        await launch();
        await search("needle");
        await documentResult().locator("summary").click();
        await page.screenshot({
          path: "test-results/carbon-palette-mobile.png",
          fullPage: true,
        });
        await query.press("Escape");
        await done();
      }
      checks.push(
        `${mobile ? "Touch viewport" : "Desktop"}: unified ranking, grouped counts/excerpt paging, exact CRLF offsets, transient highlights, drafts/history, focus/Escape, commands, stale-result rejection, atomic template creation and reload`,
      );
    } finally {
      await context.close();
    }
  }
  await paletteReviewFlows(browser, errors, network);
  checks.push("Review regressions: literal boundary whitespace, Markdown-aware titles/templates, distinct duplicate command labels and targets");
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  return {
    checks,
    pageErrors: errors,
    networkRequests: network,
    physicalAndroid: "Not tested",
  };
}

async function paletteReviewFlows(browser, errors, network) {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (/^https?:/.test(r.url())) network.push(r.url()); });
  try {
    const body = "```sh\n# Preserve code comment\n```\n\n<pre>\n# Preserve HTML example\n</pre>\n\n# Real title\nfoo foobar  foo \n";
    const stack = sample().change({ writes: new Map([
      ["templates/code.md", encode(body)],
      ["templates/commands.yaml", encode("commands:\n" + ["first", "second"].map(id =>
        `  - id: ${id}\n    label: Toggle Preview\n    template: templates/code.md\n    path: entries/${id}.md\n    title: "${id} title # ~~draft~~"\n`).join(""))],
    ]) });
    await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
    await page.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
    await page.locator("#files").setInputFiles({ name:"review.tar", mimeType:"application/octet-stream", buffer:Buffer.from(writeTar(stack)) });
    await page.locator("#dialog-accept").click();
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") !== "true");
    const search = async text => {
      await page.locator("#palette-query").fill(text);
      await page.waitForFunction(() => !/^(Indexing|Searching)/.test(document.querySelector("#palette-status").textContent));
    };
    await page.locator("#palette-launcher").click();
    await search(" foo ");
    const doc = page.locator(".palette-document").filter({hasText:"templates/code.md"});
    assert.match(await doc.textContent(), /Real title[\s\S]*1 occurrence/);
    await doc.locator("summary").click();
    assert.equal(await doc.locator("mark").textContent(), " foo ");
    await doc.locator("button[data-from]").click();
    await page.locator("#command-palette").waitFor({state:"hidden"});
    await editorView(page);
    assert.equal(await page.evaluate(() => carbonTestView().state.selection.main.head), body.indexOf(" foo "));
    assert.equal(await page.locator(".cm-palette-hit").textContent(), " foo ");
    await page.locator("#palette-launcher").click();
    await search("Toggle Preview");
    const commands = page.locator('#palette-results section[aria-label="Commands"] button');
    assert.equal(await commands.count(), 3);
    assert.deepEqual(await commands.locator("small").allTextContents(), ["Command · toggle-preview", "Template first · entries/first.md", "Template second · entries/second.md"]);
    await commands.filter({hasText:"Template second"}).click();
    await page.locator("#command-palette").waitFor({state:"hidden"});
    assert.equal(await page.locator("#current-path").textContent(), "entries/second.md");
    assert.ok((await editorText(page)).endsWith(body.replace("# Real title", "# second title \\# \\~\\~draft\\~\\~")));
    assert.equal(await page.locator("#preview h1").textContent(), "second title # ~~draft~~");
  } finally { await context.close(); }
}
