/**
 * Reproducibly bundle Carbon into one offline HTML file. Usage: npm run build.
 *
 * Besides the bundle this script regenerates two checked-in JSON inputs before bundling:
 * `src/carbon/templates.json` (Entry templates) and `src/carbon/castkit-assets.json`
 * (Cast Kit starter Playbooks, operating contract and bootstrap text). Both are pretty JSON
 * with a trailing newline so CI can `git diff --exit-code` them.
 *
 * `bundle()` and `yamlAlias` are exported for tests; the build itself runs only when this
 * file is executed directly.
 */
import { build } from "esbuild";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { entry } from "../src/core/entries.js";

/** Repository root (the directory above `scripts/`). */
export const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * esbuild plugin: resolve every `yaml` import from the repository root so Cast Kit's
 * sources bundle the same pinned copy as Carbon, whether or not `cast-kit/node_modules`
 * exists. Without it esbuild would bundle two copies when the nested install is present.
 * @type {import("esbuild").Plugin}
 */
export const yamlAlias = {
  name: "yaml-alias",
  setup(build) {
    build.onResolve({ filter: /^yaml$/ }, (args) => {
      if (args.pluginData === "yaml-alias") return null;
      return build.resolve("yaml", {
        kind: args.kind,
        resolveDir: root,
        pluginData: "yaml-alias",
      });
    });
  },
};

/**
 * Bundle one browser IIFE with Carbon's fixed options (minified, utf8, inline legal
 * comments, `yaml` aliased to the root install). Pure: nothing is written.
 * @param {{entryPoints?: string[], stdin?: import("esbuild").StdinOptions}} input
 *   entry files relative to the repository root, or a stdin entry
 * @returns {Promise<string>} the bundled JavaScript
 */
export async function bundle(input) {
  const result = await build({
    ...input,
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["chrome120", "firefox120", "safari17"],
    minify: true,
    legalComments: "inline",
    charset: "utf8",
    plugins: [yamlAlias],
  });
  return result.outputFiles[0].text;
}

/**
 * Starter Playbooks in their documented order; any other `cast-kit/playbooks/*.md` file is
 * appended in name order. The display name is the frontmatter `title`, else the first `#`
 * heading, else the file basename. The Cast `source` label stays `builtin:<basename>`.
 * @returns {Promise<{playbooks: Record<string,string>, sources: Record<string,string>, contract: string, bootstrap: string}>}
 */
export async function castkitAssets() {
  const order = [
    "research",
    "planning",
    "investigation",
    "report",
    "critical-review",
    "entity-reconciliation",
  ];
  const dir = resolve(root, "cast-kit/playbooks");
  const names = (await readdir(dir))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort((a, b) => {
      const i = order.indexOf(a),
        j = order.indexOf(b);
      if (i !== -1 || j !== -1)
        return (i === -1 ? order.length : i) - (j === -1 ? order.length : j);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const playbooks = {},
    sources = {};
  for (const base of names) {
    const content = await readFile(resolve(dir, `${base}.md`), "utf8");
    const e = entry(content);
    const title =
      typeof e.data.title === "string" && e.data.title.trim()
        ? e.data.title.trim()
        : (/^#\s+(.+?)\s*$/m.exec(e.body)?.[1] ?? base);
    if (playbooks[title]) throw Error(`Duplicate Playbook title: ${title}`);
    playbooks[title] = content;
    sources[title] = `builtin:${base}`;
  }
  return {
    playbooks,
    sources,
    contract: await readFile(
      resolve(root, "cast-kit/operating-contract-v0.1.md"),
      "utf8",
    ),
    bootstrap: await readFile(resolve(root, "cast-kit/bootstrap.md"), "utf8"),
  };
}

async function main() {
  const templates = {};
  for (const [kind, file] of Object.entries({
    note: "note",
    research: "research",
    requirement: "requirement",
    mission: "mission",
    meeting: "meeting",
    transcript: "transcription",
  }))
    templates[kind] = await readFile(
      resolve(root, `templates/${file}.md`),
      "utf8",
    );
  await writeFile(
    resolve(root, "src/carbon/templates.json"),
    JSON.stringify(templates, null, 2) + "\n",
  );
  await writeFile(
    resolve(root, "src/carbon/castkit-assets.json"),
    JSON.stringify(await castkitAssets(), null, 2) + "\n",
  );
  const js = (await bundle({ entryPoints: ["src/carbon/app.js"] })).replace(
    /<\/script/gi,
    "<\\/script",
  );
  const css = await readFile(resolve(root, "src/carbon/style.css"), "utf8");
  const csp = `default-src 'none'; script-src 'sha256-${createHash("sha256").update(js).digest("base64")}'; style-src 'unsafe-inline'; img-src blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const shell = await readFile(resolve(root, "src/carbon/shell.html"), "utf8");
  const licenses = [
    "Carbon v1 — MIT\n" + (await readFile(resolve(root, "LICENSE"), "utf8")),
  ];
  // Walk all pinned runtime dependencies (including transitive CodeMirror/Lezer
  // packages). Resolve each from its parent; nested versions get their own notice.
  const runtime = new Map();
  async function collect(dir) {
    const pkg = JSON.parse(
      await readFile(resolve(dir, "package.json"), "utf8"),
    );
    const require = createRequire(resolve(dir, "package.json"));
    for (const name of Object.keys(pkg.dependencies || {}).sort()) {
      let dependencyDir = dirname(require.resolve(name));
      let manifest;
      while (dependencyDir !== dirname(dependencyDir)) {
        try {
          const candidate = resolve(dependencyDir, "package.json");
          if (JSON.parse(await readFile(candidate, "utf8")).name === name) {
            manifest = candidate;
            break;
          }
        } catch {}
        dependencyDir = dirname(dependencyDir);
      }
      if (!manifest) throw Error(`Missing package manifest: ${name}`);
      if (!runtime.has(manifest)) {
        const child = JSON.parse(await readFile(manifest, "utf8"));
        runtime.set(manifest, child);
        await collect(dirname(manifest));
      }
    }
  }
  await collect(root);
  for (const [manifest, pkg] of [...runtime].sort((a, b) => {
    const x = `${a[1].name}@${a[1].version}`,
      y = `${b[1].name}@${b[1].version}`;
    return x < y ? -1 : x > y ? 1 : 0;
  })) {
    const name = pkg.name;
    let license;
    for (const f of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
      try {
        license = await readFile(resolve(dirname(manifest), f), "utf8");
        break;
      } catch {}
    }
    if (!license) throw Error(`Missing license: ${name}`);
    licenses.push(`${name} ${pkg.version}\n${license}`);
  }
  const notices = licenses.join("\n\n--------------------\n\n");
  await mkdir(resolve(root, "dist"), { recursive: true });
  await writeFile(resolve(root, "dist/THIRD-PARTY-LICENSES.txt"), notices);
  await writeFile(
    resolve(root, "dist/carbon.html"),
    shell
      .replace("__CSP__", csp)
      .replace("__CSS__", () => css)
      .replace(
        /<script>\s*__JS__;?\s*<\/script>/,
        () => `<script>${js}</script>`,
      )
      .replace("__LICENSES__", () =>
        notices
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;"),
      ),
  );
  console.log(
    `Built dist/carbon.html (${(await readFile(resolve(root, "dist/carbon.html"))).length} bytes)`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
