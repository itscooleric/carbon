import { parseDocument, isAlias, isMap, isSeq, isScalar } from "yaml";
import { assert, encode, id, LIMITS } from "./validate.js";
/**
 * Parse a bounded YAML 1.2 mapping (core schema); tags, anchors, aliases, merge keys,
 * complex keys, duplicate keys and excessive nesting/node counts are rejected.
 * @param {string} source  untrusted YAML text, at most `LIMITS.yaml` bytes
 * @returns {{doc: import("yaml").Document, data: Record<string, unknown>}}  the source-
 *   preserving document (for range patches) and its plain JS value
 * @throws {Error} on size, syntax or unsupported-construct violations
 */
export function yaml(source) {
  assert(encode(source).length <= LIMITS.yaml, "YAML size limit exceeded");
  const doc = parseDocument(source, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    keepSourceTokens: true,
  });
  assert(
    !doc.errors.length && !doc.warnings.length,
    `Invalid YAML: ${doc.errors[0]?.message || doc.warnings[0]?.message || ""}`,
  );
  assert(
    doc.directives.yaml.version === "1.2" && isMap(doc.contents),
    "YAML must be a 1.2 mapping",
  );
  let count = 0;
  function walk(n, depth) {
    assert(++count <= 10000 && depth <= 32, "YAML complexity limit exceeded");
    if (!n) return;
    assert(
      !isAlias(n) && !n.tag && !n.anchor,
      "YAML tags, anchors and aliases are unsupported",
    );
    if (isMap(n))
      for (const pair of n.items) {
        assert(
          isScalar(pair.key) &&
            typeof pair.key.value === "string" &&
            pair.key.value !== "<<",
          "YAML keys must be strings; merge keys unsupported",
        );
        walk(pair.key, depth + 1);
        walk(pair.value, depth + 1);
      }
    else if (isSeq(n)) for (const v of n.items) walk(v, depth + 1);
    else assert(isScalar(n), "Unsupported YAML node");
  }
  walk(doc.contents, 0);
  return { doc, data: doc.toJS({ maxAliasCount: 0 }) };
}
/**
 * Split an Entry into frontmatter and body without reserializing anything. A leading `---`
 * with no closing `---` line is ordinary Markdown; a closed block must be valid YAML and a
 * present `id` must be a valid stable ID.
 * @param {string} source  untrusted Entry text, at most `LIMITS.text` bytes, no NUL
 * @returns {{data: Record<string, unknown>, body: string, frontmatter: string}}  `frontmatter`
 *   is the exact source prefix (delimiters included, empty when absent) and `body` the rest
 * @throws {Error} on limit, NUL, YAML or ID violations
 */
export function entry(source) {
  assert(
    encode(source).length <= LIMITS.text && !source.includes("\0"),
    "Markdown text limit or NUL violation",
  );
  if (!/^---\r?\n/.test(source))
    return { data: {}, body: source, frontmatter: "" };
  const first = source.indexOf("\n") + 1;
  const end = /^---\r?$/gm;
  end.lastIndex = first;
  const match = end.exec(source);
  // A lone leading thematic break is ordinary Markdown. A closed block must validate.
  if (!match) return { data: {}, body: source, frontmatter: "" };
  const raw = source.slice(first, match.index);
  const { data } = yaml(raw);
  if (data.id !== undefined) id(data.id);
  const bodyStart =
    match.index +
    match[0].length +
    (source[match.index + match[0].length] === "\n" ? 1 : 0);
  return {
    data,
    body: source.slice(bodyStart),
    frontmatter: source.slice(0, bodyStart),
  };
}
/**
 * Replace one top-level scalar's exact source range, leaving every other byte (comments,
 * whitespace, line endings, unknown keys) untouched. Numbers are written bare, other values
 * as JSON strings. The result is re-parsed to prove it is still valid YAML.
 * @param {string} source  YAML mapping text
 * @param {string} key     existing top-level key with a scalar value
 * @param {string|number} value
 * @returns {string}
 * @throws {Error} when the key is missing, not a scalar, or the patch yields invalid YAML
 */
export function patchScalar(source, key, value) {
  const { doc } = yaml(source);
  const node = doc.get(key, true);
  assert(isScalar(node) && node.range, `Missing scalar ${key}`);
  const replacement =
    typeof value === "number" ? String(value) : JSON.stringify(value);
  const result =
    source.slice(0, node.range[0]) + replacement + source.slice(node.range[1]);
  yaml(result);
  return result;
}
/**
 * Assert that an edit keeps a managed Entry's stable ID: an existing `id` can neither change
 * nor disappear (an unmanaged Entry may gain one).
 * @param {string} before  current Entry text
 * @param {string} after   proposed Entry text
 * @throws {Error} when the ID changes or is removed, or either text fails {@link entry}
 */
export function stableEntry(before, after) {
  const old = entry(before).data.id;
  const next = entry(after).data.id;
  assert(
    old === undefined || old === next,
    "Managed Entry ID cannot change or be removed",
  );
}
/**
 * Turn textarea text (always LF) back into the Entry's bytes: uniform CRLF originals get CRLF
 * restored, and an unchanged frontmatter keeps its original bytes exactly.
 * @param {string} value     editor text
 * @param {string} original  committed Entry text
 * @returns {string}
 * @throws {Error} when `original` fails {@link entry}
 */
export function editorSource(value, original) {
  const originalEntry = entry(original);
  const normalizedFront = originalEntry.frontmatter.replace(/\r\n/g, "\n");
  const crlf = original.includes("\r\n") && !/(?<!\r)\n/.test(original);
  let next = crlf ? value.replace(/\n/g, "\r\n") : value;
  if (normalizedFront && value.startsWith(normalizedFront)) {
    const body = value.slice(normalizedFront.length);
    next =
      originalEntry.frontmatter + (crlf ? body.replace(/\n/g, "\r\n") : body);
  }
  return next;
}
/**
 * Remove one top-level scalar field. Block mappings lose only the key/value source range so
 * comments and unknown keys survive; a flow mapping is reserialized by the YAML library.
 * @param {string} source  YAML mapping text
 * @param {string} key     existing top-level key with a scalar value
 * @returns {string}
 * @throws {Error} when the key is missing or not a scalar, or the result is invalid YAML
 */
export function removeField(source, key) {
  const { doc } = yaml(source);
  const pair = doc.contents.items.find((item) => item.key.value === key);
  assert(pair && isScalar(pair.value), `Missing scalar ${key}`);
  if (doc.contents.flow) {
    doc.delete(key);
    return doc.toString();
  }
  const result =
    source.slice(0, pair.key.range[0]) + source.slice(pair.value.range[1]);
  yaml(result);
  return result;
}
