/**
 * Workspaces: switch between the independent workspaces kept in this browser (Scratch, local
 * copies, linked folders, Envoy Stacks), download or remove a parked one.
 * Ids used: #open-scratch, #scratch-shortcut, #workspaces.
 *
 * Titles and paths come from stored records and are rendered as text.
 */
import { SCRATCH_ID, archiveWorkspace, archiveName, isScratch } from "../local-files.js";
import { KIND_LABELS, LARGE_MOUNT_BYTES, loadMount, mountRows } from "../mounts.js";
import { mountKind } from "../state.js";
import { formatBytes } from "./sidebar.js";
import { $, el } from "./dom.js";

/** @typedef {import("../types.js").Deps} Deps */

/**
 * @param {Deps} deps
 */
export function mountWorkspaces(deps) {
  const { state, action, modal, confirm, notify, download } = deps;
  action("open-scratch", () => deps.switchWorkspace(SCRATCH_ID));
  action("scratch-shortcut", () => deps.switchWorkspace(SCRATCH_ID));
  action("workspaces", async () => {
    const store = deps.workspaceStore();
    const index = store ? await store.list() : {};
    let chosen = null;
    await modal(
      "Workspaces",
      (c) => {
        c.append(
          el(
            "p",
            store?.durable
              ? "Each workspace keeps its own files, drafts, tabs, History and Dispatches in this browser. Switching never discards anything. Browser storage is not a backup: export what you want to keep."
              : "Browser storage is unavailable, so these workspaces live in this window only. Export before closing.",
            "hint",
          ),
        );
        const list = el("ul", undefined, "workspace-list");
        for (const row of mountRows(index, state)) {
          const kind = row.active ? mountKind(state) : row.kind;
          const li = el("li", undefined, row.active ? "active" : "");
          const drafts = row.active ? state.drafts.size : row.drafts || 0;
          const files = row.active ? state.stack.files.size : row.files ?? 0;
          li.append(
            el("b", row.active ? state.stack.manifest.title || row.id : String(row.title ?? row.id)),
            el(
              "span",
              ` · ${KIND_LABELS[kind] || "Workspace"} · ${files} files${drafts ? ` · ${drafts} unsaved draft${drafts === 1 ? "" : "s"}` : ""}${row.bytes ? ` · ${formatBytes(row.bytes)}` : ""}${row.bytes > LARGE_MOUNT_BYTES ? " (large)" : ""}${row.active ? " · open now" : ""}`,
              "hint",
            ),
          );
          if (!row.active) {
            const open = el("button", "Switch");
            open.type = "button";
            open.setAttribute("aria-label", `Switch to ${row.title ?? row.id}`);
            open.onclick = () => {
              chosen = { op: "switch", id: row.id };
              $("dialog-cancel").click();
            };
            // Files only: a TAR holds the committed files, not drafts, History, Dispatches or tabs.
            const save = el("button", "Download files (TAR)");
            save.title = "Committed files only: not drafts, History, Dispatches or tabs";
            save.type = "button";
            save.onclick = () => {
              chosen = { op: "download", id: row.id };
              $("dialog-cancel").click();
            };
            li.append(" ", open, " ", save);
            if (row.id !== SCRATCH_ID) {
              const remove = el("button", "Remove…");
              remove.type = "button";
              remove.onclick = () => {
                // Pin the revision the user saw: a newer copy from another tab is a conflict, not a deletion.
                chosen = { op: "remove", id: row.id, title: row.title ?? row.id, rev: row.rev ?? null };
                $("dialog-cancel").click();
              };
              li.append(" ", remove);
            }
          }
          list.append(li);
        }
        c.append(list);
      },
      null,
    );
    if (!chosen) return;
    if (chosen.op === "switch") return deps.switchWorkspace(chosen.id);
    if (chosen.op === "download") {
      const parked = await loadMount(store, chosen.id);
      // A TAR holds committed files only: refuse rather than silently drop unsaved text.
      if (parked.drafts.size)
        throw new Error(`“${parked.stack.manifest.title || chosen.id}” has ${parked.drafts.size} unsaved draft${parked.drafts.size === 1 ? "" : "s"}, which a files-only TAR would not include. Switch to it and save or discard them first.`);
      return download(archiveWorkspace(parked.stack), archiveName(parked.stack));
    }
    const ok = await confirm(
      "Remove this workspace from the browser?",
      [
        `“${chosen.title}” and its drafts, History and Dispatches will be deleted from this browser. Files already exported or saved to a folder are not affected.`,
        "Download files (TAR) keeps only its committed files. History, Dispatches and drafts cannot be exported from here, so remove it only if you no longer need them.",
      ],
      "Remove",
    );
    if (!ok) return;
    await deps.removeWorkspace(chosen.id, chosen.rev);
    notify(`Removed “${chosen.title}” from this browser.`);
  });
}

/** Show the Scratch shortcut whenever another workspace is open. */
export function renderWorkspaceShortcut(state) {
  $("scratch-shortcut").hidden = isScratch(state.stack);
}
