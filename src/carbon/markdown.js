import { Marked } from "marked";
import createDOMPurify from "dompurify";
import { hljs } from "./highlight.js";
import { canEdit, entryFor, isMarkdown } from "./local-files.js";
import { entry } from "../core/entries.js";
const escape = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const renderer = {
  html({ text }) {
    return escape(text);
  },
  code({ text, lang }) {
    const language = lang?.split(/\s/)[0];
    return `<pre><code>${language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escape(text)}</code></pre>`;
  },
  image({ text, href }) {
    return `<span class="asset-label" data-carbon-image="${escape(href)}" data-image-alt="${escape(text)}">[Image: ${escape(text)}]</span>`;
  },
};
const markdown = new Marked();
markdown.use({ renderer });

/**
 * Render an Entry's body to sanitized HTML: frontmatter is stripped, raw HTML in the
 * Markdown is escaped to literal text, code is highlighted, images become text labels, and
 * DOMPurify allows only the listed tags/attributes and safe `href` schemes.
 * @param {string} source  full Entry text (untrusted)
 * @param {Window} window  DOM window for DOMPurify
 * @returns {string}  HTML safe to assign to `innerHTML`
 * @throws {Error} when the source exceeds the Entry text limit or its frontmatter is invalid
 */
export function renderMarkdown(source, window, workspace = null) {
  const body = entryFor(workspace, source).body;
  const html = markdown.parse(body, {
    gfm: true,
    breaks: false,
    async: false,
  });
  const purify = createDOMPurify(window);
  return purify.sanitize(html, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "del",
      "blockquote",
      "ul",
      "ol",
      "li",
      "pre",
      "code",
      "span",
      "a",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "input",
    ],
    ALLOWED_ATTR: [
      "href",
      "title",
      "class",
      "type",
      "checked",
      "disabled",
      "data-carbon-image",
      "data-image-alt",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto):|#|\.?\.?\/|[A-Za-z0-9_%-][^:]*$)/i,
    FORBID_TAGS: ["style", "script", "iframe", "svg", "math", "form"],
  });
}
// Stack transactions create new objects, so each committed revision gets one immutable index.
const indexes = new WeakMap();
/** Stable ID first; otherwise aliases plus the `from`-relative path, null when ambiguous. */
function candidates(index, target, from) {
  const raw = target.split("|")[0].trim();
  if (index.ids.has(raw)) return index.ids.get(raw);
  const relative = from.split("/").slice(0, -1);
  for (const part of raw.split("/")) {
    if (part === "..") relative.pop();
    else if (part !== ".") relative.push(part);
  }
  const matches = new Set(index.aliases.get(raw) || []);
  const rel = relative.join("/");
  if (index.paths.has(rel)) matches.add(rel);
  return matches.size === 1 ? [...matches][0] : null;
}
/**
 * Build (once per Stack object) the link index: `ids` (stable ID -> path, unique by Stack
 * invariant), `aliases` (path, path without `.md`, basename -> Set of paths), `paths` and
 * `backlinks` (path -> Set of referring paths, resolved with the same rules as navigation).
 */
function* indexSteps(stack) {
  const index = {
    ids: new Map(),
    aliases: new Map(),
    paths: new Set(),
    backlinks: new Map(),
  };
  const references = [];
  for (const p of stack.files.keys()) {
    // Wiki links connect Markdown documents only; plain text files are never parsed for them.
    if (!isMarkdown(p) || !canEdit(stack, p)) { yield; continue; }
    index.paths.add(p);
    const source = stack.text(p);
    const parsed = entryFor(stack, source, p);
    const id = parsed.data.id;
    if (id !== undefined) index.ids.set(id, p);
    for (const key of [
      p,
      p.replace(/\.md$/i, ""),
      p.split("/").pop().replace(/\.md$/i, ""),
    ]) {
      if (!index.aliases.has(key)) index.aliases.set(key, new Set());
      index.aliases.get(key).add(p);
    }
    references.push([p, scanWikiLinks(parsed.body).map((x) => x.target)]);
    yield; // Bound cold-index work to one already size-limited Entry.
  }
  let work = 0;
  for (const [from, targets] of references) {
    for (const target of targets) {
      if (++work % 256 === 0) yield;
      const to = candidates(index, target, from);
      if (!to || to === from) continue;
      if (!index.backlinks.has(to)) index.backlinks.set(to, new Set());
      index.backlinks.get(to).add(from);
    }
  }
  indexes.set(stack, index); // Publish only a complete index.
}
function entryIndex(stack) {
  if (!indexes.has(stack)) for (const _ of indexSteps(stack)) { /* synchronous navigation */ }
  return indexes.get(stack);
}
/** Warm the shared resolver with bounded work and cancellation, without publishing partial indexes. */
export async function prepareEntryIndex(stack, { pause, cancelled }) {
  if (cancelled()) return false;
  if (indexes.has(stack)) return true;
  for (const _ of indexSteps(stack)) {
    await pause();
    if (cancelled()) return false;
  }
  return true;
}
/**
 * Resolve a `[[target]]` (optionally `[[target|label]]`) to an Entry path.
 * An exact stable-ID match always wins; otherwise full path, path without `.md`, basename
 * and `from`-relative path are tried and the result is null when they are ambiguous.
 * Pure lookup on the committed revision's index; `target` is untrusted text.
 * @param {Stack} stack
 * @param {string} target  link text between the brackets
 * @param {string} [from]  path of the referring Entry for relative targets
 * @returns {string|null}  Entry path, or null when unresolved or ambiguous
 */
export function resolveEntry(stack, target, from = "") {
  return candidates(entryIndex(stack), target, from);
}
/**
 * Entries whose committed body links to `target` under {@link resolveEntry} rules
 * (links inside code or frontmatter do not count). Index is reused per Stack object.
 * @param {Stack} stack
 * @param {string} target  Entry path
 * @returns {string[]}
 */
export function backlinkedEntries(stack, target) {
  return [...(entryIndex(stack).backlinks.get(target) || [])];
}
/**
 * Find `[[target]]` wiki links in a Markdown body, skipping literal code and escapes:
 * fenced blocks (``` or ~~~, up to 3 spaces of indent, closer at least as long and of the
 * same character; an unclosed fence swallows the rest), inline code spans (a backtick run
 * closed by a run of the same length, CommonMark style, within a paragraph), and
 * backslash-escaped punctuation such as `\[[`. Pure; no DOM, no Stack access.
 * @param {string} source  Markdown body (callers strip frontmatter first)
 * @returns {{target: string, start: number, end: number}[]}  raw link text (label included)
 *   and its `[[...]]` offsets in `source`, in document order
 */
export function scanWikiLinks(source) {
  const links = [];
  const open = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  let fence = null,
    paragraph = null;
  const inline = (text, base) => {
    const link = /\[\[([^\]\n]+)\]\]/y;
    for (let i = 0; i < text.length; ) {
      const c = text[i];
      if (c === "\\" && /[!-/:-@[-`{-~]/.test(text[i + 1] || "")) i += 2;
      else if (c === "`") {
        const run = /`+/y;
        run.lastIndex = i;
        const n = run.exec(text)[0].length;
        const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, "g");
        close.lastIndex = i + n;
        const m = close.exec(text);
        i = m ? m.index + n : i + n;
      } else if (c === "[" && text[i + 1] === "[") {
        link.lastIndex = i;
        const m = link.exec(text);
        if (!m) i++;
        else {
          links.push({
            target: m[1],
            start: base + i,
            end: base + i + m[0].length,
          });
          i += m[0].length;
        }
      } else i++;
    }
  };
  const flush = (end) => {
    if (paragraph !== null) inline(source.slice(paragraph, end), paragraph);
    paragraph = null;
  };
  for (let at = 0; at <= source.length; ) {
    const next = source.indexOf("\n", at);
    const end = next < 0 ? source.length : next;
    const line = source.slice(at, end).replace(/\r$/, "");
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length)
        fence = null;
    } else {
      const m = open.exec(line);
      if (m && (m[1][0] === "~" || !m[2].includes("`"))) {
        flush(at);
        fence = m[1];
      } else if (!line.trim()) flush(at);
      else paragraph ??= at;
    }
    at = end + 1;
  }
  flush(source.length);
  return links;
}
/**
 * Wiki-link targets of an Entry source: frontmatter is skipped and {@link scanWikiLinks}
 * rules apply to the body.
 * @param {string} source  full Entry text (untrusted)
 * @returns {string[]}  raw targets in document order (duplicates kept)
 * @throws {Error} when the source exceeds the Entry text limit or its frontmatter is invalid
 */
export function wikiTargets(source) {
  return scanWikiLinks(entry(source).body).map((x) => x.target);
}
