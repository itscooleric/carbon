/** Bounded, read-only inspection. Source bytes never change and formulas never execute. */
import { decode, LIMITS } from "../core/validate.js";

export const ASSET_PREVIEW_LIMIT = 256 * 1024;
/** Extension to highlight.js grammar. Anything else renders as plain, unhighlighted text. */
const LANGUAGES = new Map(Object.entries({
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", json: "json",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", css: "css",
  ini: "ini", toml: "ini", cfg: "ini", conf: "ini", sql: "sql",
}));
// A Map, not an object: `file.constructor` / `file.__proto__` must not resolve to inherited properties.
export const codeLanguage = (path) =>
  LANGUAGES.get(/\.([^./]+)$/.exec(path)?.[1].toLowerCase()) ?? null;

/** Synchronous highlighting is bounded by BYTES (`size`), not UTF-16 length: 200,000 CJK characters are ~600 KB. */
export const canHighlight = (data) => Boolean(data.language) && data.size <= ASSET_PREVIEW_LIMIT;

const textCache = new WeakMap();
/**
 * Text-likeness from bytes: no NUL in the first 8 KiB and strict UTF-8 (a BOM is fine) over
 * the first `LIMITS.text` bytes. Larger files are judged by that prefix and reported
 * `truncated`; a multi-byte character cut by the prefix boundary is not an error.
 * @param {Uint8Array} bytes
 * @returns {{source:string, truncated:boolean}|null} null for binary or non-UTF-8 content
 */
export function readText(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (textCache.has(bytes)) return textCache.get(bytes);
  let result = null;
  if (!bytes.subarray(0, 8192).includes(0)) {
    const truncated = bytes.length > LIMITS.text,
      end = Math.min(bytes.length, LIMITS.text);
    for (let cut = 0; cut <= (truncated ? 3 : 0) && !result; cut++) {
      try {
        result = { source: decode(bytes.subarray(0, end - cut)).replace(/^\uFEFF/, ""), truncated };
      } catch {}
    }
  }
  textCache.set(bytes, result);
  return result;
}
export const isTextLike = (bytes) => readText(bytes) !== null;

export function inspectAsset(path, bytes) {
  const type = /\.(csv|json|txt|log|md)$/i.exec(path)?.[1].toLowerCase();
  if (!type) {
    const text = readText(bytes);
    if (!text && /\.(yaml|yml)$/i.test(path))
      return { type: "yaml", error: "Cannot preview YAML: Not valid UTF-8 text" };
    return text
      ? { type: "code", language: codeLanguage(path), source: text.source, truncated: text.truncated, size: bytes.length }
      : null;
  }
  if (bytes.length > ASSET_PREVIEW_LIMIT)
    return {
      type,
      error: "Preview limited to 256 KiB. Download to inspect this asset.",
    };
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (type === "json") {
      // Validate, but display the original text: JSON.parse/stringify would round large
      // numbers, collapse duplicate keys and alter whitespace in an inspection view.
      JSON.parse(source);
      return { type, source };
    }
    if (type === "csv") return { type, ...parseCSV(source) };
    if (source.includes("\0")) throw Error("Not a plain text file");
    return { type: "text", source };
  } catch (error) {
    return {
      type,
      error: `Cannot preview ${type.toUpperCase()}: ${error.message}`,
    };
  }
}

/** RFC-style comma CSV: quoted fields, doubled quotes, CRLF/LF and embedded newlines.
 * Strict malformed-quote errors; ragged rows are shown as-is. Validate all bounded input,
 * but retain at most 200 rows and 50 columns to bound the rendered table.
 */
export function parseCSV(source) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    afterQuote = false,
    totalRows = 0,
    columns = 0;
  const cell = () => {
    if (row.length < 50) row.push(field);
    columns++;
    field = "";
    afterQuote = false;
  };
  const record = () => {
    cell();
    totalRows++;
    if (rows.length < 200) rows.push(row);
    row = [];
    columns = 0;
  };
  let truncatedColumns = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (source[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        afterQuote = true;
      }
    } else if (ch === ",") {
      cell();
      if (columns >= 50) truncatedColumns = true;
    } else if (ch === "\n" || ch === "\r") {
      record();
      if (ch === "\r" && source[i + 1] === "\n") i++;
    } else if (ch === '"' && !field && !afterQuote) quoted = true;
    else {
      if (afterQuote || ch === '"') throw Error("Malformed CSV quoting");
      field += ch;
    }
  }
  if (quoted) throw Error("Unclosed CSV quote");
  if (field || row.length || afterQuote || (source && !/[\r\n]$/.test(source)))
    record();
  return { rows, totalRows, truncated: totalRows > 200 || truncatedColumns };
}
