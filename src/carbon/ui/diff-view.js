/**
 * Pure diff rendering for Return review: (before, after) -> DOM. No state, no deps.
 * Uses core `diffLines` for the hunks; when it returns null (budget exhausted) the view
 * shows the explicit "complete original and proposed" fallback instead of a partial diff.
 *
 * Trust: both texts are untrusted (proposed bodies come from the Return). Every line is
 * a text node; nothing is parsed as HTML.
 */
import { diffLines } from "../../core/handoff.js";
import { el } from "./dom.js";

/** Unchanged runs longer than this stay folded until the viewer expands them. */
export const FOLD_AT = 7;

/**
 * One table row of the unified diff. Two line-number gutters, a sign column and the text.
 * @param {"add"|"del"|""} cls
 * @param {number|""} a line number in the original
 * @param {number|""} b line number in the proposal
 * @param {string} text
 * @returns {HTMLTableRowElement}
 */
function row(cls, a, b, text) {
  const tr = el("tr", undefined, cls);
  const sign = cls === "add" ? "+" : cls === "del" ? "−" : "";
  const sg = el("td", sign, "sg");
  sg.setAttribute(
    "aria-label",
    cls === "add" ? "added" : cls === "del" ? "removed" : "unchanged",
  );
  tr.append(
    el("td", a === "" ? "" : String(a), "ln"),
    el("td", b === "" ? "" : String(b), "ln"),
    sg,
    el("td", text === "" ? " " : text, "tx"),
  );
  return tr;
}

/**
 * Unified diff table for a replaced Entry. Folded runs render a "⋯ n unchanged lines ·
 * show" button; `expanded` records which hunks the viewer opened so a re-render keeps
 * them open.
 * @param {string} before original text
 * @param {string} after proposed text
 * @param {{expanded?: Set<number>, onExpand?: (hunkIndex: number) => void}} [opts]
 * @returns {HTMLElement} a `<table class="udiff">`, or the full-text fallback block
 */
export function diffTable(before, after, { expanded = new Set(), onExpand } = {}) {
  const lines = diffLines(before, after);
  if (!lines) return fullTextFallback(before, after);
  const a = before.split("\n");
  const table = el("table", undefined, "udiff");
  table.setAttribute("aria-label", "Line diff");
  const body = el("tbody");
  let la = 1,
    lb = 1,
    hunk = 0;
  for (const line of lines) {
    if (line.kind === "hunk") {
      const n = Number((line.text.match(/(\d+) unchanged/) || [])[1] || 0);
      const index = hunk++;
      if (n > FOLD_AT && !expanded.has(index)) {
        const tr = el("tr", undefined, "fold"),
          td = el("td");
        td.colSpan = 4;
        const b = el("button", `⋯ ${n} unchanged lines · show`, "sm quiet");
        b.type = "button";
        b.onclick = () => onExpand?.(index);
        td.append(b);
        tr.append(td);
        body.append(tr);
      } else for (let i = 0; i < n; i++) body.append(row("", la + i, lb + i, a[la - 1 + i] ?? ""));
      la += n;
      lb += n;
    } else if (line.kind === "added") body.append(row("add", "", lb++, line.text));
    else if (line.kind === "removed") body.append(row("del", la++, "", line.text));
    else body.append(row("", la++, lb++, line.text));
  }
  table.append(body);
  return table;
}

/**
 * Explicit full-text comparison used when the compact diff budget is exceeded.
 * @param {string} before
 * @param {string} after
 * @returns {HTMLElement}
 */
export function fullTextFallback(before, after) {
  const box = el("div", undefined, "diff-fallback");
  box.append(
    el(
      "p",
      "This change exceeds the compact diff budget. Review the complete original and proposed text below; no changes are hidden.",
      "hint",
    ),
    el("h4", "Original"),
    el("pre", before),
    el("h4", "Proposed"),
    el("pre", after),
  );
  return box;
}

/**
 * Whole-file view for a created (`+` gutter) or deleted (`−` gutter) Entry.
 * @param {string} text
 * @param {"add"|"del"} kind
 * @returns {HTMLTableElement}
 */
export function wholeFile(text, kind) {
  const table = el("table", undefined, "udiff");
  table.setAttribute("aria-label", kind === "add" ? "New file content" : "Removed file content");
  const body = el("tbody");
  text.split("\n").forEach((line, i) => {
    body.append(kind === "add" ? row("add", "", i + 1, line) : row("del", i + 1, "", line));
  });
  table.append(body);
  return table;
}

/**
 * Rename view: from → to, content and ID unchanged.
 * @param {string} from
 * @param {string} to
 * @param {string|null} content original text (for the line count)
 * @returns {HTMLElement}
 */
export function renameView(from, to, content) {
  const box = el("div", undefined, "answer");
  const p = el("p", "Path changes from ");
  p.append(el("code", from), " to ", el("code", to), `. Content and ID unchanged${content == null ? "" : ` (${content.split("\n").length} lines)`}.`);
  box.append(p, el("p", "Links to the old path are not rewritten.", "hint"));
  return box;
}

/**
 * Dotted metadata box listing scalar field changes: field / before / after / permitted.
 * @param {{key: string, before: unknown, after: unknown, permitted: boolean}[]} metadata
 * @returns {HTMLElement}
 */
export function metadataBox(metadata) {
  const box = el("div", undefined, "metachg");
  box.append(el("b", "Metadata (scalar)"));
  const table = el("table"),
    body = el("tbody");
  const show = (v) => (typeof v === "string" ? JSON.stringify(v) : v === undefined ? "—" : String(v));
  for (const m of metadata) {
    const tr = el("tr");
    tr.append(
      el("td", m.key),
      el("td", show(m.before)),
      el("td", "→"),
      el("td", show(m.after)),
      el("td", m.permitted ? "✓ permitted" : "✕ not permitted", m.permitted ? "" : "fail"),
    );
    body.append(tr);
  }
  table.append(body);
  box.append(table);
  return box;
}

/**
 * Count changed lines of a replace (added + removed) for the file list; null when the
 * diff budget is exceeded.
 * @param {string} before
 * @param {string} after
 * @returns {number|null}
 */
export function changedLineCount(before, after) {
  const lines = diffLines(before, after);
  return lines ? lines.filter((l) => l.kind === "added" || l.kind === "removed").length : null;
}
