/**
 * Shared conservative limits (bytes unless noted). No filesystem writes anywhere in core.
 * `files`: members per Stack; `file`: one file; `text`: one Entry/handoff frame; `total`:
 * all Stack files; `archive`: TAR/gzip input or output; `yaml`: one YAML or PAX block;
 * `depth`: path components; `ratio`: allowed gzip expansion factor.
 */
export const LIMITS = Object.freeze({
  files: 2000,
  file: 8 * 1024 ** 2,
  text: 1024 ** 2,
  total: 32 * 1024 ** 2,
  archive: 40 * 1024 ** 2,
  yaml: 64 * 1024,
  depth: 32,
  ratio: 200,
});
/** UTF-8 encode text. @param {string} s @returns {Uint8Array} */
export const encode = (s) => new TextEncoder().encode(s);
/**
 * Strict UTF-8 decode: invalid sequences throw instead of becoming U+FFFD, and a BOM is
 * kept as a character so bytes round-trip exactly.
 * @param {Uint8Array} b
 * @returns {string}
 * @throws {TypeError} on malformed UTF-8
 */
export const decode = (b) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
/**
 * Throw a user-facing Error unless `ok`.
 * @param {unknown} ok
 * @param {string} message
 * @throws {Error}
 */
export function assert(ok, message) {
  if (!ok) throw new Error(message);
}
/**
 * Validate a stable Stack/Entry ID: ASCII letter or digit first, then up to 127 of
 * `[A-Za-z0-9._-]`. Case-sensitive; never normalized.
 * @param {unknown} value  untrusted
 * @returns {string}  the same value
 * @throws {Error} "Invalid stable ID"
 */
export function id(value) {
  assert(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    "Invalid stable ID",
  );
  return value;
}
/**
 * Validate a portable relative path; hostile names are rejected, never normalized into
 * another file. Rules: NFC, `/` separators, no empty/`.`/`..` components, no absolute,
 * drive, backslash, control, bidi-override or `<>:"|?*` characters, no trailing dot/space,
 * no `.git` component, and no Windows device name (`CON`, `COM1`, `con.x`, ...) as the first
 * dot-separated token of any component. Length limits: 1024 bytes, 255 per component,
 * `LIMITS.depth` components; `archive: true` allows one extra component and 256 extra bytes
 * for the archive root.
 * @param {unknown} value  untrusted
 * @param {{archive?: boolean}} [options]
 * @returns {string}  the same value
 * @throws {Error} "Unsafe path: ..." or a length/nesting message
 */
export function path(value, { archive = false } = {}) {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      encode(value).length <= 1024 + (archive ? 256 : 0),
    "Invalid path length",
  );
  assert(value === value.normalize("NFC"), "Path must use NFC Unicode");
  assert(
    !/[\\\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/u.test(value),
    `Unsafe path: ${value}`,
  );
  const parts = value.split("/");
  assert(parts.length <= LIMITS.depth + (archive ? 1 : 0), "Path nesting limit exceeded");
  for (const part of parts)
    assert(
      part &&
        encode(part).length <= 255 &&
        part !== "." &&
        part !== ".." &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) &&
        part.toLowerCase() !== ".git",
      `Unsafe path: ${value}`,
    );
  return value;
}
/**
 * Validate a whole path set: every path passes {@link path}, and no two nodes collide
 * case-insensitively, as file versus directory, as a file versus a parent component, or as
 * the same explicit directory listed twice.
 * @param {Iterable<string>} files
 * @param {Iterable<string>} [directories]  explicit directories
 * @throws {Error} "Path collision: ..." or a {@link path} error
 */
export function validatePaths(files, directories = []) {
  const nodes = new Map();
  const add = (p, type, explicit) => {
    path(p);
    const key = p.toUpperCase();
    const prev = nodes.get(key);
    assert(
      !prev ||
        (prev.p === p &&
          prev.type === "dir" &&
          type === "dir" &&
          !(prev.explicit && explicit)),
      `Path collision: ${p}`,
    );
    nodes.set(key, { p, type, explicit: explicit || prev?.explicit });
  };
  for (const [p, type] of [
    ...Array.from(directories, (p) => [p, "dir"]),
    ...Array.from(files, (p) => [p, "file"]),
  ]) {
    const parts = path(p).split("/");
    for (let i = 1; i < parts.length; i++)
      add(parts.slice(0, i).join("/"), "dir", false);
    add(p, type, true);
  }
  assert(nodes.size <= LIMITS.files * 4, "Too many path components");
}
/**
 * Element-wise equality of two byte arrays (false when either is missing).
 * @param {Uint8Array|undefined} a
 * @param {Uint8Array|undefined} b
 * @returns {boolean}
 */
export function equal(a, b) {
  return a?.length === b?.length && a.every((v, i) => v === b[i]);
}
