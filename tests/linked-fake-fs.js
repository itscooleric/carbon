/** In-memory FileSystemDirectoryHandle fake with fault injection, for linked-folder unit tests. */
const dom = (name, message) => Object.assign(new Error(message || name), { name });

export function fakeFolder(files = {}, { name = "Folder", caseInsensitive = false } = {}) {
  const ctl = {
    perm: { read: "granted", readwrite: "granted" },
    request: "granted", // result of requestPermission
    queries: 0, requests: 0,
    writes: [], aborts: 0, closes: 0,
    creates: 0, // getFileHandle / getDirectoryHandle with { create: true } that created something, plus every createWritable
    reads: 0, // getFile calls
    failWrite: null, // Error thrown by writable.write
    failClose: null, // Error thrown by writable.close (nothing committed)
    corruptOnClose: false, // commit different bytes than written
    beforeGetFile: null, // (path) => void, runs before each getFile (simulate external edits)
    modified: 1000,
  };
  const root = { kind: "directory", name, children: new Map() };
  const put = (path, bytes) => {
    const parts = path.split("/"), leaf = parts.pop();
    let at = root;
    for (const part of parts) {
      if (!at.children.has(part)) at.children.set(part, { kind: "directory", name: part, children: new Map() });
      at = at.children.get(part);
    }
    at.children.set(leaf, { kind: "file", name: leaf, bytes: new Uint8Array(bytes), modified: ctl.modified++ });
  };
  const enc = (v) => (typeof v === "string" ? new TextEncoder().encode(v) : v);
  for (const [p, v] of Object.entries(files)) put(p, enc(v));
  const find = (path) => {
    let at = root;
    for (const part of path.split("/")) {
      at = at?.children?.get(part);
      if (!at) return null;
    }
    return at;
  };
  /** A child by name; with `caseInsensitive` (macOS/Windows defaults) a name differing only by case finds it. */
  const child = (node, n) => node.children.get(n) ?? (caseInsensitive ? [...node.children.values()].find((c) => c.name.toUpperCase() === n.toUpperCase()) : undefined);
  function handle(node, path = "") {
    const h = {
      kind: node.kind,
      name: node.name,
      node,
      async isSameEntry(other) { return other?.node === node; },
      async queryPermission({ mode }) { ctl.queries++; return ctl.perm[mode]; },
      async requestPermission({ mode }) {
        ctl.requests++;
        if (ctl.request === "granted") ctl.perm[mode] = "granted";
        if (mode === "readwrite" && ctl.request === "granted") ctl.perm.read = "granted";
        return ctl.request;
      },
    };
    if (node.kind === "directory") {
      h.entries = async function* () { for (const [n, c] of node.children) yield [n, handle(c, `${path}${n}/`)]; };
      h.getFileHandle = async (n, { create } = {}) => {
        let c = child(node, n);
        if (!c && create) { c = { kind: "file", name: n, bytes: new Uint8Array(), modified: ctl.modified++ }; node.children.set(n, c); ctl.creates++; }
        if (!c) throw dom("NotFoundError", `${n} not found`);
        if (c.kind !== "file") throw dom("TypeMismatchError");
        return handle(c, path + n);
      };
      h.getDirectoryHandle = async (n, { create } = {}) => {
        let c = child(node, n);
        if (!c && create) { c = { kind: "directory", name: n, children: new Map() }; node.children.set(n, c); ctl.creates++; }
        if (!c) throw dom("NotFoundError", `${n} not found`);
        if (c.kind !== "directory") throw dom("TypeMismatchError");
        return handle(c, `${path}${n}/`);
      };
      h.removeEntry = async (n) => { if (!node.children.delete(n)) throw dom("NotFoundError"); };
    } else {
      h.getFile = async () => {
        ctl.reads++;
        ctl.beforeGetFile?.(path);
        return new File([node.bytes], node.name, { lastModified: node.modified });
      };
      h.createWritable = async () => {
        ctl.creates++;
        let pending = null;
        return {
          async write(b) { if (ctl.failWrite) throw ctl.failWrite; pending = new Uint8Array(b); },
          async close() {
            ctl.closes++;
            if (ctl.failClose) throw ctl.failClose;
            node.bytes = ctl.corruptOnClose ? new Uint8Array([...pending, 33]) : pending;
            node.modified = ctl.modified++;
            ctl.writes.push([path, node.bytes]);
          },
          async abort() { ctl.aborts++; pending = null; },
        };
      };
    }
    return h;
  }
  return {
    root: handle(root), ctl,
    bytes: (p) => find(p)?.bytes ?? null,
    text: (p) => (find(p) ? new TextDecoder().decode(find(p).bytes) : null),
    put: (p, v) => put(p, enc(v)),
    /** Create an (empty) directory, and any missing parents. */
    mkdir: (p) => {
      let at = root;
      for (const part of p.split("/")) {
        if (!at.children.has(part)) at.children.set(part, { kind: "directory", name: part, children: new Map() });
        at = at.children.get(part);
      }
    },
    remove: (p) => { const parts = p.split("/"), leaf = parts.pop(); const d = parts.length ? find(parts.join("/")) : root; d.children.delete(leaf); },
    has: (p) => !!find(p),
    /** Handle for an existing path ("" is the root), or null. */
    at: (p) => { const n = p ? find(p) : root; return n ? handle(n, n.kind === "directory" && p ? p + "/" : p) : null; },
    list: (dir) => { const n = dir ? find(dir) : root; return n ? [...n.children.keys()] : []; },
  };
}
