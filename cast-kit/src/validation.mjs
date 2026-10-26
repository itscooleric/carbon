/**
 * Bounded YAML 1.2 and portable-path checks, aligned with Carbon PR #2.
 *
 * Every validator here is fail-closed: it throws an `Error` whose message is part of
 * the Cast Kit contract (hosts and tests match on it), and it returns nothing useful
 * on failure. All inputs are untrusted (model output, pasted packets, imported files)
 * unless a function's documentation says otherwise. Nothing in this module touches the
 * network or filesystem.
 */
import { parseDocument, isMap, isSeq, isScalar, isAlias, stringify } from 'yaml';

/**
 * Hard size limits shared by every parser and encoder in the kit.
 *
 * - `packet`: 4 MiB maximum for one Return, handoff or Dispatch text packet.
 * - `text`: 1 MiB maximum for one text file body or any text not otherwise bounded.
 * - `yaml`: 64 KiB maximum for one YAML metadata block, path list string or objective.
 * - `files`: 2,000 maximum inventory entries (paths, string lists, package members).
 * - `operations`: 100 maximum operation endpoints (creates + replaces + deletes + rename ends).
 *
 * The object is frozen; callers must not extend it.
 * @type {Readonly<{packet: number, text: number, yaml: number, files: number, operations: number}>}
 */
export const LIMITS = Object.freeze({
  packet: 4 * 1024 ** 2,
  text: 1024 ** 2,
  yaml: 64 * 1024,
  files: 2000,
  operations: 100
});

/**
 * UTF-8 encode a string.
 * @param {string} s
 * @returns {Uint8Array}
 */
export const encode = s => new TextEncoder().encode(s);

/**
 * Strictly decode UTF-8 bytes. Invalid sequences throw a `TypeError` from the platform
 * decoder; a leading BOM is kept as data rather than silently stripped.
 * @param {Uint8Array} b
 * @returns {string}
 * @throws {TypeError} on malformed UTF-8.
 */
export const decode = b => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);

/**
 * Assertion primitive used by every validator.
 * @param {unknown} ok  Truthy to pass.
 * @param {string} message  Contract error text thrown when `ok` is falsy.
 * @throws {Error} with exactly `message`.
 */
export function check(ok, message) {
  if (!ok) throw new Error(message);
}

/**
 * Require a bounded, NUL-free, round-trippable Unicode string.
 *
 * Rejects non-strings, strings over `max` UTF-16 code units or over `max` UTF-8 bytes,
 * any NUL byte, and lone surrogates (which would not survive a UTF-8 round trip).
 * @param {unknown} s
 * @param {number} [max=LIMITS.text]  Maximum length in both code units and UTF-8 bytes.
 * @returns {string} The same string, for chaining.
 * @throws {Error} 'Text limit or NUL violation' | 'Invalid Unicode string'
 */
export function boundedText(s, max = LIMITS.text) {
  const bounded = typeof s === 'string' && s.length <= max && encode(s).length <= max && !s.includes('\0');
  check(bounded, 'Text limit or NUL violation');
  check(decode(encode(s)) === s, 'Invalid Unicode string');
  return s;
}

/**
 * Require a Cast Kit identifier: 1–128 ASCII letters, digits, `.`, `_` or `-`, starting
 * with a letter or digit. Used for assignment, dispatch, Stack, checkpoint and Entry IDs.
 * @param {unknown} s
 * @returns {string}
 * @throws {Error} 'Invalid ID'
 */
export function id(s) {
  check(typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s), 'Invalid ID');
  return s;
}

/**
 * Require a Stack revision: a nonnegative safe integer.
 * @param {unknown} n
 * @throws {Error} 'Invalid revision'
 */
export function revision(n) {
  check(Number.isSafeInteger(n) && n >= 0, 'Invalid revision');
}

/**
 * Parse one untrusted YAML 1.2 document into a plain object.
 *
 * Rejects: text over `LIMITS.yaml`; parser errors or warnings; any `%YAML` directive other
 * than 1.2; a non-mapping root; duplicate keys; aliases, anchors and tags (including merge
 * keys `<<`); non-string or prototype-polluting keys (`__proto__`, `constructor`,
 * `prototype`); more than 10,000 nodes or 24 nesting levels; any non-scalar leaf node.
 * Only the YAML core schema is used, so `yes`/`no` stay strings.
 * @param {string} s
 * @returns {Record<string, unknown>} Plain data with no prototype tricks.
 * @throws {Error} 'Text limit or NUL violation' | 'Invalid YAML mapping' | 'YAML complexity limit'
 *   | 'YAML aliases, anchors and tags unsupported' | 'Unsafe YAML key' | 'Unsupported YAML node'
 */
export function yaml(s) {
  boundedText(s, LIMITS.yaml);
  const doc = parseDocument(s, { version: '1.2', schema: 'core', uniqueKeys: true });
  const wellFormed = !doc.errors.length && !doc.warnings.length && doc.directives.yaml.version === '1.2' && isMap(doc.contents);
  check(wellFormed, 'Invalid YAML mapping');
  let nodes = 0;
  function walk(node, depth) {
    check(++nodes <= 10000 && depth <= 24, 'YAML complexity limit');
    if (!node) return;
    check(!isAlias(node) && !node.anchor && !node.tag, 'YAML aliases, anchors and tags unsupported');
    if (isMap(node)) {
      for (const pair of node.items) {
        const safeKey = isScalar(pair.key) && typeof pair.key.value === 'string'
          && !['<<', '__proto__', 'constructor', 'prototype'].includes(pair.key.value);
        check(safeKey, 'Unsafe YAML key');
        walk(pair.key, depth + 1);
        walk(pair.value, depth + 1);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item, depth + 1);
    } else {
      check(isScalar(node), 'Unsupported YAML node');
    }
  }
  walk(doc.contents, 0);
  return doc.toJS({ maxAliasCount: 0 });
}

/**
 * Serialize plain data as YAML without line folding. Output is deterministic for equal
 * input, which the Dispatch package and example fixtures rely on.
 * @param {unknown} value
 * @returns {string}
 */
export const dump = value => stringify(value, { lineWidth: 0 });

/**
 * Require a plain mapping with exactly the expected keys.
 *
 * Every `required` key must be present (own property); every present key must be in
 * `required` or `optional`. Unknown keys fail closed so that extensions cannot smuggle
 * semantics past an older validator.
 * @param {unknown} o
 * @param {string[]} required
 * @param {string[]} [optional=[]]
 * @throws {Error} 'Expected mapping' | 'Missing required field' | 'Unknown field; unsupported extension'
 */
export function keys(o, required, optional = []) {
  check(o && typeof o === 'object' && !Array.isArray(o), 'Expected mapping');
  check(required.every(k => Object.hasOwn(o, k)), 'Missing required field');
  const allowed = [...required, ...optional];
  check(Object.keys(o).every(k => allowed.includes(k)), 'Unknown field; unsupported extension');
}

/**
 * Require an array of at most `max` nonblank strings, each within `LIMITS.yaml`.
 * @param {unknown} a
 * @param {number} [max=LIMITS.files]
 * @returns {string[]} The same array.
 * @throws {Error} 'Expected bounded nonempty strings' | boundedText errors
 */
export function strings(a, max = LIMITS.files) {
  const shape = Array.isArray(a) && a.length <= max && a.every(x => typeof x === 'string' && x.trim().length);
  check(shape, 'Expected bounded nonempty strings');
  a.forEach(x => boundedText(x, LIMITS.yaml));
  return a;
}

/**
 * Require one portable, relative, forward-slash Stack path.
 *
 * Rejects: over 1,024 UTF-8 bytes; empty; non-NFC; backslashes, control characters,
 * `<>:"|?*` and bidi-override characters; more than 32 components; empty, `.`, `..`,
 * `.git` (any case) or over-255-byte components; components ending in a dot or space;
 * Windows reserved device names (optionally with an extension). Absolute, drive and
 * UNC forms fall out of these rules (leading `/`, `:` and `\\`).
 * @param {unknown} p
 * @returns {string} The same path.
 * @throws {Error} 'Unsafe path' | 'Path depth exceeded' | 'Unsafe path component' | boundedText errors
 */
export function path(p) {
  boundedText(p, 1024);
  const unsafeCharacters = /[\\\x00-\x1f\x7f<>:"|?*‪-‮⁦-⁩]/u;
  check(p.length && p === p.normalize('NFC') && !unsafeCharacters.test(p), 'Unsafe path');
  const parts = p.split('/');
  check(parts.length <= 32, 'Path depth exceeded');
  const reservedName = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
  for (const part of parts) {
    const safeComponent = part && encode(part).length <= 255 && part !== '.' && part !== '..'
      && !/[. ]$/.test(part) && !reservedName.test(part) && part.toLowerCase() !== '.git';
    check(safeComponent, 'Unsafe path component');
  }
  return p;
}

/**
 * Carbon validatePaths rules: case-insensitive keys; a file never shares a key with another
 * file or directory. Claims `p` as `kind` in `nodes` and returns its case-folded key.
 * Two claims of the same directory spelled identically are allowed; anything else collides.
 * @param {Map<string, {p: string, kind: 'file'|'dir'}>} nodes
 * @param {string} p
 * @param {'file'|'dir'} kind
 * @returns {string} The upper-cased key.
 * @throws {Error} 'Path collision: <path>'
 */
function claim(nodes, p, kind) {
  const key = p.toUpperCase();
  const previous = nodes.get(key);
  const compatible = !previous || (previous.p === p && previous.kind === 'dir' && kind === 'dir');
  check(compatible, 'Path collision: ' + p);
  return key;
}

/**
 * Expand a validated path into every ancestor prefix plus the leaf, each tagged with its
 * kind, e.g. `a/b/c.md` → `[['a','dir'],['a/b','dir'],['a/b/c.md','file']]`.
 * @param {string} p
 * @param {'file'|'dir'} [leaf='file']
 * @returns {[string, 'file'|'dir'][]}
 */
function components(p, leaf = 'file') {
  const parts = path(p).split('/');
  return parts.map((_, i) => [parts.slice(0, i + 1).join('/'), i < parts.length - 1 ? 'dir' : leaf]);
}

/**
 * Claim every component of every path in `list` into one collision index.
 * @param {string[]} list
 * @param {Map<string, {p: string, kind: 'file'|'dir'}>} [into=new Map()]
 * @param {'file'|'dir'} [leaf='file']
 * @returns {Map<string, {p: string, kind: 'file'|'dir'}>} `into`, for chaining.
 * @throws {Error} 'Path collision: <path>' and path() errors
 */
function index(list, into = new Map(), leaf = 'file') {
  for (const p of list) {
    for (const [prefix, kind] of components(p, leaf)) into.set(claim(into, prefix, kind), { p: prefix, kind });
  }
  return into;
}

/**
 * Require a list of portable file paths that do not collide with each other, even by case
 * or by a file/directory prefix overlap.
 * @param {unknown} list
 * @returns {string[]} The same list.
 * @throws {Error} strings(), path() and 'Path collision: <path>' errors
 */
export function paths(list) {
  strings(list);
  index(list);
  return list;
}

/**
 * New targets must not alias an existing file or directory, or each other, even by case or
 * parent component. `directories` are claimed first (as directories), then `existing` files,
 * then `targets`; the first collision found is thrown.
 * @param {string[]} existing  Current file paths.
 * @param {string[]} targets  Proposed new file paths (creates and rename destinations).
 * @param {Iterable<string>} [directories=[]]  Current directory paths, including empty ones.
 * @throws {Error} 'Path collision: <path>' and path() errors
 */
export function vacant(existing, targets, directories = []) {
  index(targets, index(existing, index(directories, new Map(), 'dir')));
}

/**
 * Split an Entry into its raw frontmatter span and parsed data, matching Carbon.
 *
 * A document that does not start with `---` + newline has no frontmatter. A leading
 * `---` without a closing `---` line is plain Markdown (a lone thematic break), not an
 * error. The frontmatter YAML goes through {@link yaml}; a present `id` must satisfy
 * {@link id}. `frontmatter` is the exact source bytes from the opening fence through the
 * closing fence line and its one trailing LF (if any), so callers can require exact
 * preservation.
 * @param {string} s
 * @returns {{frontmatter: string, data: Record<string, unknown>}}
 * @throws {Error} boundedText(), yaml() and 'Invalid ID' errors
 */
export function entry(s) {
  boundedText(s);
  if (!/^---\r?\n/.test(s)) return { frontmatter: '', data: {} };
  const first = s.indexOf('\n') + 1;
  const closing = /^---\r?$/gm;
  closing.lastIndex = first;
  const end = closing.exec(s);
  if (!end) return { frontmatter: '', data: {} }; // Carbon treats a lone thematic break as plain Markdown.
  const data = yaml(s.slice(first, end.index));
  if (data.id !== undefined) id(data.id);
  const stop = end.index + end[0].length;
  const frontmatter = s.slice(0, stop + (s[stop] === '\n' ? 1 : 0));
  return { data, frontmatter };
}

/**
 * Byte-wise equality of two array-likes; `undefined` never equals anything.
 * @param {ArrayLike<number>|undefined} a
 * @param {ArrayLike<number>|undefined} b
 * @returns {boolean}
 */
export const equal = (a, b) => a?.length === b?.length && a.every((v, i) => v === b[i]);

/**
 * Order-insensitive equality of two string collections (duplicates count).
 * @param {Iterable<string>} a
 * @param {Iterable<string>} b
 * @returns {boolean}
 */
export const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Patch only an existing top-level frontmatter scalar; keep comments/unknown bytes.
 *
 * `front` is the exact frontmatter span from {@link entry}. The value is written in JSON
 * scalar spelling (so strings are double-quoted) over the scalar's exact source range;
 * every other byte, including comments, key order and whitespace, is preserved. Used by
 * hosts to produce authorized `Cast.metadata` edits and by staging to verify them.
 * @param {string} front  Raw frontmatter span starting with `---`.
 * @param {string} key  Existing top-level key.
 * @param {string|number|boolean} value  Replacement scalar.
 * @returns {string} The patched frontmatter span.
 * @throws {Error} 'Unclosed metadata' | 'Existing scalar required' | yaml() errors
 */
export function patchScalarFrontmatter(front, key, value) {
  const first = front.indexOf('\n') + 1;
  const closing = /^---\r?$/gm;
  closing.lastIndex = first;
  const end = closing.exec(front);
  check(end, 'Unclosed metadata');
  const raw = front.slice(first, end.index);
  yaml(raw);
  const doc = parseDocument(raw, { keepSourceTokens: true, version: '1.2' });
  const node = doc.get(key, true);
  check(isScalar(node) && node.range, 'Existing scalar required');
  const [start, stop] = node.range;
  return front.slice(0, first + start) + JSON.stringify(value) + front.slice(first + stop);
}
