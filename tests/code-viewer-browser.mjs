import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { encode } from "../src/core/validate.js";

/** Any text file opens in the Viewer with highlighting; binaries stay download-only. */
export async function codeViewerFlows(browser) {
  const errors = [], network = [], checks = [];
  const files = new Map([
    ["notes/readme.md", encode("# Notes\n")],
    ["src/tool.py", encode("# <script>window.pwned = 1</script>\ndef greet(name):\n    return '<img src=x onerror=window.pwned=1>' + name\n")],
    ["conf/app.toml", encode("[server]\nport = 8080\n")],
    ["LICENSE", encode("plain text, no extension\n")],
    ["odd/file.constructor", encode("def f(): pass\n")],
    ["odd/file.__proto__", encode("def f(): pass\n")],
    ["odd/file.toString", encode("def f(): pass\n")],
    ["odd/file.hasOwnProperty", encode("def f(): pass\n")],
    // 131,072 characters but ~384 KiB: over the 256 KiB highlighting cap by bytes, under it by .length.
    ["big/cjk.py", encode("漢".repeat(131072))],
    ["data/blob.bin", new Uint8Array([0, 1, 2, 3, 255, 254, 0, 9])],
  ]);
  const fixture = resolve("test-results/code-viewer-folder");
  for (const [p, bytes] of files) {
    await mkdir(dirname(resolve(fixture, p)), { recursive: true });
    await writeFile(resolve(fixture, p), bytes);
  }
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (/^https?:/.test(r.url())) network.push(r.url()); });
  page.on("dialog", (d) => d.accept());
  const idle = () => page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") !== "true");
  try {
    await page.goto(pathToFileURL(resolve("dist/carbon.html")).href);
    await page.waitForFunction(() => document.querySelector("#notice").textContent !== "Opening local workspace…");
    await page.locator("#folders").setInputFiles(fixture);
    await page.locator("#dialog-accept").click();
    await page.waitForFunction(() => !document.querySelector("#dialog").open);
    await idle();
    const view = async (p) => {
      await page.getByRole("button", { name: `Open ${p} in Viewer`, exact: true }).click();
      await idle();
    };
    await view("src/tool.py");
    assert.equal(await page.locator("#viewer-path").textContent(), "src/tool.py");
    assert.ok(await page.locator("#viewer-content .code-body .hljs-keyword").count() > 0, "python keywords highlighted");
    assert.ok(await page.locator("#viewer-content .code-body [class*=hljs-]").count() > 2);
    assert.equal(await page.locator("#viewer-content script, #viewer-content img").count(), 0);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.match(await page.locator("#viewer-content .code-body").textContent(), /<script>window\.pwned = 1<\/script>/);
    assert.equal((await page.locator("#viewer-content .code-gutter").textContent()).trim(), "1\n2\n3");
    assert.match(await page.locator("#viewer-content .hint").first().textContent(), /Python · 3 lines · read-only/);
    assert.equal(await page.locator("#viewer-content .code-gutter").getAttribute("aria-hidden"), "true");
    checks.push("python opens in Viewer with hljs spans, line numbers and no live markup");

    await view("conf/app.toml");
    assert.equal(await page.locator("#viewer-path").textContent(), "conf/app.toml");
    assert.ok(await page.locator("#viewer-content .code-body [class*=hljs-]").count() > 0, "toml highlighted via ini grammar");
    assert.match(await page.locator("#viewer-content .code-body").textContent(), /port = 8080/);
    checks.push("toml opens in Viewer highlighted");

    await view("LICENSE");
    assert.equal(await page.locator("#viewer-content .code-body [class*=hljs-]").count(), 0, "unknown extension is plain");
    assert.match(await page.locator("#viewer-content .hint").first().textContent(), /Plain text/);
    checks.push("unknown extension renders as plain text");

    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      await view(`odd/file.${name}`);
      assert.equal(await page.locator("#viewer-path").textContent(), `odd/file.${name}`);
      assert.equal(await page.locator("#viewer-content .code-body [class*=hljs-]").count(), 0, `${name} is plain`);
      assert.match(await page.locator("#viewer-content .hint").first().textContent(), /Plain text/);
      assert.match(await page.locator("#viewer-content .code-body").textContent(), /def f\(\): pass/);
    }
    checks.push("extensions named like inherited object properties render as plain text");

    await view("big/cjk.py");
    assert.equal(await page.locator("#viewer-content .code-body [class*=hljs-]").count(), 0, "multibyte source over the byte cap is not highlighted");
    assert.match(await page.locator("#viewer-content .hint").first().textContent(), /Python · 1 line · read-only source · highlighting skipped above 256 KiB\./);
    checks.push("a multibyte source over 256 KiB by bytes skips highlighting");

    assert.equal(await page.getByRole("button", { name: "Open data/blob.bin in Viewer", exact: true }).count(), 0);
    await page.locator('#tree button[title="data/blob.bin"]').click();
    await page.locator("#dialog-title").filter({ hasText: "Asset" }).waitFor();
    assert.equal(await page.locator("#dialog-content .code-preview").count(), 0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download Asset", exact: true }).click();
    assert.deepEqual(new Uint8Array(await readFile(await (await download).path())), files.get("data/blob.bin"));
    await page.locator("#dialog-cancel").click();
    await idle();
    checks.push("binary has no View button and stays download-only");
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
  } finally {
    await context.close();
  }
  return { checks, pageErrors: errors, networkRequests: network };
}
