import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { bundle, castkitAssets } from "../scripts/build.mjs";
test("single-file build is reproducible, has no runtime imports and matches its CSP hash", async () => {
  execFileSync(process.execPath, ["scripts/build.mjs"]);
  const first = await readFile("dist/carbon.html", "utf8");
  execFileSync(process.execPath, ["scripts/build.mjs"]);
  const second = await readFile("dist/carbon.html", "utf8");
  assert.equal(first, second);
  assert.ok(!/__JS__|__CSS__|__CSP__|__LICENSES__/.test(first));
  const scripts = [...first.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const hash = createHash("sha256").update(scripts[0][1]).digest("base64");
  assert.ok(first.includes(`script-src 'sha256-${hash}'`));
  assert.ok(!/<script[^>]+src=|<link[^>]+href=/.test(first));
  assert.ok(!/\bimport\s*\(/.test(scripts[0][1]));
  assert.ok(first.includes("img-src blob:;"));
  assert.ok(first.includes("connect-src 'none'"));
  assert.ok(first.includes("third-party-licenses"));
  // Raised from 1,000,000 for the carbon-vfs workspaces (RFC #25 rev 3 §6), to 1,030,000 for the A2.1 text
  // inspector (#29: about 11 KB of dependency-free inspection code, markers and dialogs; the CodeMirror search
  // panel measured a further 15-19 KB and was deferred), then to 1,050,000 for the A3 virtual-first linked
  // folders (#31: source.js, the Folder changes / Compare dialogs, Sync file and its guards). Measured on the
  // built artifact: A2 1,012,303; A2.1 alone 1,025,239 (+12,936); A3 alone 1,035,028 (+22,725); combined
  // 1,048,002 (the two deltas add up within 38 bytes); 1,048,893 after the integration review fixes. No new dependency; about 2 KB of headroom is left on
  // purpose so the next feature has to revisit this budget.
  assert.ok(Buffer.byteLength(first) < 1_050_000, "Review the offline HTML size budget before adding editor extensions (shell + linked folders + disk history + highlight.js grammars for the code Viewer + carbon-vfs workspaces + text inspector + source observation/sync: ~1,048 KB)");
  for (const name of ["@codemirror/view", "@codemirror/state", "@lezer/common", "@lezer/markdown", "style-mod", "w3c-keyname"]) {
    assert.ok(first.includes(name), `Missing runtime license notice: ${name}`);
  }
});
test("castkit-assets.json is regenerated identically from the Cast Kit sources", async () => {
  const before = await readFile("src/carbon/castkit-assets.json", "utf8");
  execFileSync(process.execPath, ["scripts/build.mjs"]);
  const after = await readFile("src/carbon/castkit-assets.json", "utf8");
  assert.equal(before, after);
  assert.equal(after, JSON.stringify(await castkitAssets(), null, 2) + "\n");
  const assets = JSON.parse(after);
  assert.deepEqual(Object.keys(assets), ["playbooks", "sources", "contract", "bootstrap"]);
  assert.deepEqual(Object.keys(assets.playbooks), [
    "Research",
    "Planning",
    "Investigation",
    "Report generation",
    "Critical review",
    "Entity reconciliation",
  ]);
  for (const [name, source] of Object.entries(assets.sources)) {
    assert.match(source, /^builtin:[a-z-]+$/);
    assert.equal(
      assets.playbooks[name],
      await readFile(`cast-kit/playbooks/${source.slice("builtin:".length)}.md`, "utf8"),
    );
  }
  assert.equal(assets.contract, await readFile("cast-kit/operating-contract-v0.1.md", "utf8"));
  assert.equal(assets.bootstrap, await readFile("cast-kit/bootstrap.md", "utf8"));
});
test("the distributable embeds the bootstrap, contract and Playbooks; the controller bundle is identical with or without cast-kit/node_modules", async () => {
  // The controllers are part of app.js now, so the shipped HTML itself must carry the Cast
  // Kit assets the Dispatch wizard embeds into every Cast.
  const dist = await readFile("dist/carbon.html", "utf8");
  const assets = JSON.parse(await readFile("src/carbon/castkit-assets.json", "utf8"));
  const firstLine = (s) => s.split("\n").find((l) => l.trim());
  assert.ok(dist.includes(firstLine(assets.bootstrap)));
  assert.ok(dist.includes(firstLine(assets.contract)));
  assert.ok(dist.includes(firstLine(assets.playbooks.Planning.replace(/^---[\s\S]*?---\n/, ""))));
  assert.ok(dist.includes("envoy.cast/v0.1") && dist.includes("envoy.return/v0.1"));
  const stdin = {
    contents:
      'import assets from "./src/carbon/castkit-assets.json";\n' +
      'import { createDispatchController } from "./src/carbon/controller/dispatch.js";\n' +
      'import { createReturnController } from "./src/carbon/controller/return.js";\n' +
      "globalThis.__probe = [assets, createDispatchController, createReturnController];\n",
    resolveDir: process.cwd(),
    loader: "js",
  };
  const nested = "cast-kit/node_modules",
    aside = "cast-kit/node_modules.build-test";
  const present = await access(nested).then(
    () => true,
    () => false,
  );
  const withNested = await bundle({ stdin });
  // The pinned yaml library must be bundled exactly once (from the root install): the
  // controller bundle repeats one of its message strings no more often than yaml alone does.
  const yamlOnly = await bundle({
    stdin: { contents: 'import * as y from "yaml"; globalThis.__y = y;', resolveDir: process.cwd(), loader: "js" },
  });
  const marker = /Map keys must be unique/g;
  assert.ok((yamlOnly.match(marker) || []).length > 0);
  assert.equal((withNested.match(marker) || []).length, (yamlOnly.match(marker) || []).length);
  if (present) await rename(nested, aside);
  try {
    const withoutNested = await bundle({ stdin });
    assert.equal(withNested, withoutNested);
  } finally {
    if (present) await rename(aside, nested);
  }
});
