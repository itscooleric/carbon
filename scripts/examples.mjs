/** Generate public demonstration archives and a fresh dispatch. Usage: npm run examples. */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { Stack } from "../src/core/stack.js";
import { writeTar } from "../src/archives/tar.js";
import { gzip } from "../src/archives/gzip.js";
import { dispatch } from "../src/core/handoff.js";
const root = "examples/supplier-lead-times.stack";
await mkdir(root + "/assets", { recursive: true });
await writeFile(
  root + "/assets/example-marker.bin",
  Uint8Array.from({ length: 256 }, (_, i) => i),
);
const files = [];
async function walk(dir, prefix = "") {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const p = prefix + item.name;
    if (item.isDirectory()) await walk(dir + "/" + item.name, p + "/");
    else files.push([p, new Uint8Array(await readFile(dir + "/" + item.name))]);
  }
}
await walk(root);
const stack = new Stack(files),
  tar = writeTar(stack);
await writeFile(root + ".tar", tar);
await writeFile(root + ".tar.gz", await gzip(tar));
await writeFile(
  "examples/supplier-lead-times.handoff.md",
  dispatch(stack).text,
);
console.log(
  "Generated complete public sample archives and current handoff framing.",
);
