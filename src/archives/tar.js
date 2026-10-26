import {
  assert,
  id,
  path,
  encode,
  decode,
  LIMITS,
  validatePaths,
} from "../core/validate.js";
import { Stack } from "../core/stack.js";
const BLOCK = 512;
const pad = (n) => Math.ceil(n / BLOCK) * BLOCK;
const zero = (b) => b.every((v) => v === 0);
function string(b) {
  const i = b.indexOf(0);
  if (i >= 0) assert(zero(b.subarray(i)), "Invalid TAR string padding");
  return decode(i < 0 ? b : b.subarray(0, i));
}
function octal(b) {
  const s = decode(b)
    .replace(/[\0 ]+$/g, "")
    .trim();
  assert(/^[0-7]+$/.test(s), "Invalid TAR octal field");
  const n = parseInt(s, 8);
  assert(Number.isSafeInteger(n), "TAR integer overflow");
  return n;
}
function paxRead(bytes) {
  const result = new Map();
  let offset = 0;
  assert(bytes.length <= LIMITS.yaml, "PAX header too large");
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    assert(space > offset && space - offset <= 8, "Invalid PAX length");
    const n = decode(bytes.subarray(offset, space));
    assert(/^[1-9][0-9]*$/.test(n), "Invalid PAX length");
    const end = offset + Number(n);
    assert(
      end <= bytes.length && end > space + 3 && bytes[end - 1] === 10,
      "Truncated PAX record",
    );
    const record = decode(bytes.subarray(space + 1, end - 1));
    const eq = record.indexOf("=");
    assert(eq > 0, "Invalid PAX record");
    const key = record.slice(0, eq),
      value = record.slice(eq + 1);
    assert(
      [
        "path",
        "size",
        "mtime",
        "atime",
        "ctime",
        "uid",
        "gid",
        "uname",
        "gname",
      ].includes(key) && !result.has(key),
      `Unsupported or duplicate PAX key: ${key}`,
    );
    if (["size", "uid", "gid"].includes(key))
      assert(
        /^\d+$/.test(value) && Number.isSafeInteger(Number(value)),
        "Invalid PAX integer",
      );
    if (["mtime", "atime", "ctime"].includes(key))
      assert(/^-?\d+(\.\d+)?$/.test(value), "Invalid PAX timestamp");
    result.set(key, value);
    offset = end;
  }
  return result;
}
/**
 * Read a POSIX ustar/PAX archive (regular files and directories only) into a validated Stack.
 * Exactly one root directory is required and stripped; its name is not preserved. Links,
 * devices, GNU extensions, traversal, duplicates, truncation, non-zero padding and limit
 * breaches are rejected before any Stack is built. Input bytes are untrusted.
 * @param {Uint8Array} bytes  whole archive, block aligned, at most `LIMITS.archive`
 * @returns {Stack}
 * @throws {Error} with a user-facing reason on any malformed or unsafe member
 */
export function readTar(bytes) {
  const { files, directories } = readTarFiles(bytes);
  return new Stack(files, directories);
}

/** Parse an ordinary folder archive with the same bounded member/path checks. */
export function readTarFiles(bytes) {
  assert(
    bytes instanceof Uint8Array &&
      bytes.length <= LIMITS.archive &&
      bytes.length >= 1024 &&
      bytes.length % BLOCK === 0,
    "Invalid TAR size or block alignment",
  );
  const files = new Map(),
    directories = new Set(),
    seen = new Set();
  let offset = 0,
    nextPax = null,
    root = null,
    count = 0,
    total = 0,
    ended = false;
  while (offset < bytes.length) {
    const h = bytes.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (zero(h)) {
      assert(
        offset + BLOCK <= bytes.length && zero(bytes.subarray(offset)),
        "Invalid TAR end markers or trailing data",
      );
      ended = true;
      break;
    }
    assert(++count <= LIMITS.files * 2 + 2, "Too many TAR members");
    const checksum = h.reduce(
      (n, v, i) => n + (i >= 148 && i < 156 ? 32 : v),
      0,
    );
    assert(
      octal(h.subarray(148, 156)) === checksum,
      "TAR header checksum mismatch",
    );
    assert(
      decode(h.subarray(257, 263)) === "ustar\0" &&
        decode(h.subarray(263, 265)) === "00",
      "Unsupported TAR format; use POSIX ustar/PAX",
    );
    for (const [a, b] of [
      [100, 108],
      [108, 116],
      [116, 124],
      [136, 148],
    ])
      octal(h.subarray(a, b));
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    assert(
      ["0", "5", "x", "g"].includes(type),
      `Unsafe or unsupported TAR member type: ${type}`,
    );
    assert(zero(h.subarray(157, 257)), "TAR link target forbidden");
    const raw =
      (string(h.subarray(345, 500)) ? string(h.subarray(345, 500)) + "/" : "") +
      string(h.subarray(0, 100));
    // PAX metadata names are not extracted; standard tools use ././@PaxHeader.
    if (type !== "x" && type !== "g" && !nextPax?.has("path"))
      path(type === "5" && raw.endsWith("/") ? raw.slice(0, -1) : raw, {archive: true});
    else
      assert(
        !raw.startsWith("/") &&
          !/[\\:\x00-\x1f]/.test(raw) &&
          !raw.split("/").includes(".."),
        "Unsafe PAX placeholder path",
      );
    let size = octal(h.subarray(124, 136));
    if (type !== "x" && type !== "g" && nextPax?.has("size"))
      size = Number(nextPax.get("size"));
    assert(
      size <= (type === "x" || type === "g" ? LIMITS.yaml : LIMITS.file) &&
        offset + pad(size) <= bytes.length,
      "TAR member too large or truncated",
    );
    const body = bytes.subarray(offset, offset + size);
    assert(
      zero(bytes.subarray(offset + size, offset + pad(size))),
      "Nonzero TAR data padding",
    );
    offset += pad(size);
    if (type === "x" || type === "g") {
      assert(!nextPax, "Multiple or dangling PAX headers");
      const pax = paxRead(body);
      if (type === "g")
        assert(
          !pax.has("path") && !pax.has("size"),
          "Global PAX path/size unsupported",
        );
      else nextPax = pax;
      continue;
    }
    let name = nextPax?.get("path") ?? raw;
    nextPax = null;
    if (type === "5" && name.endsWith("/")) name = name.slice(0, -1);
    path(name, {archive: true});
    assert(!seen.has(name), `Duplicate TAR path: ${name}`);
    seen.add(name);
    const parts = name.split("/");
    root ??= parts[0];
    assert(parts[0] === root, "TAR must contain one Stack root");
    if (type === "5") {
      assert(size === 0, "Directory contains data");
      directories.add(name);
    } else {
      assert(parts.length > 1, "File outside Stack root");
      files.set(name, body.slice());
      total += size;
      assert(total <= LIMITS.total, "TAR total limit exceeded");
    }
  }
  assert(ended && !nextPax, "Missing TAR terminator or dangling PAX");
  assert(
    files.size + directories.size - (directories.has(root) ? 1 : 0) <= LIMITS.files,
    "TAR member count limit exceeded",
  );
  assert(root, "TAR must contain one root directory");
  const result = {
    files: [...files].map(([p, b]) => [p.slice(root.length + 1), b]),
    directories: [...directories]
      .filter((p) => p !== root)
      .map((p) => p.slice(root.length + 1)),
  };
  validatePaths(result.files.map(([p]) => p), result.directories);
  return result;
}
function field(h, start, length, value) {
  const bytes = encode(value);
  assert(bytes.length <= length, "TAR field overflow");
  h.set(bytes, start);
}
function number(h, start, length, n) {
  field(h, start, length, n.toString(8).padStart(length - 1, "0") + "\0");
}
function header(name, size, type) {
  const h = new Uint8Array(BLOCK);
  field(h, 0, 100, name);
  number(h, 100, 8, type === "5" ? 493 : 420);
  number(h, 108, 8, 0);
  number(h, 116, 8, 0);
  number(h, 124, 12, size);
  number(h, 136, 12, 0);
  h.fill(32, 148, 156);
  h[156] = type.charCodeAt(0);
  field(h, 257, 6, "ustar\0");
  field(h, 263, 2, "00");
  field(
    h,
    148,
    8,
    h
      .reduce((n, v) => n + v, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
  );
  return h;
}
function paxRecord(key, value) {
  const tail = ` ${key}=${value}\n`;
  let n = encode(tail).length + 1;
  while (String(n).length + encode(tail).length !== n)
    n = String(n).length + encode(tail).length;
  return encode(n + tail);
}
/**
 * Archive root directory name for a Stack id: `<id>.stack`, or `envoy-<id>.stack` when the
 * plain form is not a portable path component (Windows device names such as `CON`, `COM1` or
 * `con.x` are checked on the first dot-separated token). The Stack id itself never changes;
 * readers strip the root, so both forms re-import to the same Stack.
 * @param {string} stackId  valid stable ID
 * @returns {string}  a root name accepted by `path(..., {archive: true})`
 * @throws {Error} when `stackId` is not a valid stable ID
 */
export function archiveRoot(stackId) {
  const plain = `${id(stackId)}.stack`;
  try {
    return path(plain, { archive: true });
  } catch {
    return path(`envoy-${stackId}.stack`, { archive: true });
  }
}
/**
 * Deterministic POSIX TAR: root {@link archiveRoot}, lexicographic member order, zero mtime,
 * uid/gid 0, modes 0644/0755, PAX `path` records for non-ASCII or >100-byte names.
 * Equal Stacks always produce identical bytes.
 * @param {Stack} stack
 * @returns {Uint8Array}
 * @throws {Error} when the archive would exceed `LIMITS.archive`
 */
export function writeTar(stack) {
  return writeTarFiles(stack.files, stack.directories, archiveRoot(stack.manifest.id));
}

/** Ordinary files retain all bytes and paths; no manifest is added. */
export function writeTarFiles(files, directories, root = "documents") {
  path(root);
  assert(!root.includes("/"), "Archive root must be one component");
  validatePaths(files.keys(), directories);
  assert(files.size + directories.size <= LIMITS.files, "Archive file-count limit exceeded");
  let total = 0;
  for (const [p, b] of files) {
    assert(b instanceof Uint8Array && b.length <= LIMITS.file, `File too large: ${p}`);
    total += b.length;
  }
  assert(total <= LIMITS.total, "Archive total size limit exceeded");
  const chunks = [];
  let size = 0,
    index = 0;
  const add = (b) => {
    chunks.push(b);
    size += b.length;
    assert(size <= LIMITS.archive, "Archive size limit exceeded");
  };
  const member = (name, body, type) => {
    if (encode(name).length > 100 || /[^\x20-\x7e]/.test(name)) {
      const pax = paxRecord("path", name);
      add(header(`PaxHeaders/${index}`, pax.length, "x"));
      add(pax);
      add(new Uint8Array(pad(pax.length) - pax.length));
      name = `member-${index}`;
    }
    index++;
    add(header(name, body.length, type));
    add(body);
    add(new Uint8Array(pad(body.length) - body.length));
  };
  // IDs can exceed the name field; the root itself may therefore use PAX.
  member(root + "/", new Uint8Array(), "5");
  for (const p of [...directories].sort())
    member(root + "/" + p + "/", new Uint8Array(), "5");
  for (const [p, b] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    member(root + "/" + p, b, "0");
  add(new Uint8Array(1024));
  const out = new Uint8Array(size);
  let at = 0;
  for (const b of chunks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
