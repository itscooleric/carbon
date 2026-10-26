/**
 * Local file history (on disk) dialog and "Export local history" action. The history itself
 * lives in `.carbon-history/` inside the linked folder (`../history/disk.js`). Ids used:
 * #disk-history (Document menu), #export-history (Export menu), plus the shared dialog ids.
 * Show/hide of both buttons is decided by the integrator; handlers tolerate being hidden.
 */
import { $, el } from "./dom.js";

/**
 * @typedef {Object} DiskHistoryDeps
 * @property {{current: string|null, drafts?: Map<string, string>, stack: {manifest: {id: string, title?: string}}}} state
 * @property {(id: string, fn: () => (void|Promise<void>)) => void} action
 * @property {typeof import("./dialogs.js").modal} modal
 * @property {typeof import("./dialogs.js").confirm} confirm
 * @property {(message: string) => void} notify
 * @property {(bytes: Uint8Array, name: string) => void} download
 * @property {() => Promise<import("../history/disk.js").DiskHistory>} openHistory
 *   returns the DiskHistory of the active linked folder; throws a user-readable Error when the
 *   workspace is not linked or history is unavailable
 * @property {(path: string, bytes: Uint8Array) => Promise<{ok: boolean}|void>} restoreFromDisk
 *   puts `bytes` into Carbon's copy of `path` as a new revision (the previous one goes to History); the folder is not
 *   written (Sync file to folder… does that); refuses while the file has a draft; resolves `{ok: false}` after a
 *   refusal that was already reported
 * @property {() => string} [folderName]  display name for the export file; defaults to the stack id
 */

const pad = (n) => String(n).padStart(2, "0");
/** Local "YYYY-MM-DD HH:MM:SS" for a millisecond timestamp. */
export const formatTime = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const formatSize = (n) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`;
export const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
/** Safe download name stem: keep letters, digits, dot, underscore and dash. */
export const safeStem = (s) =>
  String(s || "folder").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "folder";

/**
 * Map `DiskHistory.list()` rows to display rows (pure; unit tested).
 * @param {{id: string, savedAt: number, size: number, modified: number|null}[]} versions
 * @returns {{id: string, text: string}[]}
 */
export function rowsFor(versions) {
  return versions.map((v) => ({
    id: v.id,
    text:
      `Saved ${formatTime(v.savedAt)} · ${formatSize(v.size)}` +
      (v.modified === null || v.modified === undefined ? "" : ` · file modified ${formatTime(v.modified)}`),
  }));
}

/** @param {DiskHistoryDeps} deps */
export function mountDiskHistory(deps) {
  const { state, action, modal, confirm, notify, download, openHistory, restoreFromDisk } = deps;
  action("disk-history", async () => {
    const path = state.current;
    if (!path) throw new Error("Open a file to see its local file history.");
    const history = await openHistory();
    const versions = await history.list(path);
    let restoring = null;
    await modal(
      "Local file history (on disk)",
      (c) => {
        c.append(
          el(
            "p",
            `Earlier versions of ${path}, kept in the .carbon-history folder next to your files. Each one is a complete copy; Carbon saved it just before a Sync replaced the file on disk. Restore puts a version into Carbon's copy; the folder changes only when you Sync.`,
          ),
        );
        if (!versions.length) c.append(el("p", "No earlier versions of this file have been saved yet. Carbon keeps one each time a Sync replaces the file with local history on; nothing has been added to your folder otherwise."));
        rowsFor(versions).forEach((row, i) => {
          const p = el("p", `${row.text} `);
          const dl = el("button", "Download");
          dl.onclick = async () => {
            try {
              download(await history.read(row.id), baseName(path));
            } catch (e) {
              $("dialog-error").textContent = e.message;
            }
          };
          const rs = el("button", "Restore");
          rs.onclick = () => {
            // A restore replaces Carbon's copy; a draft for this file would be shown instead of the restored text.
            if (state.drafts?.has(path)) {
              $("dialog-error").textContent = "Save or discard the draft first";
              return;
            }
            restoring = versions[i];
            $("dialog-cancel").click();
          };
          p.append(dl, rs);
          c.append(p);
        });
      },
      null,
    );
    if (!restoring) return;
    const ok = await confirm(
      "Restore this version?",
      [
        `Replace Carbon's copy of ${path} with the version saved ${formatTime(restoring.savedAt)} (${formatSize(restoring.size)}).`,
        "The current version goes to History, so this can be undone. The folder is not written: use Sync file to folder… afterwards if you want the restored version there.",
      ],
      "Restore",
    );
    if (!ok) return;
    const bytes = await history.read(restoring.id);
    const result = await restoreFromDisk(path, bytes);
    if (result && result.ok === false) return; // already reported
    notify(`Restored ${path} from local history into Carbon's copy. The previous version is in History; the folder is unchanged until you Sync file to folder….`);
  });
  action("export-history", async () => {
    const history = await openHistory();
    const tar = await history.exportArchive();
    const stem = safeStem(deps.folderName?.() ?? state.stack?.manifest?.id);
    download(tar, `${stem}-carbon-history.tar`);
    notify("Exported local history. It contains complete copies of earlier file versions.");
  });
}
