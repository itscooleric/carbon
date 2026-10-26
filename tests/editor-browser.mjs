import { menuClick } from "./refinements-browser.mjs";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  editorText,
  fillEditor,
  editorView,
} from "./editor-browser-helpers.mjs";
import { sample } from "./helpers.js";
import { writeTar } from "../src/archives/tar.js";
import { encode } from "../src/core/validate.js";

export async function editorFlows(browser) {
  const errors = [],
    network = [],
    checks = [];
  for (const mobile of [false, true]) {
    console.log(`Editor scenario: ${mobile ? "mobile" : "desktop"}`);
    const context = await browser.newContext({
      offline: true,
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
    const waitIdle = () =>
      page.waitForFunction(
        () =>
          document.querySelector("#workspace").getAttribute("aria-busy") !==
          "true",
      );
    const select = async (ranges) => {
      await editorView(page);
      await page.evaluate((r) => carbonTestSelect(r), ranges);
    };
    const expectText = async (text) => {
      await page.waitForFunction(
        (expected) => carbonTestView().state.doc.toString() === expected,
        text,
        { timeout: 5000 },
      );
      assert.equal(await editorText(page), text);
    };
    // Playwright's fill() directly manipulates DOM selection; Android's deferred
    // selection handling can race it after a completion tap. Seed mobile fixtures
    // with public transactions, then exercise input/keys/touch/IME on the real DOM.
    const setFixture = async (text) => {
      if (!mobile) return fillEditor(page, text);
      await editorView(page);
      await page.evaluate((text) => {
        const view = carbonTestView();
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
          userEvent: "input.paste",
        });
        view.focus();
      }, text);
    };
    const content = page.locator("#editor .cm-content");
    const open = async (path) => {
      if (mobile && !(await page.locator("#sidebar").isVisible()))
        await page.locator("#files-toggle").click();
      await page.locator(`#tree button[title="${path}"]`).click();
      if (!path.endsWith(".md")) return;
      await waitIdle();
      if (mobile && (await page.locator("#sidebar").isVisible()))
        await page.locator("#files-toggle").click();
    };
    try {
      await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
      await page.waitForFunction(
        () =>
          document.querySelector("#notice").textContent !==
          "Opening local workspace…",
      );
      let stack = sample().change({
        writes: new Map([
          [
            "assets/table.csv",
            encode(
              'name,value\r\n"<script>bad()</script>","a,b"\r\nformula,=1+1',
            ),
          ],
          [
            "assets/data.json",
            encode('{"n":9007199254740993,"text":"<img src=x onerror=bad()>"}'),
          ],
        ]),
      });
      await page.locator("#files").setInputFiles({
        name: "editor.stack.tar",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(writeTar(stack)),
      });
      await page.locator("#dialog-accept").click();
      await waitIdle();
      await open("entries/other.md");
      await setFixture("1. one");
      await content.press("Control+End");
      await content.press("Enter");
      await expectText("1. one\n2. ");
      await content.press("Enter");
      await expectText("1. one\n");
      const list = "10. parent\n11. child\n    - nested\n12. sibling\n13. last";
      const indented =
        "10. parent\n    11. child\n        - nested\n    12. sibling\n13. last";
      await setFixture(list);
      await select([[list.indexOf("13. last"), list.indexOf("11. child")]]);
      const originalSelection = await page.evaluate(() =>
        carbonTestView().state.selection.toJSON(),
      );
      await content.press("Tab");
      await expectText(indented);
      assert.equal(
        await content.evaluate((el) => el === document.activeElement),
        true,
      );
      const movedSelection = await page.evaluate(() => {
        const { anchor, head } = carbonTestView().state.selection.main;
        return { anchor, head };
      });
      assert.equal(movedSelection.anchor, indented.indexOf("13. last"));
      assert.equal(movedSelection.head, indented.indexOf("11. child"));
      await content.press("Control+z");
      await expectText(list);
      assert.deepEqual(
        await page.evaluate(() => carbonTestView().state.selection.toJSON()),
        originalSelection,
      );
      await content.press("Control+Shift+Z");
      await expectText(indented);
      await content.press("Shift+Tab");
      await expectText(list);
      assert.deepEqual(
        await page.evaluate(() => carbonTestView().state.selection.toJSON()),
        originalSelection,
      );
      // Outside a movable list, Tab indents at the cursor and Shift+Tab outdents the line; focus stays.
      for (const source of [
        "plain text",
        "```md\n- first\n- child\n```",
        "---\n- first\n- child\n---",
      ]) {
        await setFixture(source);
        const at = source.includes("child") ? source.lastIndexOf("\n", source.indexOf("child")) + 1 : 0;
        await select([[at]]);
        await content.press("Tab");
        await expectText(source.slice(0, at) + "  " + source.slice(at));
        assert.equal(await content.evaluate((el) => el === document.activeElement), true, `Tab: ${source}`);
        await content.press("Shift+Tab");
        await expectText(source);
        assert.equal(await content.evaluate((el) => el === document.activeElement), true, `Shift+Tab: ${source}`);
      }
      // A multi-line selection indents every selected line.
      await setFixture("one\ntwo");
      await select([[0, 7]]);
      await content.press("Tab");
      await expectText("  one\n  two");
      await content.press("Shift+Tab");
      await expectText("one\ntwo");
      await setFixture("- parent\n  - child");
      for (const key of ["Tab", "Shift+Tab"]) {
        await content.press("Escape");
        await content.press(key);
        await expectText("- parent\n  - child");
        assert.equal(
          await content.evaluate((el) => el === document.activeElement),
          false,
          `Escape then ${key}`,
        );
      }
      // Persistent focus-navigation mode survives refocusing and has an explicit toggle.
      await content.press("Control+m");
      await content.press("Shift+Tab");
      await expectText("- parent\n  - child");
      assert.equal(
        await content.evaluate((el) => el === document.activeElement),
        false,
      );
      await content.press("Control+m");
      await content.press("Shift+Tab");
      await expectText("- parent\n- child");
      await setFixture("- [x] done");
      await content.press("Control+End");
      await content.press("Enter");
      await expectText("- [x] done\n- [ ] ");
      await content.press("Control+a");
      await menuClick(page, "toggle-task");
      await expectText("- [x] done\n- [x] ");
      await content.press("Control+z");
      await expectText("- [x] done\n- [ ] ");
      await content.press("Control+Shift+Z");
      await expectText("- [x] done\n- [x] ");
      await content.press("Alt+c");
      await expectText("- [ ] done\n- [ ] ");
      await content.press("Alt+c");
      await expectText("- [x] done\n- [x] ");
      const tasks =
        "---\n- [ ] metadata\n---\n- [x] one\n- [ ] two\n```md\n- [ ] code\n```\n- [ ] excluded";
      await setFixture(tasks);
      await select([[0, tasks.indexOf("- [ ] excluded")]]);
      await content.press("Alt+c");
      await expectText(tasks.replace("- [ ] two", "- [x] two"));
      await content.press("Alt+c");
      await expectText(tasks.replace("- [x] one", "- [ ] one"));
      await setFixture("word");
      await content.press("Control+a");
      await content.press('"');
      await expectText('"word"');
      await setFixture("word");
      await content.press("Control+a");
      await content.press("*");
      await expectText("*word*");
      await setFixture("");
      await content.press("(");
      await expectText("()");
      await setFixture("");
      await content.press("[");
      await content.press("[");
      await page.waitForSelector(".cm-tooltip-autocomplete");
      await page.getByRole("option", { name: /^ent-note/ }).click();
      await expectText("[[ent-note]]");
      for (const source of ["```md\n", "---\ntitle: "]) {
        await setFixture(source);
        await content.press("Control+End");
        await content.press("[");
        await content.press("[");
        await page.waitForTimeout(250);
        assert.equal(await page.locator(".cm-tooltip-autocomplete").count(), 0);
      }
      await setFixture("word word");
      await select([[0, 4]]);
      await menuClick(page, "select-next");
      assert.equal(
        await page.evaluate(
          () => carbonTestView().state.selection.ranges.length,
        ),
        2,
      );
      await page.keyboard.insertText("term");
      await expectText("term term");
      await content.press("Control+z");
      await expectText("word word");
      await select([[0, 4]]);
      await page.evaluate(() => {
        window.bookmarkPrevented = null;
        document.addEventListener("keydown", (e) => {
          if (e.key === "d") window.bookmarkPrevented = e.defaultPrevented;
        });
      });
      await content.press("Control+d");
      assert.equal(await page.evaluate(() => window.bookmarkPrevented), false);
      await page.locator("#menu-doc summary").click();
      await page.locator("#occurrence-shortcut").check();
      await page.keyboard.press("Escape");
      await content.press("Control+d");
      assert.equal(
        await page.evaluate(
          () => carbonTestView().state.selection.ranges.length,
        ),
        2,
      );
      // A save, preview switch and Entry navigation must not reset the edit undo stack.
      await setFixture("# Saved\n\nText");
      await content.press("Control+End");
      await page.keyboard.insertText(" plus");
      await content.press("Control+s");
      await waitIdle();
      await content.press("Alt+p");
      assert.equal(await page.locator("#view").inputValue(), "preview");
      await page.locator("#preview").press("Alt+p");
      await open("entries/nested/note.md");
      await open("entries/other.md");
      await content.press("Control+z");
      await expectText("# Saved\n\nText");
      await content.press("Control+Shift+Z");
      await expectText("# Saved\n\nText plus");
      // Discard replaces the document and drops stale history, including on later navigation.
      await page.keyboard.insertText(" draft");
      await page.getByRole("button", { name: /Discard draft/ }).click();
      await page.locator("#dialog-accept").click();
      await waitIdle();
      await expectText("# Saved\n\nText plus");
      await content.press("Control+z");
      await expectText("# Saved\n\nText plus");
      if (mobile) {
        await setFixture("");
        await content.focus();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Input.imeSetComposition", {
          text: "日本",
          selectionStart: 2,
          selectionEnd: 2,
        });
        await cdp.send("Input.insertText", { text: "日本語" });
        await page.waitForFunction(
          () => carbonTestView().state.doc.toString() === "日本語",
        );
        await content.press("Control+s");
        await waitIdle();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page.screenshot({
          path: "test-results/carbon-editor-mobile.png",
          fullPage: true,
        });
        checks.push(
          "Android user-agent/touch viewport, Chromium IME composition and touch task control (not a physical Android keyboard)",
        );
      }
      await content.press("Control+s");
      await waitIdle();
      await open("assets/table.csv");
      assert.equal(
        await page.locator(".asset-preview td").first().textContent(),
        "name",
      );
      assert.equal(
        await page.locator(".asset-preview script,.asset-preview img").count(),
        0,
      );
      assert.match(await page.locator(".asset-preview").textContent(), /=1\+1/);
      await page.locator("#dialog-cancel").click();
      await waitIdle();
      await open("assets/data.json");
      assert.match(
        await page.locator(".asset-preview pre").textContent(),
        /9007199254740993/,
      );
      assert.equal(await page.locator(".asset-preview img").count(), 0);
      await page.locator("#dialog-cancel").click();
      await waitIdle();
      checks.push(
        `${mobile ? "Mobile" : "Desktop"}: list continuation/indent/outdent, selection and undo preservation, Tab indentation outside lists and both focus escapes, task normalization/exclusions, pairing/completion/multiple selections, optional shortcut, undo across save/preview/navigation/discard, inert CSV/JSON`,
      );
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  return { checks, pageErrors: errors, networkRequests: network };
}
