import { isLocalFolder, restoreFolder, archiveWorkspace, archiveName } from "../local-files.js";
/**
 * Revision History dialog: download or restore a retained prior snapshot.
 * Ids used: #history, #dialog-cancel (closed programmatically on Restore).
 */
import { restoreSnapshot } from "../../core/stack.js";
import { $, el } from "./dom.js";

/** @typedef {import("../types.js").Deps} Deps */

/**
 * Wire the History button.
 * @param {Deps} deps
 */
export function mountHistory(deps) {
  const { state, action, modal, download, replace, requireSaved, notify } =
    deps;
  action("history", async () => {
    let restoring = null;
    await modal(
      "Revision history",
      (c) => {
        c.append(
          el(
            "p",
            "Up to 10 prior snapshots, bounded to 64 MiB. Download older revisions for long-term retention. Restoring creates a new revision above every snapshot still retained for that Stack; revisions already evicted from History are unknown to Carbon.",
          ),
        );
        for (const item of [...state.history.items].reverse()) {
          const row = el(
            "p",
            `${item.stack.manifest.title || item.stack.manifest.id} r${item.stack.manifest.revision} · ${item.label} `,
          );
          const save = el("button", "Download TAR");
          save.onclick = () =>
            download(
              archiveWorkspace(item.stack),
              archiveName(item.stack),
            );
          const restore = el("button", "Restore");
          restore.onclick = () => {
            restoring = item;
            $("dialog-cancel").click();
          };
          row.append(save, restore);
          c.append(row);
        }
      },
      null,
    );
    if (!restoring) return;
    requireSaved();
    // CB-2: the next revision is above every retained snapshot of this Stack, not only the restored one.
    await replace(
      (isLocalFolder(restoring.stack) ? restoreFolder : restoreSnapshot)(state.stack, state.history, restoring.stack),
      "Before restoring History",
    );
    notify(state.link ? "Restored as a new revision in Carbon. The folder is unchanged until you Sync file to folder…." : "Restored as a new revision. Export the restored workspace for a durable copy.");
  });
}
