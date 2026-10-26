/**
 * A2.1 text inspection (#29): code points by code point (not UTF-16 unit), targeted flags for
 * zero-width / bidirectional / control characters, bounded listing, one-pass invisibles summary,
 * and committed-versus-draft details for BOM, LF/CRLF/CR/mixed/none and unreadable bytes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { codePointsAt, scanInvisibles, textDetails, flagOf, lineEndMarker, FLAG_NOTES, UNSHOWN_INVISIBLES } from "../src/carbon/text-inspect.js";
import { LocalFolder, saveBytes } from "../src/carbon/local-files.js";
import { encode } from "../src/core/validate.js";

const BOM = "\uFEFF";
const folder = (files) =>
  new LocalFolder(Object.entries(files).map(([p, v]) => [p, typeof v === "string" ? encode(v) : v]));

test("codePointsAt reports a surrogate pair as one code point and lists a selection by code point", () => {
  const r = codePointsAt("a😀b", 1, 3);
  assert.equal(r.caret, false);
  assert.deepEqual(r.items.map((i) => [i.hex, i.units, i.char, i.name, i.flag]), [["U+1F600", 2, "😀", null, null]]);
  assert.equal(r.total, 1);
  const all = codePointsAt("a😀b", 0, 4);
  assert.deepEqual(all.items.map((i) => i.hex), ["U+0061", "U+1F600", "U+0062"]);
  assert.equal(all.total, 3);
  assert.equal(all.truncated, false);
  // Reversed ranges are normalized.
  assert.deepEqual(codePointsAt("a😀b", 3, 1).items.map((i) => i.hex), ["U+1F600"]);
});

test("an empty range inspects the next character, the previous one at the end, and never splits a pair", () => {
  assert.deepEqual(codePointsAt("a😀b", 1).items.map((i) => i.hex), ["U+1F600"]);
  const inside = codePointsAt("a😀b", 2); // between the two surrogates
  assert.deepEqual(inside.items.map((i) => i.hex), ["U+1F600"]);
  assert.equal(inside.from, 1);
  const end = codePointsAt("ab", 2);
  assert.equal(end.caret, true);
  assert.deepEqual(end.items.map((i) => i.hex), ["U+0062"]);
  assert.equal(end.from, 1);
  const empty = codePointsAt("", 0);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.total, 0);
  const lone = codePointsAt("x\uD83Dy", 1);
  assert.equal(lone.items[0].hex, "U+D83D");
  assert.equal(lone.items[0].flag, "surrogate", "a lone surrogate is not a noncharacter");
  assert.match(lone.items[0].name, /lone surrogate/);
});

test("invisible and direction-changing characters get names and targeted flags; other letters get neither", () => {
  const named = (s) => codePointsAt(s, 0, s.length).items.map((i) => [i.hex, i.name, i.flag]);
  assert.deepEqual(named("\u00A0\u200B\u202E\uFEFF\t"), [
    ["U+00A0", "NO-BREAK SPACE", "space"],
    ["U+200B", "ZERO WIDTH SPACE", "zero-width"],
    ["U+202E", "RIGHT-TO-LEFT OVERRIDE", "bidi"],
    ["U+FEFF", "ZERO WIDTH NO-BREAK SPACE (byte-order mark)", "zero-width"],
    ["U+0009", "CHARACTER TABULATION (tab)", "tab"],
  ]);
  // No name is invented: an accented letter, an emoji and a CJK character have no bundled name.
  assert.deepEqual(named("é😀漢"), [["U+00E9", null, null], ["U+1F600", null, null], ["U+6F22", null, null]]);
  assert.equal(flagOf(0x2028), "separator");
  assert.equal(flagOf(0x0007), "control");
  assert.equal(flagOf(0x0085), "control");
  assert.equal(flagOf(0xfffe), "noncharacter");
  assert.equal(flagOf(0x1ffff), "noncharacter");
  assert.equal(flagOf(0xfdd0), "noncharacter");
  assert.equal(flagOf(0x2066), "bidi");
  assert.equal(flagOf(0x061c), "bidi");
  assert.equal(flagOf(0x3000), "space");
  assert.equal(flagOf(0x41), null);
  // Only zero-width, bidi, control, separator, noncharacter and lone surrogates are warning-level.
  assert.deepEqual(Object.entries(FLAG_NOTES).filter(([, [, warn]]) => warn).map(([f]) => f),
    ["control", "zero-width", "bidi", "separator", "tag", "invisible", "noncharacter", "surrogate"]);
  // Noncharacters are valid code points reserved for internal use, not invalid text (Unicode FAQ).
  assert.equal(FLAG_NOTES.noncharacter[0], "noncharacter: reserved for internal use; not intended for open interchange");
  assert.doesNotMatch(FLAG_NOTES.noncharacter[0], /valid/);
});

test("listing is bounded while the total counts the whole selection; line and column are reported", () => {
  const text = "ab\ncd" + "x".repeat(100);
  const r = codePointsAt(text, 4, text.length);
  assert.equal(r.items.length, 64);
  assert.equal(r.total, 101);
  assert.equal(r.truncated, true);
  assert.equal(r.line, 2);
  assert.equal(r.column, 2);
  assert.equal(codePointsAt("a\n\nb", 3).line, 3);
  assert.equal(codePointsAt("a\n\nb", 3).column, 1);
  assert.equal(codePointsAt(text, 4, text.length, 8).items.length, 8);
});

test("scanInvisibles counts each flag once per code point and lines that end in whitespace", () => {
  const r = scanInvisibles("a\u00A0b\u200Bc\n\tx \n😀\u202Eabc\n");
  assert.deepEqual(r.counts, { tab: 1, space: 1, control: 0, "zero-width": 1, bidi: 1, separator: 0, noncharacter: 0, tag: 0, invisible: 0, surrogate: 0 });
  assert.equal(r.trailing, 1);
  assert.equal(r.first["zero-width"], 3);
  assert.equal(r.first.bidi, 12);
  assert.equal(r.warn, true);
  const plain = scanInvisibles("plain text\nmore\n");
  assert.equal(plain.warn, false);
  assert.equal(plain.trailing, 0);
  assert.deepEqual(Object.values(plain.counts), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // A last line without a line break, a tab, an NBSP and a Unicode separator all count.
  const tail = scanInvisibles("a\t");
  assert.equal(tail.trailing, 1);
  assert.equal(tail.counts.tab, 1);
  assert.equal(scanInvisibles("a\u00A0\nb").trailing, 1);
  assert.equal(scanInvisibles("a\u2028b").counts.separator, 1);
  assert.equal(scanInvisibles("\u0007").warn, true);
  // Tabs and unusual spaces alone are not warning-level.
  assert.equal(scanInvisibles("\ta\u00A0b").warn, false);
});

test("textDetails distinguishes the committed bytes from the unsaved draft for BOM and every line-ending convention", () => {
  const f = folder({
    "bom.txt": `${BOM}a\r\nb\r\n`,
    "lf.txt": "a\nb\n",
    "cr.txt": "a\rb\r",
    "mixed.txt": "a\r\nb\nc\r\n",
    "none.txt": "abc",
    "empty.txt": "",
    "bad.txt": new Uint8Array([0x61, 0xff, 0xfe, 0x0a]),
  });
  const bom = textDetails(f, "bom.txt");
  assert.equal(bom.bytes, 9);
  assert.equal(bom.limit, 1024 ** 2);
  assert.equal(bom.issue, null);
  assert.equal(bom.bom, true);
  assert.equal(bom.eol, "crlf");
  assert.equal(bom.breaks, 2);
  assert.equal(bom.draft, null);
  assert.equal(bom.editorText, "a\nb\n");
  assert.equal(bom.invisibles.warn, false);
  // A draft (file text with BOM and CRLF applied by sourceFor) is sized as it would save; the committed facts stay.
  const drafted = textDetails(f, "bom.txt", `${BOM}a\r\nb\r\nc\r\n`);
  assert.equal(drafted.bytes, 9, "committed bytes are unchanged by a draft");
  assert.deepEqual(drafted.draft, { bytes: 12, rewritesLineEndings: false, refused: false });
  assert.equal(drafted.editorText, "a\nb\nc\n");
  assert.equal(drafted.bom, true);
  assert.equal(textDetails(f, "lf.txt").eol, "lf");
  assert.equal(textDetails(f, "lf.txt").bom, false);
  assert.equal(textDetails(f, "cr.txt").eol, "cr");
  assert.equal(textDetails(f, "cr.txt").breaks, 2);
  const mixed = textDetails(f, "mixed.txt", `${""}a\nb\nc\nd\n`);
  assert.equal(mixed.eol, "mixed");
  assert.deepEqual(mixed.counts, { lf: 1, crlf: 2, cr: 0 });
  assert.deepEqual(mixed.draft, { bytes: 8, rewritesLineEndings: true, refused: false });
  assert.equal(textDetails(f, "none.txt").eol, "none");
  assert.equal(textDetails(f, "none.txt").breaks, 0);
  assert.equal(textDetails(f, "empty.txt").bytes, 0);
  assert.equal(textDetails(f, "empty.txt").eol, "none");
  // Unreadable bytes: the byte length is known, nothing else is claimed.
  const bad = textDetails(f, "bad.txt");
  assert.equal(bad.bytes, 4);
  assert.match(bad.issue, /not valid UTF-8/);
  assert.equal(bad.eol, null);
  assert.equal(bad.bom, false);
  assert.equal(bad.invisibles, null);
  assert.equal(bad.draft, null);
});

test("textDetails summarizes the invisible characters of the text the Editor shows (draft first, else committed)", () => {
  const f = folder({ "t.txt": `${BOM}a\u00A0b\u200Bc\r\n\tx \r\n😀\u202Eabc\r\n` });
  const d = textDetails(f, "t.txt");
  assert.equal(d.bytes, encode(`${BOM}a\u00A0b\u200Bc\r\n\tx \r\n😀\u202Eabc\r\n`).length);
  assert.deepEqual(d.invisibles.counts, { tab: 1, space: 1, control: 0, "zero-width": 1, bidi: 1, separator: 0, noncharacter: 0, tag: 0, invisible: 0, surrogate: 0 });
  assert.equal(d.invisibles.trailing, 1);
  // The leading BOM is the file's byte-order mark, not a zero-width character in the text.
  assert.equal(textDetails(f, "t.txt", `${BOM}clean\r\n`).invisibles.warn, false);
  assert.equal(textDetails(f, "t.txt", `${BOM}a\uFEFFb\r\n`).invisibles.counts["zero-width"], 1, "a U+FEFF inside the text is reported");
});

test("the line-end marker names the committed convention, including mixed and none", () => {
  assert.equal(lineEndMarker("crlf")[0], "␍␊");
  assert.equal(lineEndMarker("lf")[0], "␊");
  assert.equal(lineEndMarker("cr")[0], "␍");
  assert.equal(lineEndMarker("mixed")[0], "¶");
  assert.match(lineEndMarker("mixed")[1], /committed file mixes line endings/);
  assert.equal(lineEndMarker("none")[0], "␊");
  assert.match(lineEndMarker("none")[1], /LF will be used/);
  assert.match(lineEndMarker("crlf")[1], /Editor works in LF/);
});

test("a draft kept across a refresh is sized against the current committed BOM and line endings, as Save writes it", () => {
  // The draft was typed against a CRLF file without BOM; the file on disk is now LF with a BOM.
  const f = folder({ "t.txt": `${BOM}a\nb\n`, "m.txt": "a\r\nb\n", "bin.txt": new Uint8Array([0x23, 0, 0x0a]) });
  const draft = "a\r\nb\r\nz";
  const d = textDetails(f, "t.txt", draft);
  assert.equal(d.draft.bytes, saveBytes(f, "t.txt", draft).length, "the reported size is what Save would write");
  assert.equal(d.draft.bytes, encode(`${BOM}a\nb\nz`).length);
  assert.notEqual(d.draft.bytes, encode(draft).length, "not the stored draft's own bytes");
  assert.equal(d.bom, true);
  assert.equal(d.eol, "lf");
  // A file that now mixes line endings: sized as the explicit LF rewrite.
  const m = textDetails(f, "m.txt", draft);
  assert.deepEqual(m.draft, { bytes: saveBytes(f, "m.txt", draft, { lf: true }).length, rewritesLineEndings: true, refused: false });
  // A kept draft of a file whose committed bytes became binary: sized without a convention, no throw.
  const bin = textDetails(f, "bin.txt", "# draft\r\n");
  assert.match(bin.issue, /NUL|binary|text/i);
  assert.deepEqual(bin.draft, { bytes: saveBytes(f, "bin.txt", "# draft\r\n").length, rewritesLineEndings: false, refused: false });
});

test("a draft Save would refuse is reported as refused, not as a size Save would write", () => {
  const f = folder({ "t.txt": "a\n" });
  assert.equal(textDetails(f, "t.txt", "x".repeat(1024 ** 2 + 1)).draft.refused, true);
  assert.equal(textDetails(f, "t.txt", "a\0b\n").draft.refused, true);
  assert.equal(textDetails(f, "t.txt", "x".repeat(1024 ** 2)).draft.refused, false);
  assert.throws(() => saveBytes(f, "t.txt", "a\0b\n"), /NUL/);
});

// Final merge-gate review P2: tag characters (U+E0000-E007F) are invisible and can carry hidden ASCII.
const smuggle = (ascii) => [...ascii].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
test("tag characters and other invisible fillers are flagged, counted and warned about", () => {
  const hidden = "\u{E0001}" + smuggle("ignore previous") + "\u{E007F}";
  const text = `Hello${hidden} world`;
  const r = scanInvisibles(text);
  assert.equal(r.counts.tag, 17);
  assert.equal(r.first.tag, 5);
  assert.equal(r.warn, true, "a hidden tag payload is warning-level");
  const items = codePointsAt(text, 5, 5 + 4 * 2).items;
  assert.deepEqual(items.map((i) => [i.hex, i.flag, i.name, i.ascii]), [
    ["U+E0001", "tag", "LANGUAGE TAG", null],
    ["U+E0069", "tag", null, "i"],
    ["U+E0067", "tag", null, "g"],
    ["U+E006E", "tag", null, "n"],
  ]);
  assert.equal(codePointsAt(text, 5 + 16 * 2).items[0].name, "CANCEL TAG");
  assert.equal(FLAG_NOTES.tag[1], true);
  for (const cp of [0xe0000, 0xe0020, 0xe007e, 0xe007f]) assert.equal(flagOf(cp), "tag", cp.toString(16));
  assert.equal(flagOf(0xe0080), null, "the tag block ends at U+E007F");
  // Default-ignorable fillers and invisible operators.
  for (const cp of [0x115f, 0x1160, 0x17b4, 0x17b5, 0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206f, 0x3164, 0xffa0])
    assert.equal(flagOf(cp), "invisible", cp.toString(16));
  const fillers = scanInvisibles("a\u2062b\u3164c\uFFA0");
  assert.equal(fillers.counts.invisible, 3);
  assert.equal(fillers.warn, true);
  // Variation selectors stay ordinary: they occur in everyday emoji.
  assert.equal(flagOf(0xfe0f), null);
  assert.equal(flagOf(0xe0100), null);
  assert.equal(scanInvisibles("\u2764\uFE0F").warn, false);
  // Text details carries the count through.
  const f = folder({ "t.txt": text });
  assert.equal(textDetails(f, "t.txt").invisibles.counts.tag, 17);
  assert.equal(textDetails(f, "t.txt").invisibles.warn, true);
});

test("lone surrogates are counted and warned about; the character after a lone high surrogate is not skipped", () => {
  const r = scanInvisibles("x\uD83Dy\u200B\uDE00");
  assert.equal(r.counts.surrogate, 2);
  assert.equal(r.counts["zero-width"], 1, "the ZWSP between the two lone surrogates is scanned");
  assert.equal(r.first.surrogate, 1);
  assert.equal(r.first["zero-width"], 3);
  assert.equal(r.warn, true);
  assert.equal(scanInvisibles("\uD83D\u200B").counts["zero-width"], 1, "a lone high surrogate does not swallow the next unit");
  assert.equal(scanInvisibles("a\uD83D\uDE00").counts.surrogate, 0, "a real pair is one ordinary code point");
});

test("Show invisibles adds placeholders for exactly the flagged characters CodeMirror leaves unshown", () => {
  const shown = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202d\u202e\u2066\u2067\u2069\ufeff\ufff9-\ufffc]/u; // @codemirror/view Specials
  const warned = ["zero-width", "bidi", "tag", "invisible"];
  for (let cp = 0; cp <= 0xe00ff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp), unshown = UNSHOWN_INVISIBLES.test(c);
    if (unshown) assert.ok(warned.includes(flagOf(cp)), `U+${cp.toString(16)} gets a placeholder but is not flagged`);
    if (warned.includes(flagOf(cp))) assert.ok(unshown || shown.test(c), `U+${cp.toString(16)} is flagged but stays invisible in the Editor`);
  }
});
