import { editorText, fillEditor } from "./editor-browser-helpers.mjs";
/** Browser regressions for themes, creation, review fixes and export status.
 * Invoked by tests/browser.mjs against the built, offline file:// distributable.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readTar } from "../src/archives/tar.js";
import { gunzip } from "../src/archives/gzip.js";
import { entry } from "../src/core/entries.js";
import { newStack } from "../src/core/stack.js";
import { encode } from "../src/core/validate.js";
import { writeTar } from "../src/archives/tar.js";

/**
 * Click a toolbar button that lives inside an Import ▾ / Export Stack ▾ menu: open the
 * enclosing <details> first, then click the button (which closes the menu again).
 * @param {import("playwright").Page} page
 * @param {string} id button id without "#"
 */
export async function menuClick(page, id) {
  const menu = await page.evaluate(
    (id) => document.getElementById(id).closest("details")?.id || null,
    id,
  );
  if (menu) {
    const open = await page.evaluate((m) => document.getElementById(m).open, menu);
    if (!open) await page.locator(`#${menu} summary`).click();
    await page.waitForSelector(`#${menu}[open]`);
  }
  await page.locator("#" + id).click();
  if (menu)
    await page.waitForFunction((m) => !document.getElementById(m).open, menu);
}

export async function refinements(browser) {
  const context = await browser.newContext({
    offline: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    timezoneId: "America/Los_Angeles",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [],
    network = [],
    contrasts = [],
    benchmarks = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) network.push(r.url());
  });
  page.on("dialog", (d) => d.accept());
  const ready = () =>
    page.waitForFunction(
      () =>
        document.getElementById("notice").textContent !==
        "Opening local workspace…",
    );
  const accept = async () => {
    await page.locator("#dialog-accept").click();
    await page.waitForFunction(
      () =>
        !document.getElementById("dialog").open &&
        document.getElementById("workspace").getAttribute("aria-busy") !== "true",
    );
  };
  const upload = async (name, buffer) =>
    page
      .locator("#files")
      .setInputFiles({
        name,
        mimeType: "application/octet-stream",
        buffer: Buffer.from(buffer),
      });
  const readDownload = async (id, acceptDialog = false) => {
    await menuClick(page, id);
    if (acceptDialog) {
      const event = page.waitForEvent("download");
      await accept();
      return readFile(await (await event).path());
    }
  };
  const checkContrast = async (theme, selectors) => {
    const result = await page.evaluate((selectors) => {
      const rgb = (value) => value.match(/[\d.]+/g)?.map(Number) || [];
      const lum = (c) =>
        c
          .slice(0, 3)
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => {
        const x = lum(a),
          y = lum(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const samples = [];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (!el.getClientRects().length) continue;
          const style = getComputedStyle(el);
          let parent = el,
            bg;
          while (parent) {
            const candidate = rgb(getComputedStyle(parent).backgroundColor);
            if (candidate.length === 3 || candidate[3] > 0) {
              bg = candidate;
              break;
            }
            parent = parent.parentElement;
          }
          samples.push({
            selector,
            text: el.textContent.slice(0, 60),
            ratio: ratio(rgb(style.color), bg || [255, 255, 255]),
          });
        }
      }
      return samples;
    }, selectors);
    assert.ok(result.length > 0);
    for (const sample of result)
      assert.ok(sample.ratio >= 4.5, `${theme}: ${JSON.stringify(sample)}`);
    contrasts.push({
      theme,
      samples: result.length,
      minTextRatio: Math.min(...result.map((s) => s.ratio)),
    });
  };
  try {
    await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
    await ready();
    assert.equal(await page.locator("#theme").inputValue(), "system");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    // First load is Scratch with one open note (carbon-vfs); an empty Stack is one explicit step away.
    assert.equal(await page.locator("#stack-title").textContent(), "Scratch");
    assert.match(await page.locator("#current-path").textContent(), /^\d{4}-\d{2}-\d{2}\.md$/);
    await menuClick(page, "new-stack");
    await page.locator("#dialog input").waitFor();
    await page.locator("#dialog-accept").click();
    await page.waitForFunction(() => !document.getElementById("dialog").open && document.getElementById("workspace").getAttribute("aria-busy") !== "true");
    assert.match(
      await page.locator("#stack-title").textContent(),
      /^stack-\d{8}-[a-f0-9]{8}$/,
    );
    assert.match(
      await page.locator("#preview").textContent(),
      /Your notebook starts here/,
    );
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "light",
    );
    await page.locator("#theme").selectOption("dark");
    await page.reload();
    await ready();
    assert.equal(await page.locator("#theme").inputValue(), "dark");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.locator("#theme").selectOption("light");
    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "light",
    );
    await page.reload();
    await ready();
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "light",
    );
    await page.locator("#theme").selectOption("system");
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "light",
    );
    assert.equal(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
      true,
    );
    assert.equal(
      await page
        .locator("button")
        .first()
        .evaluate((el) => getComputedStyle(el).transitionDuration),
      "0s",
    );

    // Freeze the browser clock on a date whose UTC calendar day is different.
    await page.clock.install({ time: new Date("2026-10-20T03:30:00Z") });
    const paths = [];
    for (const [kind, count] of [
      ["note", 3],
      ["research", 2],
      ["mission", 2],
    ]) {
      for (let n = 1; n <= count; n++) {
        await page.locator("#new-entry").click();
        await page.locator("#dialog select").selectOption(kind);
        const p = `entries/${kind}-20261019-${String(n).padStart(3, "0")}.md`;
        assert.equal(await page.locator("#dialog input").inputValue(), p);
        await accept();
        paths.push(p);
        assert.equal(await page.locator("#current-path").textContent(), p);
      }
    }
    // Duplicate custom names stay in the dialog; the existing Entry remains unchanged.
    await page.locator("#new-entry").click();
    await page.locator("#dialog input").fill(paths[0].toUpperCase());
    await page.locator("#dialog-accept").click();
    assert.equal(await page.locator("#dialog").isVisible(), true);
    assert.match(
      await page.locator("#dialog-error").textContent(),
      /Already exists/,
    );
    for (const theme of ["dark", "light"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await checkContrast(theme + " dialog", [
        "#dialog h2",
        "#dialog label",
        "#dialog input",
        "#dialog select",
        "#dialog button",
        "#dialog .hint",
        "#dialog-error",
      ]);
    }
    await page.locator("#dialog input").fill("entries/custom-question.md");
    await page.locator("#dialog select").selectOption("research");
    assert.equal(
      await page.locator("#dialog input").inputValue(),
      "entries/custom-question.md",
    );
    await accept();
    paths.push("entries/custom-question.md");
    for (let n = 1; n <= 2; n++) {
      await page.locator("#new-folder").click();
      assert.equal(
        await page.locator("#dialog input").inputValue(),
        `entries/folder-20261019-00${n}`,
      );
      await accept();
    }
    await upload("horizontal-rule.md", "---\n# Ordinary heading\nBody");
    await accept();
    await page
      .locator('#tree button[title="entries/horizontal-rule.md"]')
      .click();
    assert.equal(await page.locator("#preview hr").count(), 1);
    assert.equal(
      await page.locator("#preview h1").textContent(),
      "Ordinary heading",
    );
    const visualPath = paths[0];
    await page.locator(`#tree button[title="${visualPath}"]`).click();
    const original = await editorText(page);
    const text =
      original +
      '\n## Working notes\n\nA portable place for sources, questions, and decisions.\n\n> Save an archive before sharing a handoff.\n\n```javascript\n// Keep stable IDs when moving Entries.\nconst note = { title: "Research", revision: 2 };\n```\n\n' +
      Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n");
    await fillEditor(page, text);
    await page.waitForSelector("#preview .hljs-keyword");
    await page.locator("#save-entry").click();
    await page.waitForFunction(
      () => document.getElementById("save-entry").disabled,
    );
    for (const theme of ["dark", "light"]) {
      await page.locator("#theme").selectOption(theme);
      await checkContrast(theme, [
        "header button",
        "header summary",
        ".statusbar select",
        ".statusbar button",
        ".brand b",
        ".crumb",
        ".document-tabs [role=tab]",
        "#stack-title",
        "#stack-meta",
        "#stack-status",
        ".hint",
        "#search",
        "#tree button",
        "#editor",
        "#editor-status",
        "#preview p",
        "#preview h1",
        "#preview h2",
        "#preview code span",
        "#links",
        ".bottom",
      ]);
      for (const [menu, id] of [
        ["menu-import", "import"],
        ["menu-export", "export-gzip"],
      ]) {
        await page.locator(`#${menu} summary`).hover();
        await checkContrast(theme + " hover", [`#${menu} summary`]);
        await page.locator(`#${menu} summary`).click();
        await page.waitForSelector(`#${menu}[open]`);
        await page.locator("#" + id).hover();
        await checkContrast(theme + " hover", ["#" + id, ".menu-label"]);
        await page.keyboard.press("Escape");
        await page.waitForFunction(
          (m) => !document.getElementById(m).open,
          menu,
        );
      }
      await checkContrast(theme + " toolbar", [
        "#toolbar-selection",
        "#import-return",
        "#dispatch",
        "#dispatch-this",
      ]);
      await page.locator("#search").focus();
      const focus = await page
        .locator("#search")
        .evaluate((el) => ({
          width: getComputedStyle(el).outlineWidth,
          style: getComputedStyle(el).outlineStyle,
        }));
      assert.equal(focus.width, "3px");
      assert.equal(focus.style, "solid");
      await page.locator("#search").fill("no-such-entry");
      assert.match(await page.locator("#tree").textContent(), /No matches/);
      await page.locator("#search").fill("");
      await page.locator("#editor").evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({
        path: `test-results/carbon-${theme}.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 800, height: 650 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight,
        ),
        "Notebook must fit the desktop viewport vertically",
      );
      const inViewport = async (selector) => {
        const box = await page.locator(selector).boundingBox();
        assert.ok(
          box &&
            box.width > 0 &&
            box.height > 20 &&
            box.x >= 0 &&
            box.x + box.width <= 801 &&
            box.y >= 0 &&
            box.y + box.height <= 650,
          `Small window control ${selector}`,
        );
      };
      for (const selector of [
        "#theme",
        "#menu-import summary",
        "#menu-export summary",
        "#files-toggle",
        "#palette-launcher",
        "#menu-more summary",
        "#menu-doc summary",
        "#toggle-split",
        "#save-entry",
        "#dispatch",
        "#editor",
        "#preview",
      ])
        await inViewport(selector);
      // Menu items open within the small window too.
      for (const [menu, ids] of [
        ["menu-import", ["import", "folder-import", "open-folder"]],
        ["menu-export", ["export-tar", "export-gzip", "export-handoff"]],
      ]) {
        await page.locator(`#${menu} summary`).click();
        await page.waitForSelector(`#${menu}[open]`);
        for (const id of ids) await inViewport("#" + id);
        await page.keyboard.press("Escape");
        await page.waitForFunction(
          (m) => !document.getElementById(m).open,
          menu,
        );
      }
      await page.screenshot({
        path: `test-results/carbon-${theme}-800.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    // Unconfirmed downloads remain visibly pending, including after reload.
    const archiveEvent = page.waitForEvent("download");
    await menuClick(page, "export-gzip");
    const exported = readTar(
      await gunzip(
        new Uint8Array(await readFile(await (await archiveEvent).path())),
      ),
    );
    for (const p of paths) assert.ok(exported.files.has(p));
    const ids = paths.map((p) => entry(exported.text(p)).data.id);
    assert.equal(new Set(ids).size, paths.length);
    assert.equal(
      exported.text("entries/horizontal-rule.md"),
      "---\n# Ordinary heading\nBody",
    );
    assert.ok(exported.directories.has("entries/folder-20261019-002"));
    assert.match(
      await page.locator("#stack-status").textContent(),
      /Download requested/,
    );
    assert.match(
      await page.locator("#persistence").textContent(),
      /last archive export: revision \d+/,
    );
    await page.reload();
    await ready();
    assert.equal(await page.locator("#confirm-export").isVisible(), true);
    await page.locator("#confirm-export").click();
    await page.waitForFunction(() =>
      document
        .getElementById("stack-status")
        .textContent.includes("confirmed by you"),
    );
    await page
      .locator(`#tree input[aria-label="Include ${visualPath} in Needlecast"]`)
      .check();
    const packet = (await readDownload("export-handoff", true)).toString();
    await upload(
      "metadata.handoff.md",
      packet.replace("kind: note", "kind: mission"),
    );
    await page.waitForFunction(() =>
      document.getElementById("notice").textContent.includes("frontmatter"),
    );
    assert.equal(await page.locator("#dialog").isVisible(), false);
    const returned = packet
      .replace("Line 2\n", "Changed first\n")
      .replace("Line 45\n", "Changed second\n");
    await upload("return.handoff.md", returned);
    await page.waitForSelector(".diff .added");
    assert.equal(await page.locator(".diff .removed").count(), 2);
    assert.equal(await page.locator(".diff .added").count(), 2);
    assert.ok((await page.locator(".diff .hunk").count()) > 0);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await checkContrast(theme + " diff", [
        ".diff .removed",
        ".diff .added",
        ".diff .context",
        ".diff .hunk",
      ]);
      await page.screenshot({
        path: `test-results/carbon-${theme}-diff.png`,
        fullPage: true,
      });
    }
    await page.locator("#dialog-cancel").click();
    // Budget fallback is visibly complete, not a misleading mass-deletion diff.
    const large = packet.replace(
      text,
      original +
        Array.from({ length: 400 }, (_, i) => `Replacement ${i}`).join("\n"),
    );
    await upload("large-return.handoff.md", large);
    await page.waitForSelector("#dialog[open]");
    assert.match(
      await page.locator("#dialog").textContent(),
      /complete original and proposed/,
    );
    assert.equal(
      await page
        .locator("#dialog h4")
        .allTextContents()
        .then((v) => v.join(",")),
      "Original,Proposed",
    );
    assert.equal(await page.locator("#dialog pre").count(), 2);
    await page.locator("#dialog-cancel").click();
    const oldTitle = await page.locator("#stack-title").textContent();
    await menuClick(page, "new-stack");
    assert.match(
      await page.locator("#dialog input").inputValue(),
      /^stack-20261019-[a-f0-9]{8}$/,
    );
    assert.notEqual(await page.locator("#dialog input").inputValue(), oldTitle);
    await page.locator("#dialog input").fill(oldTitle);
    await page.locator("#dialog-accept").click();
    assert.match(await page.locator("#dialog-error").textContent(), /already/);
    await page.locator("#dialog input").fill("Field research");
    await accept();
    assert.equal(
      await page.locator("#stack-title").textContent(),
      "Field research",
    );
    assert.match(await page.locator("#stack-id").textContent(), /^stk-/);

    // Measure a synthetic link workload at the file-count cap. Not an Asset/memory benchmark.
    for (const count of [500, 1998]) {
      const synthetic = newStack(`Link workload ${count}`).change({
        writes: new Map(
          Array.from({ length: count }, (_, i) => [
            `entries/note-${i}.md`,
            encode(
              `---\nid: ent-${i}\n---\n# Note ${i}\n[[ent-${(i + 1) % count}]]\n`,
            ),
          ]),
        ),
      });
      await upload("benchmark.stack.tar", writeTar(synthetic));
      const start = performance.now();
      await accept();
      const openMs = performance.now() - start;
      const navigation = performance.now();
      await page.locator('#tree button[title="entries/note-1.md"]').click();
      await page.waitForFunction(
        () =>
          document.getElementById("current-path").textContent ===
          "entries/note-1.md",
      );
      benchmarks.push({
        entries: count,
        openAndRenderMs: openMs,
        navigateMs: performance.now() - navigation,
      });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
  } finally {
    await context.close();
  }
  const denied = await browser.newContext({
    offline: true,
    colorScheme: "dark",
  });
  await denied.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Denied", "SecurityError");
      },
    }),
  );
  const deniedPage = await denied.newPage();
  await deniedPage.goto(pathToFileURL(resolve("dist/carbon.html")).href);
  await deniedPage.waitForFunction(() =>
    document.getElementById("theme-status").textContent.includes("unavailable"),
  );
  await deniedPage.locator("#theme").selectOption("light");
  assert.equal(
    await deniedPage.locator("html").getAttribute("data-theme"),
    "light",
  );
  assert.match(
    await deniedPage.locator("#theme-status").textContent(),
    /could not be saved/,
  );
  await denied.close();
  const ui = await dispatchUi(browser);
  return {
    dispatchUi: ui,
    tests: [
      "system theme and live changes",
      "explicit dark/light persistence across reload",
      "denied theme storage fallback",
      "local-date typed names and repeated creation",
      "case collision keeps dialog open",
      "custom path survives template change",
      "generated files and IDs survive TAR.GZ",
      "plain leading thematic break import/preview",
      "two themes text contrast >=4.5:1",
      "visible focus and reduced motion",
      "800x650 desktop layout",
      "unconfirmed export state survives reload",
      "frontmatter Return refusal",
      "separated diff hunks and full-text fallback",
      "unique Stack suggestions and custom title",
      "footer shows the last archive export revision",
      ...ui.tests,
    ],
    contrasts: [...contrasts, ...ui.contrasts],
    benchmarks,
    networkRequests: [...network, ...ui.networkRequests],
    pageErrors: [...errors, ...ui.pageErrors],
  };
}

/**
 * UI smoke pass for the Dispatch / Return surfaces. It exercises toolbar menus, the
 * docked drawer, the review mode shell, contrast in both themes and layout at three
 * viewports. It asserts only on UI behavior that holds regardless of the controller
 * implementation; domain outcomes (counts, revisions, checks) are covered elsewhere.
 * Review-mode screenshots are taken only when a staged Return could be produced.
 */
async function dispatchUi(browser) {
  const context = await browser.newContext({
    offline: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [],
    network = [],
    contrasts = [],
    screenshots = [];
  let reviewReached = false;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) network.push(r.url());
  });
  const shot = async (name) => {
    const file = `test-results/carbon-ui-${name}.png`;
    await page.screenshot({ path: file });
    screenshots.push(file);
  };
  const checkContrast = async (label, selectors) => {
    const result = await page.evaluate((selectors) => {
      const rgb = (value) => value.match(/[\d.]+/g)?.map(Number) || [];
      const lum = (c) =>
        c
          .slice(0, 3)
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => {
        const x = lum(a),
          y = lum(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const samples = [];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (!el.getClientRects().length || !el.textContent.trim()) continue;
          const style = getComputedStyle(el);
          let parent = el,
            bg;
          while (parent) {
            const candidate = rgb(getComputedStyle(parent).backgroundColor);
            if (candidate.length === 3 || candidate[3] > 0) {
              bg = candidate;
              break;
            }
            parent = parent.parentElement;
          }
          samples.push({
            selector,
            text: el.textContent.trim().slice(0, 40),
            ratio: ratio(rgb(style.color), bg || [255, 255, 255]),
          });
        }
      }
      return samples;
    }, selectors);
    for (const sample of result)
      assert.ok(sample.ratio >= 4.5, `${label}: ${JSON.stringify(sample)}`);
    contrasts.push({
      theme: label,
      samples: result.length,
      minTextRatio: result.length ? Math.min(...result.map((s) => s.ratio)) : null,
    });
  };
  const ready = () =>
    page.waitForFunction(
      () =>
        document.getElementById("notice").textContent !==
        "Opening local workspace…",
    );
  const accept = async () => {
    await page.locator("#dialog-accept").click();
    await page.waitForFunction(
      () =>
        !document.getElementById("dialog").open &&
        document.getElementById("workspace").getAttribute("aria-busy") !== "true",
    );
  };
  const drawerVisible = () =>
    page.waitForFunction(() => !document.getElementById("drawer").hidden);
  const drawerHidden = () =>
    page.waitForFunction(() => document.getElementById("drawer").hidden);
  const setTheme = (theme) =>
    page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
  const THEMES = ["dark", "light"];
  const SIZES = [
    [1440, 900],
    [1000, 700],
    [800, 650],
  ];
  const UI_SELECTORS = [
    ".chip",
    ".dcard .r1",
    ".dcard .obj",
    ".tag",
    "#toolbar-selection",
    ".steps button",
    ".dsub",
    ".dbody .flabel",
    ".dbody .hint",
    ".dbody .callout",
    ".dbody .check",
    ".dbody .preset",
    ".dbody .ctx label",
    ".dbody .ctx .sz",
    ".dbody .pb .src",
    ".dbody .summary dt",
    ".dbody .summary dd",
    ".dbody .seg label",
    ".dbody .consent b",
    ".dbody .consent small",
    ".dfoot button",
    ".dbody .export-row button",
    ".dbody .err",
    ".timeline li",
    ".rbanner h2",
    ".rbanner .facts",
    ".rfile .p",
    ".rfile .m",
    ".op",
    ".dhdr .p",
    ".udiff td",
    ".udiff tr.fold button",
    ".rside h3",
    ".rside p",
    ".rside li",
    ".checks li",
    ".rfoot .note",
    ".rfoot button",
    ".notice-text",
    "button.notice-action",
    "#persistence",
  ];
  try {
    await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
    await ready();
    assert.equal(await page.locator("#review").isHidden(), true);
    assert.equal(await page.locator("#drawer").isHidden(), true);
    assert.match(await page.locator("#persistence").textContent(), /revision 0/);
    // Scratch never offers a question (Dispatch needs a Stack); start from a pristine empty Stack.
    assert.equal(await page.locator("#dispatch").isDisabled(), true);
    await menuClick(page, "new-stack");
    await page.locator("#dialog input").waitFor();
    await page.locator("#dialog-accept").click();
    await page.waitForFunction(() => !document.getElementById("dialog").open && document.getElementById("workspace").getAttribute("aria-busy") !== "true");
    assert.match(await page.locator("#persistence").textContent(), /revision 0/);
    // Empty Stack offers "Ask a question…"; it opens the drawer and Esc keeps the draft.
    await page.getByRole("button", { name: "↗ Ask a question…" }).click();
    await drawerVisible();
    await page.keyboard.press("Escape");
    await drawerHidden();
    assert.equal(await page.locator("#dispatches .dcard").count(), 1);
    // Build a small Stack to dispatch from.
    for (const [kind, p] of [
      ["mission", "entries/mission.md"],
      ["note", "entries/plan.md"],
      ["note", "entries/notes.md"],
    ]) {
      await page.locator("#new-entry").click();
      await page.locator("#dialog select").selectOption(kind);
      await page.locator("#dialog input").fill(p);
      await accept();
    }
    await page.locator("#files").setInputFiles({
      name: "chart.png",
      mimeType: "image/png",
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
    });
    await accept();
    assert.equal(await page.locator("#assets-section").isVisible(), true);
    assert.match(await page.locator("#assets").textContent(), /assets\/chart\.png/);
    // Dirty tag in the tree.
    await page.locator('#tree button[title="entries/notes.md"]').click();
    await fillEditor(page, "# Notes\n\nunsaved line\n");
    await page.waitForSelector('#tree button[title="entries/notes.md"] .tag.dirty');
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await accept();
    await page
      .locator('#tree input[aria-label="Include entries/plan.md in Needlecast"]')
      .check();
    assert.match(await page.locator("#toolbar-selection").textContent(), /1 Entry checked/);
    // Toolbar menus are keyboard operable: Enter opens, ArrowDown moves, Escape closes.
    await page.locator("#menu-import summary").focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#menu-import[open]");
    // Scratch notes and Workspaces… lead the Open menu (carbon-vfs workspaces).
    for (const id of ["open-scratch", "workspaces", "open-files", "import"]) {
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.evaluate(() => document.activeElement.id), id);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("menu-import").open);
    assert.equal(
      await page.evaluate(() => document.activeElement.tagName),
      "SUMMARY",
    );
    await page.locator("#menu-export summary").click();
    await page.waitForSelector("#menu-export[open]");
    assert.match(await page.locator("#menu-export").textContent(), /Legacy Needlecast/);
    await page.locator("#preview").click();
    await page.waitForFunction(() => !document.getElementById("menu-export").open);
    for (const theme of THEMES) {
      await setTheme(theme);
      await checkContrast(`${theme} notebook ui`, UI_SELECTORS);
    }
    // Open Dispatch with the toolbar button, close with Esc (draft kept), reopen with the shortcut.
    await page.locator("#dispatch").click();
    await drawerVisible();
    await page.waitForFunction(() => document.activeElement.id === "draft-objective");
    assert.equal(await page.locator("#workspace.with-drawer").count(), 1);
    await page.locator("#draft-objective").fill("Summarise the plan and list open questions.");
    await page.waitForFunction(() =>
      document.querySelector("#dispatches .dcard .obj").textContent.includes("Summarise"),
    );
    const cards = await page.locator("#dispatches .dcard").count();
    await page.keyboard.press("Escape");
    await drawerHidden();
    assert.match(await page.locator("#notice").textContent(), /kept in Dispatches/);
    assert.equal(await page.locator("#dispatches .dcard").count(), cards);
    assert.equal(await page.evaluate(() => document.activeElement.id), "dispatch");
    await page.keyboard.press("Control+Shift+D");
    await drawerVisible();
    await page.waitForFunction(() => document.activeElement.id === "draft-objective");
    await page.locator("#draft-objective").fill("Rewrite the plan body with open questions.");
    assert.equal(await page.locator("#drawer-steps button").count(), 5);
    assert.equal(
      await page.locator('#drawer-steps button[aria-current="step"]').textContent().then((t) => t.trim()),
      "1Assignment",
    );
    // Step buttons are keyboard navigable (Tab/Arrow + Enter).
    await page.locator("#drawer-steps button").first().focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector('#drawer-steps [aria-current="step"]').textContent.includes("Context"),
    );
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-current")), "step");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), "3Playbooks");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector('#drawer-steps [aria-current="step"]').textContent.includes("Playbooks"),
    );
    assert.match(await page.locator("#drawer-body").textContent(), /of 8/);
    // Cards open the drawer for their Dispatch; the draft card is the current one.
    await page.locator("#drawer-next").click();
    await page.waitForFunction(
      () => document.querySelector('#drawer-steps [aria-current="step"]').textContent.includes("Deliverables"),
    );
    assert.match(await page.locator("#drawer-body").textContent(), /Carbon has no tool runtime/);
    await page.locator("#drawer-next").click();
    await page.waitForFunction(
      () => document.querySelector('#drawer-steps [aria-current="step"]').textContent.includes("Review"),
    );
    // Consent gating: export buttons stay disabled until the consent box is ticked.
    assert.ok((await page.locator(".export-row button").count()) >= 1);
    for (const b of await page.locator(".export-row button").all())
      assert.equal(await b.isDisabled(), true);
    assert.equal(await page.locator("#drawer-skip").isHidden(), true);
    await page.locator("#draft-consent").click();
    await page.waitForFunction(() => document.getElementById("draft-consent").checked);
    await page.locator("#draft-consent").click();
    await page.waitForFunction(() => !document.getElementById("draft-consent").checked);
    for (const b of await page.locator(".export-row button").all())
      assert.equal(await b.isDisabled(), true);
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      for (const theme of THEMES) {
        await setTheme(theme);
        await shot(`${theme}-${w}x${h}-drawer`);
      }
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `no horizontal scroll with the drawer at ${w}`,
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const theme of THEMES) {
      await setTheme(theme);
      await checkContrast(`${theme} drawer`, UI_SELECTORS);
    }
    // Drawer disappears from the workspace in review mode; try to stage a Return.
    await page.locator("#draft-consent").click();
    await page.waitForFunction(() => document.getElementById("draft-consent").checked);
    let exported = false;
    try {
      await page.waitForFunction(
        () => !document.querySelector(".export-row button").disabled,
        null,
        { timeout: 5000 },
      );
      const event = page.waitForEvent("download", { timeout: 5000 });
      await page
        .locator('.export-row button[data-via="download-md"]')
        .click({ timeout: 5000 });
      await event;
      await page.waitForFunction(
        () => document.getElementById("notice").textContent.includes("Nothing has been sent"),
        null,
        { timeout: 5000 },
      );
      exported = true;
    } catch {}
    if (exported) {
      assert.match(await page.locator("#drawer-chip").textContent(), /Exported · awaiting Return/);
      await menuClick(page, "import-return");
      await page.waitForSelector("#dialog[open]");
      assert.equal(await page.locator("#return-for").inputValue(), "");
      await page.locator("#dialog-accept").click();
      await page.waitForFunction(() => document.getElementById("dialog-error").textContent.length > 0);
      await page.locator("#return-text").fill(
        "# Envoy Cast Return\n\nstatus: complete\nsummary: Smoke-test Return.\n\n# Plan\n\nUpdated body.\n",
      );
      await page.locator("#dialog-accept").click();
      await page
        .waitForFunction(
          () =>
            !document.getElementById("review").hidden ||
            (document.getElementById("dialog").open &&
              document.querySelector("#dialog .err")),
          null,
          { timeout: 10000 },
        )
        .catch(() => {});
      reviewReached = await page.evaluate(() => !document.getElementById("review").hidden);
      if (reviewReached) {
        assert.equal(await page.locator("#workspace").isHidden(), true);
        await page.waitForFunction(() => document.activeElement.id === "review-heading");
        assert.match(await page.locator("#review-banner").textContent(), /Stack unchanged at revision/);
        assert.match(await page.locator("#review-receipt").textContent(), /Carbon checks/);
        assert.match(await page.locator("#review-receipt").textContent(), /do not confirm the content is correct/);
        assert.equal(await page.locator("#review-reject").count(), 1);
        assert.equal(await page.locator("#review-keep").count(), 1);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#review").isHidden(), false);
        for (const [w, h] of SIZES) {
          await page.setViewportSize({ width: w, height: h });
          for (const theme of THEMES) {
            await setTheme(theme);
            await shot(`${theme}-${w}x${h}-review`);
          }
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `no horizontal scroll in review at ${w}`,
          );
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        for (const theme of THEMES) {
          await setTheme(theme);
          await checkContrast(`${theme} review`, UI_SELECTORS);
        }
        await page.locator("#review-keep").click();
        await page.waitForFunction(() => document.getElementById("review").hidden);
        assert.equal(await page.locator("#workspace").isHidden(), false);
        assert.match(await page.locator("#notice").textContent(), /kept pending/);
      } else if (await page.evaluate(() => document.getElementById("dialog").open)) {
        await page.locator("#dialog-cancel").click();
      }
    }
    // Notebook screenshots at every size and theme; the sidebar overlay toggles below 860px.
    if (!(await page.locator("#drawer").isHidden()))
      await page.locator("#drawer-close").click();
    await drawerHidden();
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      for (const theme of THEMES) {
        await setTheme(theme);
        await shot(`${theme}-${w}x${h}-notebook`);
      }
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
        `notebook fits ${w}x${h}`,
      );
    }
    assert.equal(await page.locator("#files-toggle").isVisible(), true);
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await page.locator("#files-toggle").click();
    await page.waitForFunction(() => document.getElementById("sidebar").offsetWidth > 0);
    assert.equal(await page.locator("#files-toggle").getAttribute("aria-expanded"), "true");
    await page.locator("#files-toggle").click();
    await page.waitForFunction(() => document.getElementById("sidebar").offsetWidth === 0);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Desktop: the explorer is docked and collapses with the same toggle.
    assert.equal(await page.locator("#files-toggle").isVisible(), true);
    await page.waitForFunction(() => document.getElementById("sidebar").offsetWidth > 0);
    // aria-expanded follows the media-query change event, which can land a frame after layout.
    await page.waitForFunction(() => document.getElementById("files-toggle").getAttribute("aria-expanded") === "true");
    await page.locator("#files-toggle").click();
    await page.waitForFunction(() => document.getElementById("sidebar").offsetWidth === 0);
    assert.equal(await page.locator("#files-toggle").getAttribute("aria-expanded"), "false");
    await page.locator("#files-toggle").click();
    await page.waitForFunction(() => document.getElementById("sidebar").offsetWidth > 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
  } finally {
    await context.close();
  }
  return {
    tests: [
      "Dispatch drawer opens from #dispatch, Ctrl+Shift+D and the empty-Stack action",
      "Esc closes the drawer and keeps the draft card",
      "step buttons expose aria-current and are keyboard navigable",
      "consent checkbox gates the export buttons",
      "toolbar menus open/close by keyboard and outside click",
      "Assets section and dirty tag in the sidebar",
      "review mode hidden by default; Esc does not exit it" +
        (reviewReached ? "" : " (review not reached with this controller)"),
      "chips, badges, drawer and review text contrast >=4.5:1 in both themes",
      "layout screenshots at 1440x900, 1000x700 and 800x650",
      "sidebar overlay toggle below 860px",
    ],
    reviewReached,
    screenshots,
    contrasts,
    networkRequests: network,
    pageErrors: errors,
  };
}
