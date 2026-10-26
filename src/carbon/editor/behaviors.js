import { entryFor, canEdit, isMarkdown } from "../local-files.js";
/** Carbon-specific commands. CodeMirror owns input, selections, history and IME. */
import { EditorSelection, countColumn } from "@codemirror/state";
import { ensureSyntaxTree, indentUnit } from "@codemirror/language";
import { indentMore, indentLess } from "@codemirror/commands";
import {
  insertNewlineContinueMarkupCommand,
  deleteMarkupBackward,
} from "@codemirror/lang-markdown";
import { entry } from "../../core/entries.js";
import { resolveEntry } from "../markdown.js";

/** Fail closed while syntax is unavailable, or frontmatter is still being written. */
export function proseAt(state, pos) {
  if (/^\uFEFF?---\s*$/.test(state.doc.line(1).text)) {
    let end = state.doc.length;
    for (let n = 2; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      if (/^(?:---|\.\.\.)\s*$/.test(line.text)) {
        end = line.to;
        break;
      }
    }
    if (pos <= end) return false;
  }
  const tree = ensureSyntaxTree(state, pos, 25);
  if (!tree) return false;
  for (let node = tree.resolveInner(pos, -1); node; node = node.parent)
    if (/^(?:FencedCode|CodeBlock|InlineCode|HTMLBlock)$/.test(node.name))
      return false;
  return true;
}
const continueMarkup = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});
export const continueList = (target) =>
  !target.state.readOnly &&
  target.state.selection.ranges.every((r) => proseAt(target.state, r.head)) &&
  continueMarkup(target);
export const deleteMarkup = (target) =>
  !target.state.readOnly &&
  target.state.selection.ranges.every((r) => proseAt(target.state, r.head)) &&
  deleteMarkupBackward(target);

/** An end selection at column zero excludes that line; overlapping ranges count once. */
function selectedLines(state) {
  const lines = new Set();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(
      range.empty ? range.to : Math.max(range.from, range.to - 1),
    ).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Normalize selected tasks together, leaving non-task Markdown untouched. */
export function toggleTasks({ state, dispatch }) {
  if (state.readOnly) return false;
  const tasks = [];
  for (const n of selectedLines(state)) {
    const line = state.doc.line(n);
    const match = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/.exec(
      line.text,
    );
    if (!match || !proseAt(state, line.from + match[0].length)) continue;
    const from = line.from + match[1].length;
    tasks.push({ from, checked: match[2] !== " " });
  }
  if (!tasks.length) return false;
  const checked = !tasks.every((task) => task.checked);
  const changes = tasks
    .filter((task) => task.checked !== checked)
    .map(({ from }) => ({ from, to: from + 1, insert: checked ? "x" : " " }));
  dispatch(
    state.update({ changes, userEvent: "input.task", scrollIntoView: true }),
  );
  return true;
}

// Markdown tab stops are four columns, independently of the editor's display tab size.
const columns = (text) => countColumn(text, 4);
function itemIndent(state, item) {
  const line = state.doc.lineAt(item.from);
  const match = /^([ \t]*)(?:[-+*]|\d+[.)])(?:[ \t]+|$)/.exec(line.text);
  // Quoted lists have another container prefix; leave their Tab behavior unchanged.
  return match && line.from + match[1].length === item.from
    ? columns(match[1])
    : null;
}
function parentItem(item) {
  for (let node = item.parent; node; node = node.parent)
    if (node.name === "ListItem") return node;
  return null;
}
function contentColumn(state, item) {
  const mark = item.getChild("ListMark"),
    line = state.doc.lineAt(item.from);
  const before = state.sliceDoc(line.from, mark.to);
  const after = /^[ \t]*/.exec(state.sliceDoc(mark.to, line.to))[0];
  const width = columns(before + after) - columns(before);
  return columns(before) + (width > 0 && width <= 4 ? width : 1);
}
function removeIndent(text, amount) {
  const prefix = /^[ \t]*/.exec(text)[0];
  // Removing spaces before a remaining tab can otherwise leave its column unchanged.
  return prefix.includes("\t")
    ? {
        end: prefix.length,
        insert: " ".repeat(Math.max(0, columns(prefix) - amount)),
      }
    : { end: Math.min(prefix.length, amount), insert: "" };
}

/** Move whole list items one structural level, including their attached child content. */
function moveList(target, outward) {
  const { state, dispatch } = target;
  if (state.readOnly || target.composing) return false;
  const lines = selectedLines(state);
  // Parsing through the document also discovers the full extent of selected subtrees.
  const tree = ensureSyntaxTree(state, state.doc.length, 25);
  if (!tree) return false;
  const items = new Map();
  for (const n of lines) {
    const line = state.doc.line(n),
      first = line.text.search(/\S/);
    if (first < 0) continue;
    const pos = line.from + first;
    if (!proseAt(state, pos + 1)) return false;
    let node = tree.resolveInner(pos, 1);
    while (node && node.name !== "ListItem") node = node.parent;
    if (!node || itemIndent(state, node) === null) return false;
    items.set(node.from, node);
  }
  if (!items.size) return false;
  const roots = [...items.values()].filter((item) => {
    for (let parent = parentItem(item); parent; parent = parentItem(parent))
      if (items.has(parent.from)) return false;
    return true;
  });
  const chosen = new Set(roots.map((item) => item.from)),
    changes = [];
  for (const item of roots) {
    let parent;
    if (outward) parent = parentItem(item);
    else {
      parent = item.prevSibling;
      while (parent && chosen.has(parent.from)) parent = parent.prevSibling;
    }
    if (
      !parent ||
      parent.name !== "ListItem" ||
      itemIndent(state, parent) === null
    )
      return false;
    const amount = outward
      ? itemIndent(state, item) - itemIndent(state, parent)
      : contentColumn(state, parent) - itemIndent(state, item);
    if (amount <= 0) return false;
    const first = state.doc.lineAt(item.from).number;
    const last = state.doc.lineAt(Math.max(item.from, item.to - 1)).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      if (!line.text.trim()) continue;
      const prefix = /^[ \t]*/.exec(line.text)[0];
      const removed = outward
        ? removeIndent(line.text, amount)
        : prefix.includes("\t")
          ? { end: prefix.length, insert: " ".repeat(columns(prefix) + amount) }
          : { end: 0, insert: " ".repeat(amount) };
      changes.push({
        from: line.from,
        to: line.from + removed.end,
        insert: removed.insert,
      });
    }
  }
  changes.sort((a, b) => a.from - b.from);
  const changeSet = state.changes(changes);
  dispatch(
    state.update({
      changes: changeSet,
      selection: state.selection.map(changeSet, 1),
      userEvent: outward ? "input.outdent" : "input.indent",
      scrollIntoView: true,
    }),
  );
  return true;
}
export const indentList = (target) => moveList(target, false);
export const outdentList = (target) => moveList(target, true);

/**
 * Tab in the editor: move list items when the selection is in a movable list, otherwise
 * insert an indent unit at each cursor (or indent every selected line). Tab therefore never
 * leaves the editor by itself; CodeMirror's escapes still do (Escape then Tab within two
 * seconds, or Ctrl+M / Mac Alt+Shift+M for persistent focus mode), and read-only or composing
 * input falls through to the browser.
 */
export function indentOrTab(target) {
  if (indentList(target)) return true;
  const { state, dispatch } = target;
  if (state.readOnly || target.composing) return false;
  // Whole-line indentation for selections; otherwise the indent unit (spaces, never a tab character).
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore(target);
  dispatch(state.update(state.replaceSelection(state.facet(indentUnit)), { scrollIntoView: true, userEvent: "input" }));
  return true;
}
/** Shift+Tab: outdent list items, otherwise remove one indent unit from the selected lines. */
export function outdentOrDedent(target) {
  if (outdentList(target)) return true;
  if (target.state.readOnly || target.composing) return false;
  return indentLess(target);
}

export function surround(open, close = open) {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    dispatch(
      state.update(
        state.changeByRange((range) => ({
          changes: [
            { from: range.from, insert: open },
            { from: range.to, insert: close },
          ],
          range: EditorSelection.range(
            range.anchor + open.length,
            range.head + open.length,
          ),
        })),
        { userEvent: "input.format", scrollIntoView: true },
      ),
    );
    return true;
  };
}

const optionsByStack = new WeakMap();
function targets(stack) {
  if (optionsByStack.has(stack)) return optionsByStack.get(stack);
  const result = [];
  for (const [path] of stack.files) {
    if (!isMarkdown(path) || !canEdit(stack, path)) continue;
    let id;
    try {
      id = entryFor(stack, stack.text(path), path).data.id;
    } catch {
      continue;
    }
    for (const target of new Set([
      id,
      path,
      path.replace(/\.md$/i, ""),
      path.split("/").pop().replace(/\.md$/i, ""),
    ])) {
      if (typeof target !== "string" || !target || /[\[\]|\r\n]/.test(target))
        continue;
      result.push({ label: target, detail: path, type: "text", path });
    }
  }
  optionsByStack.set(stack, result);
  return result;
}

/** Suggestions use the same resolver as preview/navigation, including ID precedence. */
export function wikiCompletion(getContext) {
  return (context) => {
    const before = context.matchBefore(/\[\[[^\]\[\n|]*/);
    if (!before || !proseAt(context.state, before.from + 2)) return null;
    const line = context.state.doc.lineAt(before.from);
    const prefix = context.state.sliceDoc(line.from, before.from);
    if ((/\\+$/.exec(prefix)?.[0].length || 0) % 2) return null;
    const { stack, current } = getContext();
    const query = before.text.slice(2).toLowerCase();
    const seen = new Set();
    const options = targets(stack)
      .filter((option) => {
        if (
          !option.label.toLowerCase().includes(query) ||
          seen.has(option.label) ||
          resolveEntry(stack, option.label, current || "") !== option.path
        )
          return false;
        seen.add(option.label);
        return true;
      })
      .slice(0, 200)
      .map(({ path, ...option }) => ({
        ...option,
        apply(view, completion, from, to) {
          // Revalidate against the live Stack, and consume closeBrackets' existing pair.
          const live = getContext();
          if (
            view.state.readOnly ||
            resolveEntry(live.stack, completion.label, live.current || "") !==
              path
          )
            return;
          const suffix = view.state.sliceDoc(to, to + 2);
          const end =
            to + (suffix === "]]" ? 2 : suffix.startsWith("]") ? 1 : 0);
          const insert = completion.label + "]]";
          view.dispatch({
            changes: { from, to: end, insert },
            selection: { anchor: from + insert.length },
            userEvent: "input.complete",
          });
        },
      }));
    // Recompute on each keystroke so context and collision checks cannot become stale.
    return options.length
      ? { from: before.from + 2, options, filter: false }
      : null;
  };
}
