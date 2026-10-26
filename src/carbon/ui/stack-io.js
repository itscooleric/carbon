/**
 * Stack input/output: import files, folders and archives; export TAR / TAR.GZ; open and
 * save native folders; New Stack; Confirm archive saved; Capabilities dialog.
 * Ids used: #import, #folder-import, #files, #folders, #open-folder, #save-folder,
 * #export-tar, #export-gzip, #new-stack, #confirm-export, #capabilities.
 *
 * Trust: imported bytes pass bounded inventory validation (`Stack` or `LocalFolder`) before
 * it is shown; inventories are rendered as text.
 */
import { Stack, newStack, directoryDiff } from "../../core/stack.js";
import { suggestStackName } from "../../core/naming.js";
import { assert, decode, equal, LIMITS } from "../../core/validate.js";
import { readTarFiles } from "../../archives/tar.js";
import { gzip, gunzip } from "../../archives/gzip.js";
import { readFiles, readDirectoryFiles, saveDirectory } from "../fs.js";
import { LocalFolder, isLocalFolder, defaultDocument, archiveWorkspace, archiveName, toEnvoyStack } from "../local-files.js";
import { forgetConsent, newLink, reconnectLink, refreshFolder } from "../linked.js";
import { $, el } from "./dom.js";

/** @typedef {import("../types.js").Deps} Deps */

/**
 * Preview an incoming complete snapshot against the Stack it would replace and open it on
 * confirmation: the open Stack (same id), the stored workspace with that id, or nothing (a new
 * workspace). The replaced revision is retained in that workspace's History.
 * @param {Deps} deps
 * @param {Stack} next validated incoming Stack
 * @param {{converted?: boolean}} [options] `converted`: `next` was synthesized in Carbon from an ordinary copy, so no saved copy exists yet
 * @returns {Promise<void>}
 */
export async function stageStack(deps, next, { converted = false } = {}) {
  const { state, modal, replace, persist, notify, requireSaved } = deps;
  assertStackIdentity(next);
  // Another identity opens as its own workspace (drafts here are kept with this one).
  const separate = next.manifest.id !== state.stack.manifest.id;
  if (!separate) requireSaved();
  // A stored workspace with this id is what the snapshot replaces; preview against it and keep
  // its revision, so a change made meanwhile (another tab) is refused rather than overwritten.
  const parked = separate ? await deps.storedStack?.(next.manifest.id) : null;
  if (parked)
    assert(!parked.drafts, `“${parked.stack.manifest.title || next.manifest.id}” is already open in Carbon with unsaved drafts. Switch to it with Workspaces…, save or discard them, then import again.`);
  const stack = separate ? parked?.stack ?? new LocalFolder() : state.stack;
  // CB-6: empty folders are inventory too; show them so cancelling knowingly preserves them.
  const folders = directoryDiff(stack, next);
  const oldPaths = new Set(stack.files.keys()),
    newPaths = new Set(next.files.keys());
  const changed = [...newPaths].filter(
    (p) => !equal(next.files.get(p), stack.files.get(p)),
  );
  const missing = [...oldPaths].filter((p) => !newPaths.has(p));
  const ok = await modal(
    "Open complete Stack snapshot?",
    (c) => {
      c.append(
        el(
          "p",
          `${next.manifest.title || next.manifest.id} · revision ${next.manifest.revision} · ${next.files.size} files`,
        ),
        el(
          "pre",
          `New or changed:\n${changed.join("\n") || "(none)"}\n\nAbsent from incoming snapshot:\n${missing.join("\n") || "(none)"}\n\nEmpty folders added:\n${folders.added.map((p) => p + "/").join("\n") || "(none)"}\n\nEmpty folders removed:\n${folders.removed.map((p) => p + "/").join("\n") || "(none)"}`,
        ),
        el(
          "p",
          parked
            ? `This Stack is already stored in this browser: the snapshot replaces its revision ${parked.stack.manifest.revision}, which stays in that workspace's History. Your current workspace, with its drafts, stays in this browser (Workspaces…).`
            : separate
              ? "This opens the complete snapshot as its own workspace. Your current workspace, with its drafts, stays in this browser (Workspaces…)."
              : "This opens the complete snapshot. Your current Stack remains in History.",
        ),
      );
      return () => true;
    },
    "Open Stack",
  );
  if (ok) {
    if (separate) {
      const from = isLocalFolder(state.stack);
      await deps.openWorkspace(next, { unexported: converted, copyState: converted ? "pending" : "imported", lastArchiveRevision: -1 }, { expectRev: converted ? undefined : parked?.rev ?? 0 });
      notify(converted
        ? "Envoy Stack created in Carbon as its own workspace. The original files are unchanged and the copy stays available in Workspaces…; export the Stack for a durable copy."
        : `Complete Stack imported and validated.${from ? " Original folder files are unchanged." : ""} Your previous workspace stays available in Workspaces….`);
      return;
    }
    // Atomic: the imported flags are committed with the snapshot, never ahead of it.
    await replace(next, "Before importing full Stack", { unexported: false, copyState: "imported" });
    notify("Complete Stack imported and validated.");
  }
}

/**
 * Opening a folder never synthesizes protocol metadata and never writes on open. An ordinary
 * folder is an independent copy; with `linked` (a native directory handle and the read it was
 * imported from) it is a linked folder: Carbon's own copy of the files, with the folder as its
 * source (Refresh from folder reads it) and optional target (Sync file to folder… writes one file).
 * @param {Deps} deps
 * @param {LocalFolder} next
 * @param {string} [reason] why the folder is not a valid Envoy Stack
 * @param {{handle: FileSystemDirectoryHandle, read?: object}|null} [linked]
 */
export async function stageFolder(deps, next, reason = "", linked = null) {
  const ok = await deps.modal(
    linked ? "Open linked folder?" : "Open local folder copy?",
    (c) => {
      c.append(
        el("p", `${next.manifest.title} · ${next.files.size} files`),
        linked
          ? el("p", "Carbon reads these files now into its own copy and writes nothing. Save, New file, Rename and Delete change only Carbon's copy in this browser. Refresh from folder reads the folder again and shows what differs; Sync file to folder… writes one file to the folder, and the first Sync asks for confirmation.")
          : el("p", "Edit a copy in Carbon. Source files stay unchanged. Save in copy updates the local workspace; Download file, Export files, or Save new folder copy keeps your changes outside the browser."),
        el("p", "Paths and file bytes are retained. No stack.yaml is created. It opens as its own workspace; your current workspace, with its drafts, stays in this browser (Workspaces…)."),
        el("pre", [...next.files.keys()].join("\n") || "(empty folder)"),
      );
      if (reason) c.append(el("p", `This is not a valid Envoy Stack: ${reason}. Opening as ordinary files does not repair or validate it as a Stack.`));
      return () => true;
    },
    linked ? "Open linked folder" : "Open copy",
  );
  if (!ok) return;
  // Remembered consent (per folder) pre-grants consent only; browser permission is asked at Save.
  let memory = null;
  if (linked) memory = await deps.folderMemory?.find(linked.handle).catch(() => null);
  await deps.openWorkspace(next, {
    link: linked ? newLink(linked.handle, memory?.value, next, linked.read ?? null) : null,
    current: defaultDocument(next),
    copyState: "imported", unexported: false, lastArchiveRevision: -1,
  });
  deps.notify(linked
    ? "Opened a linked folder as Carbon's own copy. Nothing was written; the folder is written only by Sync file to folder…, after you confirm."
    : "Opened a local copy. Source files are unchanged; download or export your edits for a durable copy.");
}
/** A Stack never takes an id Carbon uses for its own workspaces (Scratch, copies, linked folders). */
function assertStackIdentity(next) {
  assert(!next.manifest.id.startsWith("local-"), `This Stack's id (${next.manifest.id}) is reserved for Carbon's own workspaces. Nothing was opened.`);
}
/** Id of a stored linked workspace for the same folder (isSameEntry), or null. */
async function linkedWorkspaceFor(deps, handle) {
  const store = deps.workspaceStore?.();
  try {
    if (deps.state.link && (await handle.isSameEntry(deps.state.link.handle))) return deps.state.stack.manifest.id;
  } catch {
    /* not comparable: not the same folder */
  }
  if (!store) return null;
  const index = await store.list().catch(() => ({}));
  for (const [id, entry] of Object.entries(index)) {
    try {
      if (entry?.kind === "linked" && entry.handle && (await handle.isSameEntry(entry.handle))) return id;
    } catch {
      /* an unusable stored handle is not a match */
    }
  }
  return null;
}
/** Strict Stack detection is separate from the ordinary-folder fallback. */
async function openFolderInput(deps, files, directories, title, strict = false, linked = null) {
  const hasManifest = files.some(([p]) => p === "stack.yaml");
  if (strict || hasManifest) {
    let next;
    try { next = new Stack(files, directories); }
    catch (e) {
      if (strict) throw e;
      return stageFolder(deps, new LocalFolder(files, directories, { title }), e.message, linked);
    }
    return stageStack(deps, next);
  }
  return stageFolder(deps, new LocalFolder(files, directories, { title }), "", linked);
}

/**
 * Export the current Stack as TAR or TAR.GZ and mark the copy as requested.
 * @param {Deps} deps
 * @param {boolean} compressed
 * @returns {Promise<void>}
 * @throws {Error} on unsaved drafts or when gzip output would violate the import ratio policy
 */
export async function exportArchive(deps, compressed) {
  const { state, download, persist, notify, requireSaved } = deps;
  requireSaved();
  const { stack } = state;
  const bytes = archiveWorkspace(stack);
  const output = compressed ? await gzip(bytes) : bytes;
  assert(
    !compressed ||
      bytes.length <= Math.max(1024 * 1024, output.length * LIMITS.ratio),
    "Compression ratio exceeds the import policy. Export TAR for this Stack.",
  );
  download(
    output,
    `${archiveName(stack)}${compressed ? ".gz" : ""}`,
  );
  state.copyState = "requested";
  state.unexported = true;
  state.lastArchiveRevision = stack.manifest.revision;
  await persist();
  notify(
    "Archive download requested. Verify the file reached your downloads folder.",
  );
}

/**
 * Wire all Stack import/export controls.
 * @param {Deps} deps
 */
export function mountStackIO(deps) {
  const {
    state,
    run,
    action,
    modal,
    ask,
    notify,
    persist,
    replace,
    requireSaved,
    reviewReturn,
    cacheAvailable,
  } = deps;
  action("new-stack", async () => {
    const names = [
      state.stack.manifest.title,
      ...state.history.items.map((item) => item.stack.manifest.title),
    ].filter(Boolean);
    const title = await ask(
      "New Stack",
      "Stack display title",
      suggestStackName(names),
      (value) => {
        const title = value.trim();
        assert(
          title.length > 0 && title.length <= 200,
          "Enter a Stack title between 1 and 200 characters.",
        );
        assert(
          !names.some(
            (name) =>
              name.normalize("NFC").toUpperCase() ===
              title.normalize("NFC").toUpperCase(),
          ),
          "A Stack with this title is already in this workspace or History. Choose another title.",
        );
        return title;
      },
    );
    if (title === null) return;
    await replace(newStack(title), "Before opening a new Stack");
  });
  action("confirm-export", async () => {
    assert(state.copyState === "requested", "Export the current revision first.");
    state.copyState = "confirmed";
    state.unexported = false;
    state.lastArchiveRevision = state.stack.manifest.revision;
    await persist();
    notify("Archive save confirmed by you. Keep that file for recovery.");
  });
  action("export-tar", () => exportArchive(deps, false));
  action("export-gzip", () => exportArchive(deps, true));
  action("open-files", () => $("local-files").click());
  $("local-files").onchange = () => run(async () => {
    const list = [...$("local-files").files];
    $("local-files").value = "";
    if (!list.length) return;
    await stageFolder(deps, new LocalFolder(await readFiles(list), [], { title: list.length === 1 ? list[0].name.slice(0, 200) : "Local files" }));
  });
  action("create-stack", async () => {
    const next = toEnvoyStack(state.stack);
    await stageStack(deps, next, { converted: true });
  });
  action("import", () => $("files").click());
  action("folder-import", () => $("folders").click());
  $("files").onchange = () =>
    run(async () => {
      const list = [...$("files").files];
      $("files").value = "";
      if (!list.length) return;
      if (list.length === 1 && /\.tar(?:\.gz)?$/i.test(list[0].name)) {
        assert(list[0].size <= LIMITS.archive, "Archive input too large");
        let bytes = new Uint8Array(await list[0].arrayBuffer());
        if (/\.gz$/i.test(list[0].name)) bytes = await gunzip(bytes);
        const { files, directories } = readTarFiles(bytes);
        // Our explicit ordinary-copy export must reopen even with unrelated stack.yaml bytes.
        if (/\.folder\.tar(?:\.gz)?$/i.test(list[0].name))
          return stageFolder(deps, new LocalFolder(files, directories, { title: list[0].name.slice(0, 200) }));
        // Stack/Dispatch archives and unlabelled manifest-bearing archives retain strict validation.
        return openFolderInput(deps, files, directories, list[0].name.slice(0, 200), /\.(?:stack|dispatch)\.tar(?:\.gz)?$/i.test(list[0].name) || files.some(([p]) => p === "stack.yaml" || p === "dispatch.yaml"));
      }
      if (list.length === 1 && /\.handoff\.md$/i.test(list[0].name)) {
        requireSaved();
        assert(list[0].size <= 4 * LIMITS.text, "Handoff too large");
        return reviewReturn(
          decode(new Uint8Array(await list[0].arrayBuffer())),
        );
      }
      requireSaved();
      const { stack } = state;
      const files = await readFiles(list);
      const writes = new Map(
        files.map(([p, b]) => [
          isLocalFolder(stack) ? p : /\.md$/i.test(p) ? "entries/" + p : "assets/" + p,
          b,
        ]),
      );
      for (const p of writes.keys())
        assert(!stack.files.has(p), `Import collision: ${p}`);
      const next = stack.change({ writes });
      const ok = await modal(
        "Import files?",
        (c) => {
          c.append(el("pre", [...writes.keys()].join("\n")));
          return () => true;
        },
        "Import",
      );
      if (ok) await replace(next, "Before importing files");
    });
  $("folders").onchange = () =>
    run(async () => {
      const files = [...$("folders").files];
      $("folders").value = "";
      if (files.length) {
        await openFolderInput(deps, await readFiles(files, true), [], (files[0].webkitRelativePath.split("/")[0] || "Local folder").slice(0, 200));
      }
    });
  // Linked folder: needs the File System Access picker. Elsewhere it falls back to an independent copy.
  action("open-folder", async () => {
    if (typeof window.showDirectoryPicker !== "function") {
      notify("This browser cannot link a folder for saving (no File System Access directory picker). Opening it as an independent copy instead: edits stay in Carbon, so download or export them; the original files are never changed.");
      $("folders").click();
      return;
    }
    // Read access only: opening must not request or exercise write permission.
    const handle = await window.showDirectoryPicker({ mode: "read" });
    // The same folder picked again is the workspace Carbon already keeps for it, not a new copy.
    const known = await linkedWorkspaceFor(deps, handle);
    if (known) {
      if (known === state.stack.manifest.id) return notify("This folder is already the open workspace. Use Refresh from folder to re-read it.");
      return deps.switchWorkspace(known);
    }
    const read = await readDirectoryFiles(handle);
    await openFolderInput(deps, read.files, read.directories, (handle.name || "Local folder").slice(0, 200), false, { handle, read });
  });
  action("reconnect-folder", () => reconnectLink(deps));
  action("refresh-folder", () => refreshFolder(deps));
  action("forget-folder", () => forgetConsent(deps));
  action("save-folder", async () => {
    requireSaved();
    assert(
      window.showDirectoryPicker,
      "Direct folder saving unavailable. Export TAR or TAR.GZ.",
    );
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const { stack } = state;
    const name = await ask(
      "Save complete folder snapshot",
      "New child folder name",
      `${stack.manifest.id}-r${stack.manifest.revision}-${Date.now()}${isLocalFolder(stack) ? "" : ".stack"}`,
    );
    if (name === null) return;
    await saveDirectory(handle, stack, name);
    state.unexported = false;
    state.copyState = "folder";
    await persist();
    notify(`Saved complete snapshot in ${name}.`);
  });
  action("capabilities", async () =>
    modal(
      "Local browser capabilities",
      (c) => {
        c.append(
          el(
            "pre",
            JSON.stringify(
              {
                browser: navigator.userAgent,
                protocol: location.protocol,
                secureContext: window.isSecureContext,
                directoryPicker:
                  typeof window.showDirectoryPicker === "function",
                directoryUpload: "webkitdirectory" in $("folders"),
                gzip: typeof CompressionStream === "function",
                gunzip: typeof DecompressionStream === "function",
                draftCache: cacheAvailable(),
              },
              null,
              2,
            ),
          ),
          el(
            "p",
            "Feature presence does not prove permission. Folder access may be blocked by browser policy. Use TAR and file import/download as the fallback. No microphone or network integration is enabled.",
          ),
        );
      },
      null,
    ),
  );
}
