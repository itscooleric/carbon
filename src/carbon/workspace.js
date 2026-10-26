import { canEdit, isMarkdown } from "./local-files.js";
/** Local UI state only; tabs are never written into portable Stack files. */
import { assert } from "../core/validate.js";
import { isTextLike } from "./asset-data.js";

export const MAX_TABS = 20;
/** Markdown documents (the Markdown preview, wiki links, Entries); see `isMarkdown`. */
export const isEntry = isMarkdown;
export const viewable = (path) =>
  typeof path === "string" && /\.(md|csv|json|txt|log|yaml|yml|png|jpe?g|webp)$/i.test(path);
/** Known extensions, or any file whose bytes are text-like (UTF-8, no NUL, bounded). */
export const viewableIn = (workspace, path) =>
  viewable(path) ||
  (typeof path === "string" && Boolean(workspace?.files?.has(path)) && isTextLike(workspace.files.get(path)));
export function workspaceState(stack, current = null, cached = null) {
  const same = cached?.stackId === stack.manifest.id;
  const value = same ? cached : {};
  const paths = (items, accepts) =>
    [
      ...new Set(
        Array.isArray(items)
          ? items.filter((p) => accepts(p) && stack.files.has(p))
          : [],
      ),
    ].slice(0, MAX_TABS);
  const editors = paths(value.editors, p => canEdit(stack, p));
  if (
    (same || !cached) &&
    canEdit(stack, current) &&
    stack.files.has(current) &&
    !editors.includes(current) &&
    editors.length < MAX_TABS
  ) {
    editors.push(current);
  }
  const viewers = paths(value.viewers, (p) => viewableIn(stack, p));
  return {
    stackId: stack.manifest.id,
    editors,
    viewers,
    viewer: viewers.includes(value.viewer) ? value.viewer : viewers[0] || null,
    shown: same && value.shown === true,
    side: same && value.side === "viewer" ? "viewer" : "editor",
    swapped: cached?.swapped === true,
    ratio: Number.isFinite(cached?.ratio)
      ? Math.max(25, Math.min(75, cached.ratio))
      : 50,
    scroll: Object.fromEntries(
      viewers.map((p) => [
        p,
        Number.isFinite(value.scroll?.[p])
          ? Math.max(0, Math.min(1e8, value.scroll[p]))
          : 0,
      ]),
    ),
  };
}
export function canOpen(tabs, path) {
  assert(
    tabs.includes(path) || tabs.length < MAX_TABS,
    `Close a tab before opening another (up to ${MAX_TABS} per pane). Closing a tab keeps its draft.`,
  );
}
export function addTab(tabs, path) {
  canOpen(tabs, path);
  if (!tabs.includes(path)) tabs.push(path);
}
export function removeTab(tabs, active, path) {
  const at = tabs.indexOf(path);
  if (at < 0) return active;
  tabs.splice(at, 1);
  return active === path ? tabs[Math.min(at, tabs.length - 1)] || null : active;
}

/** Apply accepted rename pairs simultaneously before reconciling against the new Stack. */
export function renameWorkspace(documents, renames) {
  if (!documents) return documents;
  const names = new Map(renames), rename = path => names.get(path) ?? path;
  return {
    ...documents,
    editors: documents.editors.map(rename), viewers: documents.viewers.map(rename),
    viewer: rename(documents.viewer),
    scroll: Object.fromEntries(Object.entries(documents.scroll).map(([p, top]) => [rename(p), top])),
  };
}
