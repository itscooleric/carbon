/**
 * Status surfaces: the #notice bar, sidebar Stack status, editor status, selection
 * counter, footer persistence text and the document title.
 * Ids used: #notice, #stack-title, #stack-meta, #stack-id, #stack-status, #confirm-export,
 * #editor-status, #selection-status, #toolbar-selection, #save-entry, #rename, #delete,
 * #persistence.
 */
import { isLocalFolder, isScratch } from "../local-files.js";
import { $, el } from "./dom.js";
import { renderDirtyTags } from "./sidebar.js";
import { linkedStatus, renderLinkedStatus } from "../linked.js";
import { renderWorkspaceShortcut } from "./workspaces.js";

/** @typedef {import("../types.js").Deps} Deps */
/** @typedef {import("../types.js").NoticeKind} NoticeKind */
/** @typedef {import("../types.js").NoticeAction} NoticeAction */

const KINDS = ["info", "ok", "pending", "error"];
const GLYPHS = { info: "ℹ", ok: "✓", pending: "↗", error: "⚠" };
/** Routine info/ok messages without actions fade after this delay; others stay until dismissed. */
const NOTICE_FADE_MS = 6000;
let noticeTimer;

/**
 * Show a message in the #notice bar. The class name is "" for info and exactly the kind
 * otherwise ("ok", "pending", "error"). A glyph per kind (ℹ ✓ ↗ ⚠, aria-hidden) precedes
 * the text; up to two action buttons follow it.
 * @param {string} message rendered as text
 * @param {NoticeKind|boolean} [kind="info"] `true` is accepted as "error" for legacy callers
 * @param {NoticeAction[]} [actions=[]]
 */
export function notify(message, kind = "info", actions = []) {
  const level = kind === true ? "error" : KINDS.includes(kind) ? kind : "info";
  const notice = $("notice");
  const glyph = el("span", GLYPHS[level], "notice-glyph");
  glyph.setAttribute("aria-hidden", "true");
  notice.replaceChildren(glyph, el("span", message, "notice-text"));
  delete notice.dataset.faded;
  delete notice.dataset.dismissed;
  clearTimeout(noticeTimer);
  if (actions.length) {
    const acts = el("span", undefined, "notice-actions");
    for (const { label, onClick } of actions.slice(0, 2)) {
      const b = el("button", label, "notice-action");
      b.type = "button";
      b.onclick = onClick;
      acts.append(b);
    }
    notice.append(acts);
  }
  const close = el("button", "×", "notice-close");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss message");
  close.onclick = () => (notice.dataset.dismissed = "true");
  notice.append(close);
  notice.className = level === "info" ? "" : level;
  if ((level === "info" || level === "ok") && !actions.length)
    noticeTimer = setTimeout(() => (notice.dataset.faded = "true"), NOTICE_FADE_MS);
}

/** Footer base text (cache availability); revisions are appended by `renderStatus`. */
let persistenceText = "";

/**
 * Set the footer persistence base text (draft cache availability). The current revision
 * and the last archive export revision are appended on the next `renderStatus`.
 * @param {string} text
 * @param {string} [state] machine-readable state (`saved`, `saving`, `quota`, `conflict`, `memory`, `failed`, `error`) on `data-state`
 */
export function setPersistence(text, state = "") {
  persistenceText = text;
  $("persistence").dataset.state = state;
  $("persistence").textContent = text;
  $("persistence").title = text;
}

/**
 * Render the footer: "<cache text> · revision N · last archive export: revision M".
 * @param {import("../types.js").WorkspaceState} state
 */
export function renderPersistence(state) {
  const last = state.lastArchiveRevision;
  const text = `${persistenceText}${persistenceText ? " · " : ""}revision ${state.stack.manifest.revision} · last archive export: ${last >= 0 ? `revision ${last}` : "none"}`;
  $("persistence").textContent = text;
  $("persistence").title = text;
}

/** Editor-status word for a linked folder: the draft first, then the file's source state (text + glyph). */
const linkedWord = (state, path) => {
  if (state.drafts.has(path)) return ["● unsaved", "Unsaved draft, kept in this browser. Save keeps it in Carbon; the folder is written only by Sync file to folder…."];
  const info = linkedStatus(state, path);
  return [`${info.glyph} ${info.label}`.trim().toLowerCase(), info.tooltip];
};

const COPIES = {
  pending: "Export needed — current revision is in this workspace.",
  requested: "Download requested — confirm the archive reached your files.",
  confirmed: "Archive saved — confirmed by you for this revision.",
  imported: "Opened from a complete snapshot. Export after making changes.",
  folder: "Folder snapshot written for this revision.",
};

/**
 * Render Stack identity, export status, editor status (with Discard draft), selection
 * counter, button enablement and the document title from the live state.
 * @param {Deps} deps
 */
export function renderStatus(deps) {
  const { state, run, modal, persist, render } = deps;
  const { stack, current, drafts } = state;
  const local = isLocalFolder(stack),
    scratch = isScratch(stack);
  $("stack-title").textContent = stack.manifest.title || stack.manifest.id;
  $("header-stack").textContent = stack.manifest.title || stack.manifest.id;
  $("stack-meta").textContent =
    `${state.link ? "Linked folder · " : scratch ? "Scratch · " : local ? "Local copy · " : ""}revision ${stack.manifest.revision} · ${stack.files.size} files`;
  $("stack-id").textContent = scratch
    ? "Scratch notes · saved in this browser. Create an Envoy Stack from Open / Import to use Dispatch / Return."
    : local ? "Local folder copy · source files unchanged. Create an Envoy Stack from Open / Import to use Dispatch / Return." : stack.manifest.id;
  $("export-label").textContent = local ? "Export files" : "Export Stack";
  $("create-stack").hidden = !local;
  $("save-entry").textContent = scratch ? "Save note" : local ? "Save in copy" : "Save Entry";
  renderWorkspaceShortcut(state);
  for (const id of ["dispatch", "dispatch-this", "new-dispatch", "import-return", "export-handoff", "register-dispatch"]) {
    $(id).disabled = local;
    if (local) $(id).title = "Create an Envoy Stack from this copy to use Dispatch / Return";
    else $(id).title = id === "dispatch" ? "Ctrl/Cmd+Shift+D" : "";
  }
  $("stack-status").textContent = scratch && state.copyState === "pending"
    ? "Saved in this browser only. Export to keep a copy outside it."
    : COPIES[state.copyState];
  $("confirm-export").hidden = state.copyState !== "requested";
  // Status line: a terse state word; the full explanation is the tooltip.
  const [word, detail] = !current
    ? ["", ""]
    : state.link
      ? linkedWord(state, current)
      : drafts.has(current)
      ? ["● unsaved", "Unsaved draft — not yet in archive exports."]
      : scratch
        ? ["saved · in this browser", "Saved in Scratch in this browser. Export to keep a copy outside the browser."]
      : local
        ? ["saved · local copy", "Saved in Carbon’s local copy. Download or export to keep your changes; original files are unchanged."]
        : ["saved", "Saved in workspace. Export the Stack for a portable copy."];
  $("editor-status").replaceChildren(document.createTextNode(word));
  $("editor-status").title = detail;
  $("editor-status").classList.toggle("dirty", Boolean(current && drafts.has(current)));
  if (current && drafts.has(current)) {
    const b = el("button", "Discard draft");
    b.type = "button";
    b.onclick = () =>
      run(async () => {
        const ok = await modal(
          "Discard this draft?",
          (c) => {
            c.append(el("p", state.current));
            return () => true;
          },
          "Discard",
        );
        if (ok) {
          state.drafts.delete(state.current);
          await persist();
          render();
        }
      });
    $("editor-status").append(b);
  }
  $("selection-status").textContent =
    `${state.selected.size} Entries selected · ${drafts.size} unsaved drafts`;
  const n = state.selected.size;
  $("toolbar-selection").textContent = n
    ? `${n} ${n === 1 ? "Entry" : "Entries"} checked`
    : "No Entries checked";
  renderDirtyTags(state);
  deps.workspace?.dirtyTabs();
  renderPersistence(state);
  for (const id of ["save-entry", "rename", "delete", "download-file"])
    $(id).disabled = !current;
  $("save-entry").disabled = !current || !drafts.has(current);
  // --- linked folder (linked.js) ---
  renderLinkedStatus(deps);
  // --- end linked ---
  document.title = `${drafts.size || state.unexported ? "• " : ""}Carbon — ${stack.manifest.title || "Stack"}`;
}
