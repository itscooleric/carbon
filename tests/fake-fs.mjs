/**
 * In-memory FileSystem Access fake for tests (no DOM). Mirrors the Chromium behaviour Carbon
 * relies on: `getFileHandle({create})` creates an EMPTY file immediately, `createWritable()`
 * buffers and swaps the new bytes in on `close()`, and `abort()` discards the buffer.
 *
 *   const fs = new FakeFs();
 *   fs.seed("notes/a.md", bytes);        // create a file (and parents)
 *   fs.failOn(/versions\/.*\.md/, { stage: "close" });   // next matching operations throw
 *   fs.truncateOn(/\.md/, 3);            // close() succeeds but only 3 bytes are stored
 *   fs.files()                           // sorted list of every file path
 *   fs.bytes("notes/a.md")               // stored bytes (or undefined)
 *   fs.root                              // the FileSystemDirectoryHandle-like root
 */
const err = (name, message = name) => new DOMException(message, name);
const toBytes = (data) => {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("Unsupported FakeFs write payload");
};

class FakeFile {
  constructor(bytes, lastModified) {
    this.bytes = bytes;
    this.lastModified = lastModified;
  }
  get size() {
    return this.bytes.length;
  }
  async arrayBuffer() {
    const b = this.bytes;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
}

class FakeFileHandle {
  kind = "file";
  constructor(fs, name, parentPath) {
    this.fs = fs;
    this.name = name;
    this.path = parentPath ? `${parentPath}/${name}` : name;
    this.bytes = new Uint8Array();
    this.lastModified = fs.clock();
  }
  async getFile() {
    this.fs.hit("getFile", this.path);
    return new FakeFile(this.bytes.slice(), this.lastModified);
  }
  async createWritable() {
    const fs = this.fs;
    fs.hit("create", this.path);
    const chunks = [];
    let done = false;
    const handle = this;
    return {
      async write(data) {
        if (done) throw err("InvalidStateError", "Writable closed");
        fs.hit("write", handle.path);
        chunks.push(toBytes(data).slice());
      },
      async close() {
        if (done) throw err("InvalidStateError", "Writable closed");
        fs.hit("close", handle.path);
        done = true;
        let all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.length;
        }
        const keep = fs.truncation(handle.path);
        if (keep !== null) all = all.slice(0, keep);
        handle.bytes = all;
        handle.lastModified = fs.clock();
      },
      async abort() {
        done = true;
        chunks.length = 0;
      },
    };
  }
  async isSameEntry(other) {
    return other === this;
  }
}

class FakeDirHandle {
  kind = "directory";
  constructor(fs, name, parentPath) {
    this.fs = fs;
    this.name = name;
    this.path = parentPath === null ? "" : parentPath ? `${parentPath}/${name}` : name;
    this.children = new Map();
  }
  #check(name) {
    if (!name || name.includes("/") || name === "." || name === "..")
      throw new TypeError(`Invalid name: ${name}`);
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    this.#check(name);
    this.fs.hit("getDirectory", this.#child(name));
    const found = this.children.get(name);
    if (found) {
      if (found.kind !== "directory") throw err("TypeMismatchError");
      return found;
    }
    if (!create) throw err("NotFoundError", `${name} not found`);
    const dir = new FakeDirHandle(this.fs, name, this.path);
    this.children.set(name, dir);
    return dir;
  }
  async getFileHandle(name, { create = false } = {}) {
    this.#check(name);
    this.fs.hit("getFileHandle", this.#child(name));
    const found = this.children.get(name);
    if (found) {
      if (found.kind !== "file") throw err("TypeMismatchError");
      return found;
    }
    if (!create) throw err("NotFoundError", `${name} not found`);
    const file = new FakeFileHandle(this.fs, name, this.path);
    this.children.set(name, file);
    return file;
  }
  async removeEntry(name, { recursive = false } = {}) {
    this.#check(name);
    this.fs.hit("remove", this.#child(name));
    const found = this.children.get(name);
    if (!found) throw err("NotFoundError", `${name} not found`);
    if (found.kind === "directory" && found.children.size && !recursive)
      throw err("InvalidModificationError", "Directory not empty");
    this.children.delete(name);
  }
  #child(name) {
    return this.path ? `${this.path}/${name}` : name;
  }
  async *entries() {
    for (const [name, handle] of [...this.children].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      yield [name, handle];
  }
  async *keys() {
    for await (const [name] of this.entries()) yield name;
  }
  async *values() {
    for await (const [, handle] of this.entries()) yield handle;
  }
  [Symbol.asyncIterator]() {
    return this.entries();
  }
  async isSameEntry(other) {
    return other === this;
  }
}

export class FakeFs {
  /** @param {{clock?: () => number}} [options] clock supplies `lastModified` */
  constructor({ clock = () => 1_700_000_000_000 } = {}) {
    this.clock = clock;
    this.root = new FakeDirHandle(this, "root", null);
    this.rules = [];
    this.truncations = [];
    this.log = [];
  }
  hit(op, path) {
    this.log.push(`${op} ${path}`);
    for (const rule of this.rules) {
      if (rule.stage !== "any" && rule.stage !== op) continue;
      if (!matches(rule.pattern, path) || rule.times <= 0) continue;
      rule.times--;
      throw err(rule.name, `Injected ${rule.stage} failure for ${path}`);
    }
  }
  truncation(path) {
    for (const t of this.truncations)
      if (matches(t.pattern, path) && t.times > 0) {
        t.times--;
        return t.keep;
      }
    return null;
  }
  /**
   * Make matching operations throw. `stage` is "create" (createWritable), "write",
   * "close", "getFile" (File.getFile), "getFileHandle", "getDirectory", "remove" or "any". `pattern` is a RegExp or
   * substring tested against the full path from the root.
   */
  failOn(pattern, { stage = "close", times = Infinity, name = "NotAllowedError" } = {}) {
    this.rules.push({ pattern, stage, times, name });
    return this;
  }
  /** `close()` resolves but only the first `keep` bytes are stored (silent short write). */
  truncateOn(pattern, keep = 0, { times = Infinity } = {}) {
    this.truncations.push({ pattern, keep, times });
    return this;
  }
  clearFailures() {
    this.rules.length = 0;
    this.truncations.length = 0;
  }
  async #dir(parts, create) {
    let dir = this.root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
  }
  /** Create or replace a file, creating parents; bypasses failure rules. */
  seed(path, data = "") {
    const parts = path.split("/"),
      name = parts.pop();
    let dir = this.root;
    for (const part of parts) {
      let next = dir.children.get(part);
      if (!next) {
        next = new FakeDirHandle(this, part, dir.path);
        dir.children.set(part, next);
      }
      dir = next;
    }
    const file = new FakeFileHandle(this, name, dir.path);
    file.bytes = toBytes(data).slice();
    dir.children.set(name, file);
    return file;
  }
  /** Stored bytes of a file path, or undefined. */
  bytes(path) {
    let node = this.root;
    for (const part of path.split("/")) {
      node = node?.kind === "directory" ? node.children.get(part) : undefined;
    }
    return node?.kind === "file" ? node.bytes : undefined;
  }
  /** Sorted paths of every file under `prefix` (default: whole tree). */
  files(prefix = "") {
    const out = [];
    const walk = (dir) => {
      for (const [name, child] of dir.children) {
        if (child.kind === "directory") walk(child);
        else out.push(child.path);
      }
    };
    walk(this.root);
    return out.filter((p) => p.startsWith(prefix)).sort();
  }
  /** Sorted paths of every directory (excluding the root). */
  directories() {
    const out = [];
    const walk = (dir) => {
      for (const child of dir.children.values())
        if (child.kind === "directory") {
          out.push(child.path);
          walk(child);
        }
    };
    walk(this.root);
    return out.sort();
  }
}

function matches(pattern, path) {
  return pattern instanceof RegExp ? pattern.test(path) : path.includes(pattern);
}
