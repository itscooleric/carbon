import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectAsset,
  parseCSV,
  ASSET_PREVIEW_LIMIT,
  isTextLike,
  readText,
  codeLanguage,
  canHighlight,
} from "../src/carbon/asset-data.js";
import { encode, LIMITS } from "../src/core/validate.js";
import { highlightSource, hasLanguage } from "../src/carbon/highlight.js";

test("CSV handles quotes, CRLF, newlines, empty fields and ragged rows", () => {
  assert.deepEqual(
    parseCSV('name,value\r\n"a,b","line\n""quoted"""\r\n,\r\nlast').rows,
    [["name", "value"], ["a,b", 'line\n"quoted"'], ["", ""], ["last"]],
  );
  assert.deepEqual(parseCSV("").rows, []);
  assert.deepEqual(parseCSV("a,").rows, [["a", ""]]);
  assert.deepEqual(parseCSV('""').rows, [[""]]);
  const cells = [
    ["a,b", '"quotes"', "line\nbreak"],
    ["", "=SUM(A1)", "<script>alert(1)</script>"],
  ];
  const csv = cells
    .map((row) => row.map((s) => '"' + s.replaceAll('"', '""') + '"').join(","))
    .join("\r\n");
  assert.deepEqual(parseCSV(csv).rows, cells);
});
test("CSV rejects malformed quoting even past visible rows and bounds retained cells", () => {
  for (const s of ['"unclosed', 'a"b', '"ok"oops'])
    assert.throws(() => parseCSV(s), /quot/);
  assert.throws(() => parseCSV("a\n".repeat(210) + '"broken'), /quote/);
  const value = parseCSV(("a,".repeat(59) + "a\n").repeat(220));
  assert.equal(value.rows.length, 200);
  assert.equal(value.rows[0].length, 50);
  assert.equal(value.totalRows, 220);
  assert.equal(value.truncated, true);
});
test("JSON validates without rounding numbers, losing duplicate keys, executing or rewriting assets", () => {
  const text = '{"n":9007199254740993,"x":1,"x":"<script>alert(1)</script>"}';
  const bytes = encode(text),
    before = bytes.slice();
  assert.equal(inspectAsset("a.JSON", bytes).source, text);
  assert.deepEqual(bytes, before);
  assert.match(inspectAsset("a.json", encode("{bad")).error, /Cannot preview/);
  assert.match(
    inspectAsset("a.csv", Uint8Array.of(255)).error,
    /Cannot preview/,
  );
  assert.match(
    inspectAsset("a.json", new Uint8Array(ASSET_PREVIEW_LIMIT + 1)).error,
    /256 KiB/,
  );
  assert.equal(inspectAsset("a.bin", Uint8Array.of(0, 255, 12)), null);
});
test("text-likeness is decided from bytes: UTF-8 text, BOM, NUL, invalid UTF-8 and the size bound", () => {
  assert.equal(isTextLike(encode("print('hi')\n")), true);
  assert.equal(isTextLike(new Uint8Array()), true);
  assert.equal(isTextLike(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)), true);
  assert.equal(readText(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)).source, "a");
  assert.equal(isTextLike(Uint8Array.of(0x61, 0, 0x62)), false);
  assert.equal(isTextLike(Uint8Array.of(0x61, 0xff, 0xfe)), false);
  // NUL beyond the first 8 KiB does not make an otherwise text file binary.
  const late = new Uint8Array(9000).fill(0x61);
  late[8500] = 0;
  assert.equal(isTextLike(late), true);
  const sniffed = new Uint8Array(9000).fill(0x61);
  sniffed[8000] = 0;
  assert.equal(isTextLike(sniffed), false);
  // Over the bound: judged by the first LIMITS.text bytes and reported truncated, even when
  // the cut falls inside a multi-byte character.
  const big = new Uint8Array(LIMITS.text + 10).fill(0x61);
  big.set(encode("€"), LIMITS.text - 1);
  const result = readText(big);
  assert.equal(result.truncated, true);
  assert.equal(result.source.length, LIMITS.text - 1);
  assert.equal(readText(new Uint8Array(LIMITS.text).fill(0x61)).truncated, false);
  const garbage = new Uint8Array(LIMITS.text + 10).fill(0xff);
  assert.equal(isTextLike(garbage), false);
  assert.equal(isTextLike("not bytes"), false);
});
test("code assets map extensions to grammars and unknown text stays plain", () => {
  for (const [path, language] of Object.entries({
    "a.py": "python", "a.JS": "javascript", "a.mjs": "javascript", "a.cjs": "javascript",
    "a.sh": "bash", "a.bash": "bash", "a.zsh": "bash", "a.yml": "yaml", "a.yaml": "yaml",
    "a.ts": "typescript", "a.tsx": "typescript", "a.html": "xml", "a.svg": "xml", "a.css": "css",
    "a.toml": "ini", "a.ini": "ini", "a.cfg": "ini", "a.conf": "ini", "a.sql": "sql",
  })) {
    assert.equal(codeLanguage(path), language, path);
    assert.equal(inspectAsset(path, encode("x")).type, "code", path);
  }
  assert.equal(codeLanguage("Makefile"), null);
  assert.equal(codeLanguage("dir.py/noext"), null);
  const unknown = inspectAsset("notes/LICENSE", encode("plain"));
  assert.deepEqual(
    { type: unknown.type, language: unknown.language, source: unknown.source, truncated: unknown.truncated },
    { type: "code", language: null, source: "plain", truncated: false },
  );
  // JSON keeps the precision-preserving preview; binary stays download-only.
  assert.equal(inspectAsset("a.json", encode("{}")).type, "json");
  assert.equal(inspectAsset("a.bin", Uint8Array.of(1, 0, 2)), null);
  assert.match(inspectAsset("a.yaml", Uint8Array.of(0xff)).error, /Cannot preview/);
});
test("over-limit code files show the first LIMITS.text bytes, flagged truncated, and never throw", () => {
  const big = encode("x = 1\n".repeat(Math.ceil((LIMITS.text + 100) / 6)));
  const data = inspectAsset("big.py", big);
  assert.equal(data.type, "code");
  assert.equal(data.truncated, true);
  assert.equal(data.size, big.length);
  assert.ok(data.source.length <= LIMITS.text);
  assert.doesNotThrow(() => inspectAsset("big.weird", big));
});
test("highlighting escapes hostile source and returns null for unknown grammars", () => {
  const html = highlightSource("x = '<script>alert(1)</script>' # <img src=x onerror=alert(1)>", "python");
  assert.ok(html.includes("hljs-"));
  assert.ok(!/<script|<img/i.test(html));
  assert.ok(!/<(?!\/?span\b)/.test(html));
  assert.equal(highlightSource("x", null), null);
  assert.equal(highlightSource("x", "klingon"), null);
  assert.ok(hasLanguage("typescript") && hasLanguage("xml") && hasLanguage("ini"));
});
test("extensions named like inherited object properties have no language and never reach highlight.js", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    const path = `file.${name}`;
    assert.equal(codeLanguage(path), null, path);
    assert.equal(codeLanguage(path.toUpperCase()), null, path);
    let data;
    assert.doesNotThrow(() => { data = inspectAsset(path, encode("plain text\n")); }, path);
    assert.equal(data.type, "code", path);
    assert.equal(data.language, null, path);
    assert.equal(canHighlight(data), false, path);
    assert.equal(highlightSource(data.source, data.language), null, path);
    assert.equal(hasLanguage(name), false, name);
  }
  // Non-string grammar names are not languages (and cannot throw inside hljs).
  assert.equal(hasLanguage(Object), false);
  assert.equal(hasLanguage({}), false);
});
test("highlighting is bounded by byte size, not UTF-16 length", () => {
  const cjk = "漢".repeat(ASSET_PREVIEW_LIMIT / 2); // 131,072 characters, 393,216 bytes
  assert.ok(cjk.length < ASSET_PREVIEW_LIMIT);
  const data = inspectAsset("big.py", encode(cjk));
  assert.equal(data.size, ASSET_PREVIEW_LIMIT * 1.5);
  assert.ok(data.source.length <= ASSET_PREVIEW_LIMIT && data.size > ASSET_PREVIEW_LIMIT);
  assert.equal(canHighlight(data), false);
  const small = inspectAsset("small.py", encode("x = 1\n"));
  assert.equal(canHighlight(small), true);
  assert.equal(canHighlight(inspectAsset("exact.py", encode("#".repeat(ASSET_PREVIEW_LIMIT)))), true, "the cap itself still highlights");
  assert.equal(canHighlight(inspectAsset("over.py", encode("#".repeat(ASSET_PREVIEW_LIMIT + 1)))), false);
  assert.equal(canHighlight(inspectAsset("LICENSE", encode("x"))), false, "no grammar, nothing to highlight");
});
