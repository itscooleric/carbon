import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Stack } from "../src/core/stack.js";
import { sample } from "./helpers.js";
import { encode } from "../src/core/validate.js";
import {
  inspectImage,
  relativeReference,
  resolveLocalFile,
  planImages,
} from "../src/carbon/images/assets.js";
import { writeTar, readTar } from "../src/archives/tar.js";
import { gzip, gunzip } from "../src/archives/gzip.js";
const bytes = (ext) =>
  new Uint8Array(readFileSync(`tests/fixtures/images/grid.${ext}`));

test("bounded raster headers accept PNG/JPEG/WebP and reject unsupported, corrupt and oversized input", () => {
  for (const [ext, type] of [
    ["png", "png"],
    ["jpg", "jpeg"],
    ["webp", "webp"],
  ]) {
    const b = bytes(ext),
      info = inspectImage(b);
    assert.deepEqual([info.type, info.width, info.height], [type, 32, 20]);
    assert.throws(() => inspectImage(b.slice(0, 20)));
  }
  assert.throws(
    () => inspectImage(encode('<svg onload="alert(1)"></svg>')),
    /Only PNG/,
  );
  assert.throws(
    () => inspectImage(new Uint8Array(8 * 1024 * 1024 + 1)),
    /8 MiB/,
  );
  const huge = bytes("png");
  new DataView(huge.buffer).setUint32(16, 8193);
  assert.throws(() => inspectImage(huge), /8192/);
  const bomb = bytes("png");
  new DataView(bomb.buffer).setUint32(16, 8192);
  new DataView(bomb.buffer).setUint32(20, 8192);
  assert.throws(() => inspectImage(bomb), /megapixels/);
  const png = bytes("png");
  png.set(encode("acTL"), 37);
  assert.throws(() => inspectImage(png), /Animated/);
  const webp = bytes("webp");
  new DataView(webp.buffer).setUint32(4, 1, true);
  assert.throws(() => inspectImage(webp), /length/);
  const animated = bytes("webp");
  animated.set(encode("ANIM"), 12);
  assert.throws(() => inspectImage(animated), /Animated/);
});
test("portable references disambiguate relative paths and reject remote/traversal URLs", () => {
  const s = sample().change({
    writes: new Map([
      ["assets/a #().png", bytes("png")],
      ["entries/assets/a #().png", bytes("png")],
    ]),
  });
  const ref = relativeReference("entries/nested/note.md", "assets/a #().png");
  assert.equal(ref, "../../assets/a%20%23%28%29.png");
  assert.equal(
    resolveLocalFile(s, ref, "entries/nested/note.md"),
    "assets/a #().png",
  );
  assert.equal(
    resolveLocalFile(s, "assets/a%20%23%28%29.png", "entries/other.md"),
    null,
  );
  assert.equal(
    resolveLocalFile(s, "./assets/a%20%23%28%29.png", "entries/other.md"),
    "entries/assets/a #().png",
  );
  for (const href of [
    "https://evil/x.png",
    "//evil/x.png",
    "data:image/png;base64,x",
    "blob:fake",
    "../../../../x.png",
    "%2fetc/passwd",
    "%00.png",
    "%ZZ",
    "C:\\x.png",
  ])
    assert.equal(resolveLocalFile(s, href, "entries/other.md"), null, href);
});
test("image plans retain bytes, draft/YAML/CRLF and source selection boundaries with collision-safe names", async () => {
  const s = sample(),
    p = "entries/nested/note.md",
    original = s.text(p),
    offset = original.indexOf("Evidence");
  const plan = planImages(
    s,
    p,
    original,
    { from: offset, to: offset + 8 },
    [bytes("png"), bytes("png")],
    () => "repeat",
  );
  assert.deepEqual(plan.paths, [
    "assets/image-repeat.png",
    "assets/image-repeat-1.png",
  ]);
  assert.equal(s.files.has(plan.paths[0]), false);
  assert.equal(plan.stack.text(p), original);
  assert.ok(plan.draft.startsWith(original.slice(0, offset)));
  assert.ok(plan.draft.endsWith(original.slice(offset + 8)));
  assert.equal(plan.stack.manifest.revision, s.manifest.revision + 1);
  const crlf = "entries/日本語-☃.md";
  const c = planImages(
    s,
    crlf,
    s.text(crlf).replaceAll("\r\n", "\n"),
    { from: 10, to: 10 },
    [bytes("jpg")],
    () => "jpg",
  );
  assert.ok(c.draft.includes("\r\n"));
  const saved = plan.stack.change({
    writes: new Map([[p, encode(plan.draft)]]),
  });
  for (const archive of [
    writeTar(saved),
    await gunzip(await gzip(writeTar(saved))),
  ]) {
    const restored = readTar(archive);
    for (const path of plan.paths)
      assert.deepEqual(restored.files.get(path), bytes("png"));
    assert.equal(restored.text(p), plan.draft);
  }
  const occupied = planImages(
    plan.stack,
    p,
    original,
    { from: offset, to: offset },
    [bytes("png")],
    () => "repeat",
  );
  assert.equal(occupied.paths[0], "assets/image-repeat-2.png");
  assert.throws(() =>
    planImages(
      s,
      p,
      original,
      { from: 0, to: original.indexOf("# Original") },
      [bytes("png")],
      () => "bad",
    ),
  );
  assert.throws(
    () => planImages(s, p, original, { from: -1, to: 0 }, [bytes("png")]),
    /position/,
  );
  assert.throws(
    () =>
      planImages(
        s,
        p,
        original,
        { from: 0, to: 0 },
        Array(9).fill(bytes("png")),
      ),
    /8 images/,
  );
  assert.throws(
    () =>
      planImages(s, p, original, { from: 0, to: 0 }, [
        encode("<svg>bad</svg>"),
      ]),
    /Only PNG/,
  );
});
test("asset directory capitalization and a file named assets do not produce path collisions", () => {
  const p = "entries/other.md";
  for (const [path, expected] of [
    ["Assets/existing.txt", "Assets/"],
    ["assets", ""],
  ]) {
    const s = new Stack(
      [...sample().files]
        .filter(([p]) => !p.startsWith("assets/"))
        .concat([[path, encode("existing")]]),
      ["empty"],
    );
    const plan = planImages(
      s,
      p,
      s.text(p),
      { from: 0, to: 0 },
      [bytes("webp")],
      () => "safe",
    );
    assert.equal(plan.paths[0], expected + "image-safe.webp");
  }
});

test("JPEG validation requires complete scans and a terminal EOI marker", () => {
  const full = bytes("jpg");
  assert.throws(() => inspectImage(full.slice(0, -2)), /JPEG/);
  const scan = full.findIndex((b, i) => b === 255 && full[i+1] === 0xda);
  assert.ok(scan > 0);
  assert.throws(() => inspectImage(full.slice(0, scan)), /JPEG/);
  const noScan = new Uint8Array([...full.slice(0, scan), 255, 217]);
  assert.throws(() => inspectImage(noScan), /JPEG/);
  assert.throws(() => inspectImage(new Uint8Array([...full, 0])), /JPEG/);
  const stuffed = full.slice(); stuffed.set([255, 0], stuffed.length - 2);
  assert.throws(() => inspectImage(stuffed), /JPEG/);
  assert.equal(inspectImage(new Uint8Array(readFileSync("tests/fixtures/images/progressive.jpg"))).type, "jpeg");
});

test("PNG validates every chunk CRC, including the terminal IEND", () => {
  const full = bytes("png"), view = new DataView(full.buffer);
  for (let at = 8; at < full.length;) {
    const size = view.getUint32(at), corrupt = full.slice();
    corrupt[at + 8 + size] ^= 1;
    assert.throws(() => inspectImage(corrupt), /PNG chunk CRC/);
    at += size + 12;
  }
});
