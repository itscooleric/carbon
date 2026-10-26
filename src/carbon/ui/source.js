/**
 * Linked-folder source actions (DOM): the per-file source dialog (click on #save-state), the
 * "Folder changes…" list (#source-changes), "Sync file to folder…" (#sync-file) and the explorer
 * sections' Import / Restore. Every change to Carbon's copy made here is an explicit, previewed
 * choice committed cache-first with the previous revision in History; the folder itself is written
 * by `deps.syncFile` only. Disk bytes shown here come from the last Refresh (`link.observed`) and
 * are rendered as text or through the inert asset preview, never run.
 */
import { assert, decode, LIMITS } from "../../core/validate.js";
import { History } from "../../core/stack.js";
import { renameWorkspace } from "../workspace.js";
import { SOURCE_STATES, acceptMove, baselineBytes, forgetDeleted, importIncoming, keepBoth, keepMine, observedBytes, restoreDeleted, shadowInHistory, sourceRows } from "../source.js";
import { linkedStatus } from "../linked.js";
import { diffTable } from "./diff-view.js";
import { assetPreview } from "./asset-preview.js";
import { $, el } from "./dom.js";

/** @typedef {import("../types.js").Deps} Deps */

const text = (bytes) => {
  if (!bytes || bytes.length > LIMITS.text || bytes.includes(0)) return null;
  try {
    return decode(bytes);
  } catch {
    return null;
  }
};
const sizeOf = (bytes) => `${bytes?.length ?? 0} bytes`;
/** First 16 hex digits of the SHA-256 of `bytes`: lets a person tell two versions of the same size apart. */
const fingerprint = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");

/** @param {Deps} deps */
export function mountSource(deps) {
  const { state, action, modal, confirm, notify, download, run } = deps;
  const link = () => {
    assert(state.link, "This workspace is not a linked folder.");
    return state.link;
  };
  const push = (label) => {
    const history = new History([...state.history.items]);
    history.push(state.stack, label);
    return history;
  };
  /** The observed disk bytes for `p` (captured) or the baseline when the disk still equals it. */
  const diskBytes = (p) => {
    const seen = link().observed?.entries.get(p);
    if (seen?.same) return baselineBytes(link(), state.stack, p);
    return observedBytes(link(), p);
  };
  const stale = (observed) => assert(state.link?.observed === observed, "The folder was refreshed meanwhile; look at the changes again. Nothing was changed.");

  // ---- the explicit actions (each one commit) ----
  async function importPaths(paths, observed = link().observed) {
    stale(observed);
    const { stack, link: next } = importIncoming(link(), state.stack, paths);
    await deps.commit({ stack, history: push(`Before importing ${paths.length === 1 ? paths[0] : `${paths.length} files`} from the folder`), link: next, unexported: true, copyState: "pending" });
    deps.render();
    notify(`Imported ${paths.length === 1 ? paths[0] : `${paths.length} files`} from ${folder()} into Carbon's copy. The folder is unchanged.`, "ok");
  }
  async function takeDisk(p, observed = link().observed) {
    stale(observed);
    const seen = observed?.entries.get(p);
    const captured = Boolean(seen && (seen.same || seen.bytes));
    // Not captured at the last Refresh: read the version now and bind the confirmation to these exact bytes.
    const expected = captured ? undefined : await deps.readFolderVersion(p);
    if (expected) stale(observed);
    const ok = await confirm(
      "Take the folder's version?",
      [
        captured
          ? `Carbon's copy of ${p} will be replaced with the version in ${folder()} as read at the last Refresh; the folder is read again first and must still hold that version.`
          : `The last Refresh did not keep the folder's version of ${p} (over the capture budget), so Carbon read it now: ${sizeOf(expected)}, SHA-256 ${await fingerprint(expected)}. Carbon's copy will be replaced with exactly these bytes; if the folder changes before the Take, nothing is taken.`,
        "The previous version in Carbon goes to History, so this can be undone." + (state.drafts.has(p) ? " Your unsaved draft stays a draft." : ""),
      ],
      "Take folder version",
    );
    if (!ok) return;
    await deps.takeDiskVersion(p, expected ? { expected } : undefined);
  }
  async function mine(p, observed = link().observed) {
    stale(observed);
    const { link: next } = keepMine(link(), state.stack, p);
    await deps.commit({ link: next });
    deps.render();
    notify(`Kept your version of ${p}. The folder's version is now the baseline, so Sync file to folder… checks the folder against it before writing.`, "ok");
  }
  async function both(p, observed = link().observed) {
    stale(observed);
    const { stack, link: next, path } = keepBoth(link(), state.stack, p);
    await deps.commit({ stack, history: push(`Before keeping both versions of ${p}`), link: next, unexported: true, copyState: "pending" });
    deps.render();
    notify(`Kept both: the folder's version of ${p} is now ${path} in Carbon (only in Carbon until you sync it). Your version stays at ${p}.`, "ok");
  }
  async function move(from, to, observed = link().observed) {
    stale(observed);
    // As Rename: a draft is keyed by path and would be left behind at the old one.
    assert(!state.drafts.has(from), `Save or discard the draft of ${from} first, then accept the move. Nothing was changed.`);
    const { stack, link: next } = acceptMove(link(), state.stack, from, to);
    const documents = renameWorkspace(state.documents, [[from, to]]);
    await deps.commit({ stack, history: push(`Before accepting the move of ${from}`), link: next, documents, current: state.current === from ? to : state.current, unexported: true, copyState: "pending" });
    deps.editor.renameSession(from, to);
    deps.render();
    notify(`Accepted the move: ${from} is now ${to} in Carbon, as in the folder. History keeps the previous revision.`, "ok");
  }
  async function restore(p) {
    const { stack, link: next } = restoreDeleted(link(), state.stack, p);
    await deps.commit({ stack, history: push(`Before restoring ${p}`), link: next, unexported: true, copyState: "pending" });
    deps.render();
    notify(`Restored ${p} in Carbon's copy from the version last read from the folder.`, "ok");
  }
  async function forget(p) {
    const shadow = link().baseline.get(p)?.shadow;
    const kept = shadowInHistory(link(), state.history, p);
    if (!kept) {
      const ok = await confirm(
        `Forget ${p}?`,
        [
          `Carbon keeps ${sizeOf(shadow)} as the folder's last-known version of ${p}, and History does not hold that version. Forgetting discards it from Carbon; the folder itself is not changed.`,
          "Use Folder changes… → Restore in Carbon first (or download it from there) if you may need it.",
        ],
        "Forget and discard",
      );
      if (!ok) return;
    }
    const { link: next } = forgetDeleted(link(), state.stack, p);
    await deps.commit({ link: next });
    deps.render();
    notify(`${p} is no longer listed as deleted in Carbon. The folder is unchanged${kept ? "; History still holds that version" : "; Carbon no longer keeps its last-known folder version"}.`, "ok");
  }
  const folder = () => state.link?.handle?.name || "the folder";

  // ---- inspection dialogs (read-only) ----
  function compare(p) {
    const disk = diskBytes(p), mine = state.stack.files.get(p);
    const before = text(mine), after = text(disk);
    let expanded = new Set();
    return modal(
      `Compare ${p} with the folder`,
      (c) => {
        c.append(el("p", `Carbon's copy (${sizeOf(mine)}) on the left, the folder's version (${sizeOf(disk)}) as read at the last Refresh on the right. Nothing is changed by looking.`, "hint"));
        const host = el("div");
        const render = () => host.replaceChildren(before !== null && after !== null
          ? diffTable(before, after, { expanded, onExpand: (i) => { expanded.add(i); render(); } })
          : el("p", "One of the versions is not text Carbon can show (binary, invalid UTF-8 or over the text limit), so no line comparison is possible. Download the folder's version to inspect it elsewhere."));
        render();
        const dl = el("button", "Download folder's version");
        dl.type = "button";
        dl.onclick = () => download(disk, p.split("/").pop());
        c.append(host, dl);
      },
      null,
    );
  }
  function diskVersion(p) {
    const disk = diskBytes(p);
    return modal(
      `Folder's version of ${p}`,
      (c) => {
        c.append(el("p", `${sizeOf(disk)}, as read from ${folder()} at the last Refresh. Read-only: Carbon's copy is not changed by looking.`, "hint"));
        assetPreview(c, p, disk, { download: () => download(disk, p.split("/").pop()) });
        const dl = el("button", "Download folder's version");
        dl.type = "button";
        dl.onclick = () => download(disk, p.split("/").pop());
        c.append(dl);
      },
      null,
    );
  }

  /** Buttons for one row; each sets `choose` and closes the dialog, the caller then acts. */
  function buttons(row, choose) {
    const out = [];
    const b = (label, op, extra = {}) => {
      const button = el("button", label);
      button.type = "button";
      button.onclick = () => choose({ op, path: row.path, ...extra });
      out.push(button);
    };
    const seen = state.link.observed?.entries.get(row.path);
    const inspectable = seen && (seen.same || seen.captured);
    const inspect = () => {
      if (!inspectable) return;
      b("Compare", "compare");
      b("Open folder's version", "disk");
    };
    switch (row.state) {
      case "externalChange":
        inspect();
        b("Take folder version…", "take");
        break;
      case "conflict":
        inspect();
        if (inspectable) {
          b("Keep mine", "mine");
          b("Keep both", "both");
        }
        b("Take folder version…", "take");
        break;
      case "missing":
        if (row.moveTo) b(`Accept move to ${row.moveTo}`, "move", { to: row.moveTo });
        b("Sync file to folder…", "sync");
        break;
      case "incoming":
        if (inspectable) {
          b("Open folder's version", "disk");
          b("Import", "import");
        }
        break;
      case "deletedInCarbon":
        b("Restore in Carbon", "restore");
        b("Forget", "forget");
        break;
      case "virtual":
      case "modified":
      case "matched":
        b("Sync file to folder…", "sync");
        break;
      default:
        break;
    }
    if (row.captured === false) out.push(el("span", "folder's version not captured (over the capture budget): Compare is unavailable; Take folder version reads it again", "hint"));
    return out;
  }
  async function act(chosen, observed) {
    if (!chosen) return;
    const { op, path } = chosen;
    if (op === "compare") return compare(path);
    if (op === "disk") return diskVersion(path);
    if (op === "take") return takeDisk(path, observed);
    if (op === "mine") return mine(path, observed);
    if (op === "both") return both(path, observed);
    if (op === "move") return move(path, chosen.to, observed);
    if (op === "import") return importPaths([path], observed);
    if (op === "importAll") return importPaths(chosen.paths, observed);
    if (op === "restore") return restore(path);
    if (op === "forget") return forget(path);
    if (op === "sync") return deps.syncFile(path);
  }

  /** The per-file dialog: state, explanation and the actions that apply. */
  async function openFile(p) {
    const l = link();
    const observed = l.observed;
    const row = sourceRows(l, state.stack).find((r) => r.path === p);
    assert(row, `Not a file in Carbon or in the folder: ${p}`);
    const info = linkedStatus(state, p);
    let chosen = null;
    await modal(
      `${p} and ${folder()}`,
      (c) => {
        c.append(el("p", `${info.glyph} ${info.label}`), el("p", info.tooltip, "hint"));
        if (state.drafts.has(p)) c.append(el("p", "This file has an unsaved draft. Save keeps it in Carbon; Sync writes only the saved copy.", "hint"));
        const row$ = el("div", undefined, "row");
        row$.append(...buttons(row, (choice) => { chosen = choice; $("dialog-cancel").click(); }));
        c.append(row$);
      },
      null,
    );
    await act(chosen, observed);
  }
  /** Every path whose state differs from the folder, grouped, with Import all. */
  async function openChanges() {
    const l = link();
    const observed = l.observed;
    const rows = sourceRows(l, state.stack).filter((r) => r.state !== "synced");
    let chosen = null;
    await modal(
      `Folder changes · ${folder()}`,
      (c) => {
        c.append(el("p", observed ? `As read at ${new Date(observed.at).toLocaleString()}. Carbon's copy changes only through the actions below; the folder changes only through Sync file to folder….` : "The folder has not been read yet. Use Refresh from folder first.", "hint"));
        if (!rows.length) c.append(el("p", "Every file in Carbon matches the folder."));
        const groups = [
          ["incoming", "New in folder"], ["externalChange", "Changed in folder"], ["conflict", "Changed in folder and in Carbon"], ["missing", "Missing from folder"],
          ["deletedInCarbon", "Deleted in Carbon"], ["modified", "Edited in Carbon, not synced"], ["virtual", "Only in Carbon"], ["matched", "Same as folder, not recorded as synced"],
        ];
        const choose = (choice) => { chosen = choice; $("dialog-cancel").click(); };
        for (const [stateName, title] of groups) {
          const members = rows.filter((r) => r.state === stateName);
          if (!members.length) continue;
          const sec = el("section");
          sec.append(el("h3", `${SOURCE_STATES[stateName].glyph} ${title} (${members.length})`));
          if (stateName === "incoming" && members.length > 1) {
            const importable = members.filter((r) => r.captured !== false).map((r) => r.path);
            if (importable.length > 1) {
              const all = el("button", `Import all (${importable.length})`);
              all.type = "button";
              all.onclick = () => choose({ op: "importAll", paths: importable });
              sec.append(all);
            }
          }
          const list = el("ul", undefined, "workspace-list");
          for (const row of members) {
            const li = el("li");
            li.append(el("code", row.path), row.moveTo ? el("span", ` moved in folder to ${row.moveTo}`, "hint") : "", row.movedFrom ? el("span", ` (was ${row.movedFrom} in Carbon)`, "hint") : "", row.gone ? el("span", " (also gone from the folder)", "hint") : "", " ");
            li.append(...buttons(row, choose));
            list.append(li);
          }
          sec.append(list);
          c.append(sec);
        }
      },
      null,
    );
    await act(chosen, observed);
  }

  action("sync-file", async () => {
    assert(state.current, "Open a file to sync it to the folder.");
    await deps.syncFile(state.current);
  });
  action("source-changes", () => openChanges());
  const saveEl = $("save-state");
  if (saveEl) {
    saveEl.setAttribute("role", "button");
    saveEl.tabIndex = 0;
    const open = () => run(() => (state.link && state.current ? openFile(state.current) : undefined));
    saveEl.onclick = open;
    saveEl.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    };
  }
  deps.openSourceChanges = openChanges;
  deps.openSourceFile = openFile;
  deps.source = { importPaths, restore, forget };
}
