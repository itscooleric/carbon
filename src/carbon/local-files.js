/** Ordinary local copies. Metadata here belongs to Carbon's cache, never source files. */
import {
  assert, path, id, decode, encode, validatePaths, LIMITS,
} from "../core/validate.js";
import { Stack, newStack, restoreRevision } from "../core/stack.js";
import { entry, editorSource } from "../core/entries.js";
import { writeTar, writeTarFiles } from "../archives/tar.js";

export const isLocalFolder = (workspace) => workspace?.kind === "folder";
/** Stable identity of the default Scratch workspace: tabs, drafts and its storage record key off it. */
export const SCRATCH_ID = "local-scratch";
export const isScratch = (workspace) => isLocalFolder(workspace) && workspace.manifest.id === SCRATCH_ID;
/** Root-level note name for a day in local time: `YYYY-MM-DD.md`. */
export function scratchNoteName(date = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}.md`;
}
/** A fresh Scratch workspace holding one empty Markdown note, ready to type into. */
export function scratchFolder(date = new Date()) {
  return new LocalFolder([[scratchNoteName(date), new Uint8Array()]], [], { id: SCRATCH_ID, title: "Scratch" });
}
/** Dispatch / Return are Envoy Stack protocols; an ordinary copy must be converted explicitly first. */
export function assertStack(workspace) {
  assert(!isLocalFolder(workspace), "Dispatch / Return requires an Envoy Stack. Use Open / Import → Create Envoy Stack from copy first; ordinary files remain available without conversion.");
}

/** Same bounded inventory interface as Stack, without Envoy metadata requirements. */
export class LocalFolder {
  constructor(files = [], directories = [], metadata = {}) {
    const members = [...files];
    this.kind = "folder";
    this.files = new Map(members);
    this.directories = new Set(directories);
    validatePaths(members.map(([p]) => p), this.directories);
    let total = 0;
    for (const [p, bytes] of members) {
      assert(
        bytes instanceof Uint8Array && bytes.length <= LIMITS.file,
        `File too large: ${p}`,
      );
      total += bytes.length;
    }
    for (const p of [...this.files.keys(), ...this.directories]) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++)
        this.directories.add(parts.slice(0, i).join("/"));
    }
    assert(total <= LIMITS.total, "Folder total size limit exceeded");
    assert(
      this.files.size + this.directories.size <= LIMITS.files,
      "Folder file-count limit exceeded",
    );
    const identity = metadata.id ?? `local-${crypto.randomUUID()}`;
    id(identity);
    const revision = metadata.revision ?? 0,
      title = metadata.title ?? "Local files";
    assert(Number.isSafeInteger(revision) && revision >= 0, "Invalid local revision");
    assert(typeof title === "string" && title.length <= 200, "Invalid folder title");
    // In-memory interface for existing tabs/history; never a synthesized stack.yaml.
    this.manifest = { id: identity, revision, title };
  }
  text(p) {
    assert(this.files.has(p), `Missing file: ${p}`);
    return decode(this.files.get(p));
  }
  change({ writes = new Map(), deletes = [], moves = [], directories = this.directories } = {}) {
    const files = new Map(this.files);
    for (const [from, to] of moves) {
      path(to);
      assert(files.has(from) && !files.has(to), "Invalid move target");
      files.set(to, files.get(from));
      files.delete(from);
    }
    for (const p of deletes) {
      assert(files.has(p), `Missing deletion target: ${p}`);
      files.delete(p);
    }
    for (const [p, bytes] of writes) {
      // Committed Markdown edits must be bounded text. Other files retain original bytes; editor
      // saves of any text file are checked by `saveBytes` before they get here.
      if (isMarkdown(p)) documentText(decode(bytes));
      files.set(p, bytes);
    }
    return new LocalFolder(files, directories, {
      ...this.manifest, revision: this.manifest.revision + 1,
    });
  }
}
function documentText(source) {
  assert(
    encode(source).length <= LIMITS.text && !source.includes("\0"),
    "Markdown text limit or NUL violation",
  );
  return source;
}
/** Whether `path` is a Markdown document: the only files that get frontmatter, Markdown rendering and wiki links. */
export const isMarkdown = (path) => typeof path === "string" && /\.md$/i.test(path);

const issues = new WeakMap();
/**
 * Why bytes cannot be edited as text, or null when they can: at most `LIMITS.text` bytes, no NUL
 * anywhere and strict UTF-8 (a BOM is fine). Cached per byte array; `canEdit` runs for every file
 * when the tree, the link index or a tab list is built.
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
export function textIssue(bytes) {
  if (!(bytes instanceof Uint8Array)) return "not a file";
  if (issues.has(bytes)) return issues.get(bytes);
  let issue = null;
  if (bytes.length > LIMITS.text) issue = `larger than the ${LIMITS.text / 1024 ** 2} MiB text editing limit`;
  else if (bytes.includes(0)) issue = "it contains NUL bytes, so it is treated as binary";
  else {
    try {
      decode(bytes);
    } catch {
      issue = "it is not valid UTF-8 text";
    }
  }
  issues.set(bytes, issue);
  return issue;
}
/** Whether bytes at `p` would open in the Editor in a local copy: bounded valid UTF-8 text without NUL, any name. */
export function editableBytes(p, bytes) {
  return typeof p === "string" && textIssue(bytes) === null;
}
/**
 * Whether `p` opens in the Editor. Ordinary workspaces (Scratch, local copies, linked folders) edit
 * any bounded text by its bytes; strict Envoy Stacks edit Markdown Entries only.
 */
export function canEdit(workspace, p) {
  if (typeof p !== "string" || !workspace.files.has(p)) return false;
  // Strict Stacks already validate every Markdown member at construction.
  if (!isLocalFolder(workspace)) return isMarkdown(p);
  return textIssue(workspace.files.get(p)) === null;
}
/** The file to open when no current one is known: the first Markdown document, else the first editable text file. */
export function defaultDocument(workspace) {
  const paths = [...workspace.files.keys()].filter((p) => canEdit(workspace, p));
  return paths.find(isMarkdown) ?? paths[0] ?? null;
}
/**
 * Ordinary metadata is optional display information, never a managed identity. Plain text (any
 * path not ending in `.md`) has no frontmatter: a YAML file starting with `---` is just text.
 */
export function entryFor(workspace, source, path = null) {
  if (!isLocalFolder(workspace)) return entry(source);
  documentText(source);
  if (path !== null && !isMarkdown(path)) return { data: {}, body: source, frontmatter: "" };
  try {
    const parsed = entry(source), data = { ...parsed.data };
    delete data.id;
    return { ...parsed, data };
  } catch {
    return { data: {}, body: source, frontmatter: "" };
  }
}

// ---- line endings and BOM ------------------------------------------------------------------------
// The editor always holds LF text without a BOM. A draft is the file's text as it would be saved:
// the committed file's BOM and uniform line-ending convention are re-applied to every edit, so
// unchanged lines keep their bytes. Mixed conventions cannot be re-applied and are never rewritten
// implicitly (see `saveBytes`).

const BOM = "\uFEFF";
let lastFormat = { source: null, format: null };
/**
 * Line-ending convention and BOM of committed text.
 * @param {string} source
 * @returns {{bom: boolean, eol: "none"|"lf"|"crlf"|"cr"|"mixed", counts: {lf: number, crlf: number, cr: number}}}
 */
export function textFormat(source) {
  if (lastFormat.source === source) return lastFormat.format; // sourceFor runs on every keystroke
  const counts = { lf: 0, crlf: 0, cr: 0 };
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 10) counts.lf++;
    else if (c === 13) {
      if (source.charCodeAt(i + 1) === 10) {
        counts.crlf++;
        i++;
      } else counts.cr++;
    }
  }
  const kinds = Object.keys(counts).filter((k) => counts[k] > 0);
  const format = { bom: source.startsWith(BOM), eol: kinds.length === 0 ? "none" : kinds.length === 1 ? kinds[0] : "mixed", counts };
  lastFormat = { source, format };
  return format;
}
/** Words for a line-ending mix, for example "3 CRLF, 1 LF". */
export function describeLineEndings({ counts }) {
  return [["crlf", "CRLF"], ["lf", "LF"], ["cr", "CR"]]
    .filter(([k]) => counts[k])
    .map(([k, label]) => `${counts[k]} ${label}`)
    .join(", ");
}
const committedText = (workspace, path) => {
  try {
    return workspace.text(path);
  } catch {
    return ""; // not decodable: there is no convention to keep
  }
};
/**
 * Editor text for `source` (a draft or the committed text of `path`): LF line breaks and no BOM. A
 * leading U+FEFF is a byte-order mark, so whether a saved file has one follows the committed file.
 */
export function toEditorText(source) {
  return (source.startsWith(BOM) ? source.slice(1) : source).replace(/\r\n?/g, "\n");
}
/**
 * Turn editor text (always LF, no BOM) back into the file's text: its BOM and uniform LF / CRLF /
 * lone-CR line endings are re-applied; an unchanged Stack frontmatter keeps its exact bytes. Text
 * whose original mixes line endings comes back with LF, which `saveBytes` refuses to save unless
 * that rewrite is explicitly chosen. Over-limit drafts stay recoverable; limits apply on save.
 */
export function sourceFor(workspace, text, original) {
  const format = textFormat(original);
  const value = (format.bom ? BOM : "") + text;
  // `editorSource` keeps an unchanged frontmatter's bytes and restores uniform CRLF.
  const next = isLocalFolder(workspace)
    ? format.eol === "crlf" ? value.replace(/\n/g, "\r\n") : value
    : editorSource(value, original);
  return format.eol === "cr" ? next.replace(/\n/g, "\r") : next;
}
/** A save refused because the committed file mixes line endings; the UI offers the explicit LF rewrite. */
export class MixedLineEndingsError extends Error {
  constructor(path, format) {
    super(`${path} mixes line endings (${describeLineEndings(format)}), so Carbon cannot save it without changing them. Nothing was saved; your draft is kept. Download the original file, or choose Save with LF line endings.`);
    this.name = "MixedLineEndingsError";
    this.path = path;
    this.format = format;
  }
}
/**
 * The text Save would write for the draft of `path` (read-only, unchecked): the draft rebuilt
 * against the file as committed now, since a draft kept across Refresh from folder or Reload file
 * from disk still carries the conventions of the version it was typed against. A file whose
 * committed text mixes line endings comes back with every line break as LF, which only the explicit
 * LF choice saves. `saveBytes` adds the checks; Text details reports the size.
 * @param {import("./types.js").Documents} workspace
 * @param {string} path
 * @param {string} draft
 */
export function saveSource(workspace, path, draft) {
  const committed = committedText(workspace, path), format = textFormat(committed);
  const rebuilt = sourceFor(workspace, toEditorText(draft), committed);
  return { source: format.eol === "mixed" ? rebuilt.replace(/\r\n?/g, "\n") : rebuilt, format };
}
/**
 * Bytes to commit for the draft of `path`, or an Error that leaves everything unchanged: the draft
 * takes the committed file's current BOM and line-ending convention, it must be bounded text
 * without NUL (any file, not only Markdown), and a file whose committed text mixes line endings is
 * saved only with `lf` (the explicit "Save with LF line endings" choice), which turns every line
 * break into LF and keeps a BOM.
 * @param {import("./types.js").Documents} workspace
 * @param {string} path
 * @param {string} draft
 * @param {{lf?: boolean}} [options]
 * @returns {Uint8Array}
 * @throws {MixedLineEndingsError|Error}
 */
export function saveBytes(workspace, path, draft, { lf = false } = {}) {
  assert(typeof draft === "string", `No draft to save for ${path}`);
  const { source, format } = saveSource(workspace, path, draft);
  if (format.eol === "mixed" && !lf) throw new MixedLineEndingsError(path, format);
  const bytes = encode(source);
  assert(
    bytes.length <= LIMITS.text && !source.includes("\0"),
    `Text limit or NUL violation: ${path} can be saved from the Editor only as text of at most ${LIMITS.text / 1024 ** 2} MiB without NUL characters. Nothing was saved; your draft is kept.`,
  );
  return bytes;
}
/** Explicit conversion builds a separate validated Stack; it never repairs source files. */
export function toEnvoyStack(folder) {
  assert(isLocalFolder(folder), "This workspace is already an Envoy Stack");
  assert(
    ![...folder.files.keys(), ...folder.directories].some(p => p.toLowerCase() === "stack.yaml"),
    "Rename the existing stack.yaml file or directory before creating an Envoy Stack; it will not be overwritten.",
  );
  const base = newStack(folder.manifest.title);
  return new Stack([...base.files, ...folder.files], folder.directories);
}
export function restoreFolder(current, history, old) {
  return new LocalFolder(old.files, old.directories, {
    ...old.manifest, revision: restoreRevision(current, history, old),
  });
}
export function archiveWorkspace(workspace) {
  return isLocalFolder(workspace)
    ? writeTarFiles(workspace.files, workspace.directories, "documents")
    : writeTar(workspace);
}
export const archiveName = (workspace) =>
  `${workspace.manifest.id}-r${workspace.manifest.revision}.${isLocalFolder(workspace) ? "folder" : "stack"}.tar`;
