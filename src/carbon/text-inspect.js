/**
 * Read-only text inspection (A2.1, issue #29): byte and line-ending details of the committed file
 * versus the unsaved draft, counts of invisible or direction-changing characters, and the Unicode
 * code points at a caret or selection. Pure functions over strings and bytes; nothing here changes
 * a document, a draft or a revision. No lookup data is bundled beyond the small table below, so a
 * character outside it gets no name rather than an invented one.
 */
import { LIMITS, encode } from "../core/validate.js";
import { saveSource, textFormat, textIssue, toEditorText } from "./local-files.js";

/** Flags for characters that are invisible or change how text reads; null for ordinary characters. */
const FLAGS = [
  // [first, last, flag]
  [0x0009, 0x0009, "tab"],
  [0x000a, 0x000a, "newline"],
  [0x000d, 0x000d, "newline"],
  [0x0000, 0x001f, "control"],
  [0x007f, 0x009f, "control"],
  [0x00a0, 0x00a0, "space"],
  [0x00ad, 0x00ad, "zero-width"],
  [0x034f, 0x034f, "zero-width"],
  [0x061c, 0x061c, "bidi"],
  [0x115f, 0x1160, "invisible"],
  [0x1680, 0x1680, "space"],
  [0x17b4, 0x17b5, "invisible"],
  [0x180e, 0x180e, "zero-width"],
  [0x2000, 0x200a, "space"],
  [0x200b, 0x200d, "zero-width"],
  [0x200e, 0x200f, "bidi"],
  [0x2028, 0x2029, "separator"],
  [0x202a, 0x202e, "bidi"],
  [0x202f, 0x202f, "space"],
  [0x205f, 0x205f, "space"],
  [0x2060, 0x2060, "zero-width"],
  [0x2061, 0x2064, "invisible"],
  [0x2066, 0x2069, "bidi"],
  [0x206a, 0x206f, "invisible"],
  [0x3000, 0x3000, "space"],
  [0x3164, 0x3164, "invisible"],
  [0xfdd0, 0xfdef, "noncharacter"],
  [0xfeff, 0xfeff, "zero-width"],
  [0xffa0, 0xffa0, "invisible"],
  [0xe0000, 0xe007f, "tag"],
];
/** Names that are certain for the characters this inspector is about; everything else is unnamed. */
const NAMES = {
  0x09: "CHARACTER TABULATION (tab)", 0x0a: "LINE FEED", 0x0d: "CARRIAGE RETURN", 0x20: "SPACE", 0x7f: "DELETE",
  0xa0: "NO-BREAK SPACE", 0xad: "SOFT HYPHEN", 0x034f: "COMBINING GRAPHEME JOINER", 0x061c: "ARABIC LETTER MARK",
  0x1680: "OGHAM SPACE MARK", 0x180e: "MONGOLIAN VOWEL SEPARATOR", 0x2002: "EN SPACE", 0x2003: "EM SPACE",
  0x2009: "THIN SPACE", 0x200a: "HAIR SPACE", 0x200b: "ZERO WIDTH SPACE", 0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER", 0x200e: "LEFT-TO-RIGHT MARK", 0x200f: "RIGHT-TO-LEFT MARK", 0x2028: "LINE SEPARATOR",
  0x2029: "PARAGRAPH SEPARATOR", 0x202a: "LEFT-TO-RIGHT EMBEDDING", 0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING", 0x202d: "LEFT-TO-RIGHT OVERRIDE", 0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x202f: "NARROW NO-BREAK SPACE", 0x205f: "MEDIUM MATHEMATICAL SPACE", 0x2060: "WORD JOINER",
  0x2066: "LEFT-TO-RIGHT ISOLATE", 0x2067: "RIGHT-TO-LEFT ISOLATE", 0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE", 0x3000: "IDEOGRAPHIC SPACE", 0xfeff: "ZERO WIDTH NO-BREAK SPACE (byte-order mark)",
  0x115f: "HANGUL CHOSEONG FILLER", 0x1160: "HANGUL JUNGSEONG FILLER", 0x17b4: "KHMER VOWEL INHERENT AQ",
  0x17b5: "KHMER VOWEL INHERENT AA", 0x2061: "FUNCTION APPLICATION", 0x2062: "INVISIBLE TIMES",
  0x2063: "INVISIBLE SEPARATOR", 0x2064: "INVISIBLE PLUS", 0x3164: "HANGUL FILLER", 0xffa0: "HALFWIDTH HANGUL FILLER",
  0xe0001: "LANGUAGE TAG", 0xe007f: "CANCEL TAG",
};
/** What a flag means to a reader; "warn" flags are the ones worth a targeted warning. */
export const FLAG_NOTES = {
  tab: ["tab", false],
  newline: ["line break", false],
  space: ["unusual space (not a plain space)", false],
  control: ["control character", true],
  "zero-width": ["zero width: invisible", true],
  bidi: ["bidirectional control: changes how text is displayed", true],
  separator: ["Unicode line or paragraph separator (not a line break for the Editor)", true],
  tag: ["tag character: invisible; can hide ASCII text", true],
  invisible: ["invisible format or filler character", true],
  noncharacter: ["noncharacter: reserved for internal use; not intended for open interchange", true],
  surrogate: ["lone surrogate: not a Unicode scalar value; saving it as UTF-8 writes U+FFFD instead", true],
};
/** Code points not shown by CodeMirror's default `highlightSpecialChars` but flagged above as
 * zero-width, bidi, tag or invisible; Show invisibles adds placeholders for them. */
export const UNSHOWN_INVISIBLES = /[\u034f\u115f\u1160\u17b4\u17b5\u180e\u200c\u200d\u202a-\u202c\u2060-\u2064\u2068\u206a-\u206f\u3164\uffa0\u{e0000}-\u{e007f}]/u;
/**
 * Flag of a code point: "tab", "newline", "space", "control", "zero-width", "bidi", "separator",
 * "tag", "invisible", "noncharacter" or null (`codePointsAt` adds "surrogate" for a lone surrogate). U+FFFE and U+FFFF of every plane are noncharacters.
 * @param {number} cp
 */
export function flagOf(cp) {
  if ((cp & 0xfffe) === 0xfffe) return "noncharacter";
  for (const [first, last, flag] of FLAGS) if (cp >= first && cp <= last) return flag;
  return null;
}
const hex = (cp) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
/**
 * Code points of `text` between UTF-16 offsets `from` and `to` (an editor selection). An empty
 * range inspects the character after the caret, or the one before it at the end of the text.
 * Surrogate pairs are one item; a lone surrogate is reported as such. Only the first `limit`
 * items are listed, but `total` counts the whole range.
 * @param {string} text
 * @param {number} from
 * @param {number} [to]
 * @param {number} [limit]
 */
export function codePointsAt(text, from, to = from, limit = 64) {
  if (from > to) [from, to] = [to, from];
  const caret = from === to;
  if (caret) {
    if (from >= text.length) from = text.length - 1;
    if (from > 0 && (text.charCodeAt(from) & 0xfc00) === 0xdc00) from--; // inside a surrogate pair
    to = from + ((text.codePointAt(from) ?? 0) > 0xffff ? 2 : 1);
  }
  from = Math.max(0, from);
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < from; i = text.indexOf("\n", i + 1)) line++;
  const items = [];
  let total = 0;
  for (let i = from; i < to; ) {
    const cp = text.codePointAt(i), units = cp > 0xffff ? 2 : 1;
    if (items.length < limit) {
      const lone = cp >= 0xd800 && cp <= 0xdfff;
      items.push({
        offset: i, cp, hex: hex(cp), char: text.slice(i, i + units), units,
        name: lone ? "lone surrogate (not a valid character)" : NAMES[cp] ?? null,
        flag: lone ? "surrogate" : flagOf(cp),
        // A tag character mirrors printable ASCII (U+E0020-E007E), which is what it can smuggle.
        ascii: cp >= 0xe0020 && cp <= 0xe007e ? String.fromCharCode(cp - 0xe0000) : null,
      });
    }
    total++;
    i += units;
  }
  return { caret, from, to, line, column: from - lineStart + 1, items, total, truncated: total > items.length };
}
/**
 * One pass over editor text: how many characters of each flag it contains, how many lines end in
 * whitespace, and the first offset of each flag (for a warning that names a place).
 * @param {string} text
 */
export function scanInvisibles(text) {
  const counts = { tab: 0, space: 0, control: 0, "zero-width": 0, bidi: 0, separator: 0, noncharacter: 0, tag: 0, invisible: 0, surrogate: 0 };
  const first = {};
  let trailing = 0, lineHasTrailing = false;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i), start = i;
    if (cp > 0xffff) i++; // a surrogate pair is one code point; a lone surrogate is one unit
    if (cp >= 0xd800 && cp <= 0xdfff) {
      counts.surrogate++;
      if (!("surrogate" in first)) first.surrogate = start;
      lineHasTrailing = false;
      continue;
    }
    if (cp === 10) {
      if (lineHasTrailing) trailing++;
      lineHasTrailing = false;
      continue;
    }
    lineHasTrailing = cp === 32 || cp === 9 || flagOf(cp) === "space";
    const flag = flagOf(cp);
    if (flag && flag !== "newline") {
      counts[flag]++;
      if (!(flag in first)) first[flag] = start;
    }
  }
  if (lineHasTrailing) trailing++;
  return { counts, trailing, first, warn: Object.keys(FLAG_NOTES).some((f) => FLAG_NOTES[f][1] && counts[f] > 0) };
}
/**
 * Committed-versus-draft facts for the file at `path`: byte length and limit, whether the bytes are
 * editable text (else why not), BOM and line-ending convention measured from the committed bytes,
 * and what the unsaved draft would save as. The Editor shows `editorText` (LF, no BOM) in both cases.
 * @param {import("./types.js").Documents} workspace
 * @param {string} path
 * @param {string} [draft] the unsaved draft (file text with BOM and line endings applied), if any
 */
export function textDetails(workspace, path, draft) {
  const bytes = workspace.files.get(path);
  const issue = textIssue(bytes);
  const committed = issue === null ? workspace.text(path) : "";
  const format = issue === null ? textFormat(committed) : null;
  const editorText = toEditorText(draft ?? committed);
  return {
    path,
    bytes: bytes.length,
    limit: LIMITS.text,
    issue,
    bom: format?.bom ?? false,
    eol: format?.eol ?? null,
    counts: format?.counts ?? null,
    breaks: format ? format.counts.lf + format.counts.crlf + format.counts.cr : 0,
    draft: draft === undefined ? null : draftDetails(workspace, path, draft),
    editorText,
    invisibles: issue === null ? scanInvisibles(editorText) : null,
  };
}
/** What Save would write for a draft: the save pipeline's own rebuild against the current committed bytes. */
function draftDetails(workspace, path, draft) {
  const { source, format } = saveSource(workspace, path, draft);
  const bytes = encode(source).length;
  return { bytes, rewritesLineEndings: format.eol === "mixed", refused: bytes > LIMITS.text || source.includes("\0") };
}
/** The line-break marker for a file's committed convention, as shown by "Show invisibles". */
export function lineEndMarker(eol) {
  return { lf: ["␊", "Line break (this file uses LF)"], crlf: ["␍␊", "Line break (this file uses CRLF; the Editor works in LF and Save restores CRLF)"],
    cr: ["␍", "Line break (this file uses lone CR; the Editor works in LF and Save restores CR)"],
    mixed: ["¶", "Line break (the committed file mixes line endings; the Editor shows LF and Save asks before rewriting them)"],
  }[eol] ?? ["␊", "Line break (new; the file had none, LF will be used)"];
}
