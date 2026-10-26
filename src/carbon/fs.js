import { LocalFolder, isLocalFolder } from "./local-files.js";
import { Stack } from "../core/stack.js";
import { assert, path, LIMITS, validatePaths } from "../core/validate.js";
/**
 * Read explicit user-selected files with preflight size/count limits. With `stripRoot` (a folder
 * picked through `<input webkitdirectory>`) the first path segment is the folder itself and is dropped;
 * Carbon's own `.carbon-history/` directory directly under it is skipped, like `readDirectoryFiles`,
 * before anything is counted or read.
 */
export async function readFiles(list, stripRoot = false) {
  const selected = [];
  for (const file of list) {
    let p = file.webkitRelativePath || file.name;
    if (stripRoot) {
      const parts = p.split("/");
      // Exact, case-sensitive name; only a directory (something inside it) is skipped, not a file of that name.
      if (parts.length > 2 && parts[1] === HISTORY_DIR_NAME) continue;
      p = parts.slice(1).join("/");
    }
    selected.push([p, file]);
  }
  assert(selected.length <= LIMITS.files, "Too many selected files");
  let total = 0;
  const files = [];
  for (const [p, file] of selected) {
    path(p);
    total += file.size;
    assert(
      file.size <= LIMITS.file && total <= LIMITS.total,
      "Import size limit exceeded",
    );
    files.push([p, new Uint8Array(await file.arrayBuffer())]);
  }
  // Preserve duplicates for validation before constructing Map.
  validatePaths(files.map(([p]) => p));
  return files;
}
export async function readDirectory(handle) {
  const { files, directories } = await readDirectoryFiles(handle);
  return new Stack(files, directories);
}
/** Disk history lives in this root-level directory of a linked folder; it is never workspace content. */
export const HISTORY_DIR_NAME = ".carbon-history";
/**
 * Read a whole folder: `files` as `[path, bytes]` pairs, `directories` (every directory, empty ones
 * included) and `modified` (`File.lastModified` per file path, for source observation).
 */
export async function readDirectoryFiles(handle) {
  const files = [],
    dirs = [],
    modified = new Map();
  let total = 0,
    count = 0;
  async function walk(dir, prefix = "") {
    for await (const [name, child] of dir.entries()) {
      // Carbon's own on-disk history never appears in the tree, search or exports.
      if (!prefix && name === HISTORY_DIR_NAME && child.kind === "directory") continue;
      const p = path(prefix + name);
      assert(++count <= LIMITS.files, "Folder count limit exceeded");
      if (child.kind === "directory") {
        dirs.push(p);
        await walk(child, p + "/");
      } else {
        assert(child.kind === "file", "Unsupported filesystem handle type");
        const f = await child.getFile();
        total += f.size;
        assert(
          f.size <= LIMITS.file && total <= LIMITS.total,
          "Folder size limit exceeded",
        );
        files.push([p, new Uint8Array(await f.arrayBuffer())]);
        modified.set(p, f.lastModified);
      }
    }
  }
  await walk(handle);
  return { files, directories: dirs, modified };
}
/** Write a complete snapshot into a NEW child directory; never overwrite or delete. */
export async function saveDirectory(parent, stack, name) {
  path(name);
  assert(!name.includes("/"), "Snapshot name must be one component");
  try {
    await parent.getDirectoryHandle(name);
    throw new Error("Snapshot folder already exists; choose a new folder name");
  } catch (e) {
    if (e.name !== "NotFoundError") throw e;
  }
  const root = await parent.getDirectoryHandle(name, { create: true });
  async function directory(parts) {
    let dir = root;
    for (const part of parts)
      dir = await dir.getDirectoryHandle(part, { create: true });
    return dir;
  }
  for (const p of stack.directories) await directory(p.split("/"));
  // Manifest is written last. A failed write leaves an explicitly incomplete snapshot.
  for (const [p, b] of [...stack.files].sort(([a], [b]) =>
    a === "stack.yaml" ? 1 : b === "stack.yaml" ? -1 : a.localeCompare(b),
  )) {
    const parts = p.split("/"),
      name = parts.pop(),
      dir = await directory(parts);
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    try {
      await writable.write(b);
      await writable.close();
    } catch (e) {
      await writable.abort().catch(() => {});
      throw e;
    }
  }
  return name;
}
export function download(bytes, name, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
/** All remembered linked-folder records as `{ key, value }` (value: `{ handle, consent, history, updatedAt }`). */
export async function foldersRead(db) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains("folders")) return resolve([]);
    const out = [];
    const r = db.transaction("folders").objectStore("folders").openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return resolve(out);
      out.push({ key: c.key, value: c.value });
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
}
/** Insert (no key) or replace (key) one remembered linked-folder record. */
export async function foldersWrite(db, value, key) {
  return new Promise((resolve, reject) => {
    const t = db.transaction("folders", "readwrite");
    const store = t.objectStore("folders");
    if (key === undefined) store.put(value);
    else store.put(value, key);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Folder memory aborted"));
  });
}
/** Delete one remembered linked-folder record by key. */
export async function foldersDelete(db, key) {
  return new Promise((resolve, reject) => {
    const t = db.transaction("folders", "readwrite");
    t.objectStore("folders").delete(key);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Folder memory aborted"));
  });
}
export const packStack = (s) => ({
  files: [...s.files],
  directories: [...s.directories],
  ...(isLocalFolder(s) ? { kind: "folder", metadata: s.manifest } : {}),
});
export const unpackStack = (s) => s.kind === "folder"
  ? new LocalFolder(s.files, s.directories, s.metadata)
  : new Stack(s.files, s.directories);
