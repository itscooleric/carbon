/** Editor-first shell regressions: layout budget, explorer collapse, command palette
 * reachability, compact tabs, status line, notices and the Android formatting row.
 * Invoked by tests/browser.mjs against the built, offline file:// distributable.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { sample } from "./helpers.js";
import { writeTar } from "../src/archives/tar.js";
import { editorView, editorText } from "./editor-browser-helpers.mjs";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";

const VIEWPORTS = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "desktop-1024", viewport: { width: 1024, height: 700 }, mobile: false },
  { name: "android-412", viewport: { width: 412, height: 915 }, mobile: true },
  { name: "android-360", viewport: { width: 360, height: 740 }, mobile: true },
];

export async function shellFlows(browser) {
  const checks = [],
    errors = [],
    network = [],
    budgets = [];
  for (const { name, viewport, mobile } of VIEWPORTS) {
    const context = await browser.newContext({
      offline: true,
      viewport,
      colorScheme: "dark",
      reducedMotion: "reduce",
      ...(mobile ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (/^https?:/.test(r.url())) network.push(r.url());
    });
    page.on("dialog", (d) => d.accept());
    const idle = () =>
      page.waitForFunction(
        () => document.querySelector("#workspace").getAttribute("aria-busy") !== "true",
      );
    const palette = page.locator("#command-palette"),
      query = page.locator("#palette-query");
    const settled = () =>
      page.waitForFunction(
        () => !/^(Indexing|Searching)/.test(document.querySelector("#palette-status").textContent),
      );
    const command = async (label) => {
      await page.locator("#palette-launcher").click();
      await palette.waitFor({ state: "visible" });
      await settled();
      await query.fill(label);
      await settled();
      await page
        .locator('#palette-results section[aria-label="Commands"] button')
        .filter({ hasText: label })
        .first()
        .click();
      await palette.waitFor({ state: "hidden" });
      await idle();
    };
    try {
      await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
      await page.waitForFunction(
        () => document.querySelector("#notice").textContent !== "Opening local workspace…",
      );
      await page.locator("#files").setInputFiles({
        name: "shell.tar",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(writeTar(sample())),
      });
      await page.locator("#dialog-accept").click();
      await idle();
      if (mobile) await page.locator("#files-toggle").click();
      await page.locator('#tree button[title="entries/other.md"]').click();
      await idle();
      if (mobile && (await page.locator("#sidebar").isVisible()))
        await page.locator("#files-toggle").click();

      // 1. One header row, no permanent toolbar or notice row, no horizontal overflow.
      const layout = await page.evaluate(() => {
        const box = (s) => document.querySelector(s)?.getBoundingClientRect();
        const header = box("header.topbar"),
          status = box("footer.statusbar"),
          panes = box("#panes");
        return {
          toolbarRows: document.querySelectorAll(".toolbar, .workspace-tools, .editor-toolbar, .editor-tools").length,
          header: header.height,
          status: status.height,
          panes: panes.height * panes.width,
          viewport: innerWidth * innerHeight,
          panesHeight: panes.height,
          overflowX: document.documentElement.scrollWidth > innerWidth,
          overflowY: document.documentElement.scrollHeight > innerHeight,
          noticeInFlow: getComputedStyle(document.getElementById("notice")).position !== "fixed",
        };
      });
      assert.equal(layout.toolbarRows, 0, `${name}: legacy toolbar rows removed`);
      assert.equal(layout.overflowX, false, `${name}: no horizontal overflow`);
      assert.equal(layout.overflowY, false, `${name}: fits vertically`);
      assert.equal(layout.noticeInFlow, false, `${name}: notice does not take a row`);
      assert.ok(layout.header <= (mobile ? 48 : 40), `${name}: header ${layout.header}px`);
      const share = layout.panes / layout.viewport;
      budgets.push({ name, editorShare: Number(share.toFixed(3)), header: layout.header, status: layout.status });
      // Editor surface (editor + preview) owns most of the window, with the explorer open on desktop.
      assert.ok(share >= (mobile ? 0.7 : 0.6), `${name}: document surface ${share}`);

      // 1b. Every header control keeps an accessible name when its text is hidden (icon-only layout below
      // the narrow breakpoint): an explicit aria-label, or text that is actually rendered (innerText skips
      // display:none; the title alone is only a fallback and here would be the shortcut).
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll("header.topbar > button, .header-actions > button, .header-actions > details > summary")]
          .filter((el) => el.getClientRects().length)
          .filter((el) => !((el.getAttribute("aria-label") || "").trim() || el.innerText.trim()))
          .map((el) => el.id || el.parentElement.id || el.outerHTML.slice(0, 60)),
      );
      assert.deepEqual(unnamed, [], `${name}: header controls without an accessible name`);
      for (const label of ["Open / Import", "Export", "More"])
        assert.equal(await page.locator(`.header-actions summary[aria-label="${label}"]`).count(), 1, `${name}: ${label} summary`);
      assert.equal(await page.getByRole("button", { name: "Dispatch", exact: true }).count(), 1, `${name}: Dispatch is named "Dispatch", not its shortcut`);

      // 2. Compact tabs: name only, unsaved shown as a marker, path once in the status line.
      const tab = page.locator('#editor-tabs [role="tab"][aria-selected="true"]');
      assert.equal(await tab.textContent(), "other.md");
      assert.equal(await page.locator("#current-path").textContent(), "entries/other.md");
      await editorView(page);
      await page.evaluate(() => {
        const view = carbonTestView();
        view.dispatch({ changes: { from: view.state.doc.length, insert: "\nshell draft" }, userEvent: "input.type" });
      });
      await page.waitForFunction(() =>
        document.querySelector('#editor-tabs [role="tab"][aria-selected="true"]').classList.contains("dirty"),
      );
      assert.match(await tab.getAttribute("aria-label"), /unsaved draft/);
      assert.match(await page.locator("#editor-status").textContent(), /unsaved/);
      await page.locator("#save-entry").click();
      await idle();
      assert.equal(await tab.evaluate((b) => b.classList.contains("dirty")), false);

      // 3. Infrequent actions are reachable from the palette, not permanent buttons.
      await page.locator("#palette-launcher").click();
      await palette.waitFor({ state: "visible" });
      await settled();
      const labels = await page
        .locator('#palette-results section[aria-label="Commands"] button')
        .evaluateAll((nodes) => nodes.map((n) => n.firstChild.textContent));
      for (const label of ["New Dispatch…", "Import Return…", "Export TAR.GZ", "Insert image…", "History", "Toggle Viewer"])
        assert.ok(labels.includes(label), `${name}: palette lists ${label}`);
      assert.ok(labels.some((l) => l.startsWith("Theme:")), `${name}: theme commands`);
      await page.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });

      // 4. Theme via command; local preference only.
      await command("Theme: Graphite light");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
      await command("Theme: Graphite dark");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");

      // 5. Explorer toggle: docked collapse on desktop, overlay on phones; palette and shortcut.
      const sidebarWidth = () => page.evaluate(() => document.getElementById("sidebar").offsetWidth);
      if (!mobile) {
        assert.ok((await sidebarWidth()) > 0);
        await page.locator("#editor .cm-content").click();
        await page.keyboard.press("Control+Backslash");
        await page.waitForFunction(() => document.getElementById("sidebar").offsetWidth === 0);
        assert.equal(await page.locator("#files-toggle").getAttribute("aria-expanded"), "false");
        await page.reload();
        await page.waitForFunction(() => /Recovered/.test(document.querySelector("#notice").textContent));
        assert.equal(await sidebarWidth(), 0, `${name}: collapsed explorer is remembered`);
        await command("Toggle file explorer");
        assert.ok((await sidebarWidth()) > 0);
      } else {
        assert.equal(await sidebarWidth(), 0);
        await page.locator("#files-toggle").tap();
        await page.waitForFunction(() => document.getElementById("sidebar").offsetWidth > 0);
        await page.locator('#tree button[title="entries/other.md"]').tap();
        await idle();
        assert.equal(await sidebarWidth(), 0, `${name}: choosing a file dismisses the overlay`);
      }

      // 6. Document menu: keyboard operable, closes on Escape and returns focus.
      await page.locator("#menu-doc summary").focus();
      await page.keyboard.press("Enter");
      await page.waitForSelector("#menu-doc[open]");
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.evaluate(() => document.activeElement.id), "toggle-task");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.getElementById("menu-doc").open);
      assert.equal(await page.evaluate(() => document.activeElement.closest("#menu-doc") !== null), true);

      // 7. Viewer stays hidden until opened; Hide control inside the Viewer bar.
      assert.equal(await page.locator("#viewer-pane").isVisible(), false);
      await page.locator("#show-viewer").click();
      await idle();
      assert.equal(await page.locator("#show-viewer").getAttribute("aria-label"), "Hide Viewer");
      await page.locator('#viewer-pane [data-proxy="show-viewer"]').click();
      await idle();
      assert.equal(await page.locator("#viewer-pane").isVisible(), false);
      if (mobile) await page.locator("#workspace-editor").tap();

      // 8. Phones: the formatting row is visible, 44px, and forwards to the real commands.
      const accessory = page.locator(".accessory");
      assert.equal(await accessory.isVisible(), mobile);
      if (mobile) {
        const heights = await accessory.locator("button").evaluateAll((b) => b.map((x) => x.getBoundingClientRect().height));
        assert.ok(heights.every((h) => h >= 44), `${name}: touch targets ${heights}`);
        await editorView(page);
        await page.evaluate(() => {
          const view = carbonTestView();
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "- [ ] task" }, selection: { anchor: 3 } });
        });
        await accessory.getByRole("button", { name: "Toggle task" }).tap();
        assert.equal(await editorText(page), "- [x] task");
        const targets = await page.evaluate(() =>
          [...document.querySelectorAll("header button, header summary, .pane-tools button, .pane-tools summary, .statusbar button, .statusbar select")]
            .filter((e) => e.getClientRects().length)
            .map((e) => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height)),
        );
        assert.ok(targets.every((t) => t >= 44), `${name}: header and pane targets ${targets}`);
        // Soft keyboard: a short visual viewport keeps the editor and formatting row.
        await page.setViewportSize({ width: viewport.width, height: 420 });
        const short = await page.evaluate(() => ({
          panes: document.getElementById("panes").getBoundingClientRect().height,
          accessory: document.querySelector(".accessory").getBoundingClientRect().height,
          overflowY: document.documentElement.scrollHeight > innerHeight,
        }));
        assert.ok(short.panes >= 200, `${name}: editor height with keyboard ${short.panes}`);
        assert.ok(short.accessory >= 44);
        assert.equal(short.overflowY, false);
        await page.setViewportSize(viewport);
      }

      // 8b. VS Code-style split: icon toggles the preview beside the editor; divider resizes.
      await page.locator("#view").selectOption("edit");
      const toggleSplit = page.locator("#toggle-split");
      assert.equal(await toggleSplit.getAttribute("aria-pressed"), "false");
      await toggleSplit.click();
      assert.equal(await page.locator("#view").inputValue(), "split");
      assert.equal(await toggleSplit.getAttribute("aria-pressed"), "true");
      const geo = () =>
        page.evaluate(() => {
          const e = document.getElementById("editor").getBoundingClientRect(),
            p = document.getElementById("preview").getBoundingClientRect();
          return { sideBySide: p.left >= e.right - 1, stacked: p.top >= e.bottom - 1, e, p };
        });
      const g = await geo();
      if (name.startsWith("desktop")) {
        assert.equal(g.sideBySide, true, name + ": preview opens to the right by default");
        const before = g.e.width;
        const sp = await page.locator("#preview-splitter").boundingBox();
        await page.mouse.move(sp.x + 3, sp.y + sp.height / 2);
        await page.mouse.down();
        await page.mouse.move(sp.x + 3 - 120, sp.y + sp.height / 2, { steps: 4 });
        await page.mouse.up();
        assert.ok((await geo()).e.width < before - 60, name + ": dragging the divider resizes");
        await page.locator("#preview-splitter").focus();
        await page.keyboard.press("Home");
        assert.equal(await page.locator("#preview-splitter").getAttribute("aria-valuenow"), "50");
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.locator("#preview-splitter").getAttribute("aria-valuenow"), "52");
        await page.keyboard.press("Home");
        await page.locator("#menu-doc summary").click();
        await page.locator("#toggle-layout").click();
        assert.equal((await geo()).stacked, true, name + ": layout toggle stacks the preview");
        await page.locator("#menu-doc summary").click();
        await page.locator("#toggle-layout").click();
        assert.equal((await geo()).sideBySide, true);
      } else {
        assert.equal(g.stacked, true, name + ": narrow editors stack automatically");
      }
      await toggleSplit.click();
      assert.equal(await page.locator("#view").inputValue(), "edit");
      assert.equal(await page.locator("#preview-splitter").isVisible(), false);
      if (!mobile) {
        await toggleSplit.click();
      }

      // 8c. Divider range is 20-80% and ratio plus below/right layout are remembered across reloads.
      if (!mobile) {
        const sp = page.locator("#preview-splitter");
        await sp.focus();
        for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
        assert.equal(await sp.getAttribute("aria-valuenow"), "80", name + ": upper clamp");
        for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowLeft");
        assert.equal(await sp.getAttribute("aria-valuenow"), "20", name + ": lower clamp");
        for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
        assert.equal(await sp.getAttribute("aria-valuenow"), "30");
        await page.locator("#menu-doc summary").click();
        await page.locator("#toggle-layout").click();
        await page.reload();
        await page.waitForFunction(() => /Recovered/.test(document.querySelector("#notice").textContent));
        assert.equal(await page.locator("#preview-splitter").getAttribute("aria-valuenow"), "30", name + ": ratio remembered");
        assert.equal(await page.locator("#panes").getAttribute("data-layout"), "below", name + ": layout remembered");
        assert.equal((await geo()).stacked, true);
        await page.locator("#preview-splitter").dblclick();
        assert.equal(await page.locator("#preview-splitter").getAttribute("aria-valuenow"), "50", name + ": double-click resets");
        await page.locator("#menu-doc summary").click();
        await page.locator("#toggle-layout").click();
        assert.equal(await page.locator("#panes").getAttribute("data-layout"), "right");
      }
      // Hooks other modules bind to exist and are hidden by default (the palette skips hidden controls).
      for (const id of ["disk-history", "reconnect-folder", "export-history", "link-status", "save-state"])
        assert.equal(await page.locator("#" + id).evaluate((n) => n.hidden), true, `${name}: #${id} hidden by default`);
      const hookRows = () =>
        page.locator("#palette-results button").filter({ hasText: /Local file history|Reconnect folder|Forget remembered consent|Export local history/ });
      await page.locator("#palette-launcher").click();
      await palette.waitFor({ state: "visible" });
      await settled();
      assert.equal(await hookRows().count(), 0, `${name}: hidden hook controls are not palette commands`);
      await page.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });
      await page.evaluate(() => {
        document.getElementById("disk-history").hidden = false;
        document.getElementById("reconnect-folder").hidden = false;
      });
      await page.locator("#palette-launcher").click();
      await palette.waitFor({ state: "visible" });
      await settled();
      for (const [query, label] of [["Local file history", "Local file history…"], ["Reconnect folder", "Reconnect folder…"]]) {
        await page.locator("#palette-query").fill(query);
        await settled();
        assert.equal(await hookRows().filter({ hasText: label }).count(), 1, `${name}: visible ${label} is a palette command`);
      }
      await page.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });
      await page.evaluate(() => {
        document.getElementById("disk-history").hidden = true;
        document.getElementById("reconnect-folder").hidden = true;
      });

      // 9. Routine notices can be dismissed and never occupy a layout row.
      await page.evaluate(() => document.querySelector("#notice .notice-close")?.click());
      assert.equal(await page.locator("#notice").isVisible(), false);

      await page.screenshot({ path: `test-results/carbon-shell-${name}.png` });
      checks.push(`${name}: single header row, ${Math.round(share * 100)}% document surface, compact tabs, palette commands, explorer collapse, document menu, hidden Viewer${mobile ? ", 44px formatting row, soft-keyboard height" : ""}`);
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  return { checks, budgets };
}
