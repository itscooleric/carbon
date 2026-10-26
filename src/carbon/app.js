/**
 * Carbon composition root. Creates the one workspace state, builds the `deps` object every
 * view module receives, creates the dispatch and return controllers, mounts the views and
 * starts the workspace. No shared mutable state lives at module level except the cache
 * handle and the busy flag, which only this file reads or writes.
 */
import { History } from "../core/stack.js";
import { initTheme } from "./theme.js";
import { assert } from "../core/validate.js";
import { download } from "./fs.js";
import { archiveWorkspace, archiveName, assertStack, canEdit, defaultDocument, isLocalFolder, saveBytes, MixedLineEndingsError, SCRATCH_ID } from "./local-files.js";
import {
  createState,
  blankState,
  restore,
  persist as persistState,
  commit as commitState,
} from "./state.js";
import { openVfs, MemoryVfs, VfsConflictError, isConflict, isQuota, legacyDatabasePresent } from "./vfs.js";
import { activate, loadMount, mountTarget, recoveryFiles, removeMount } from "./mounts.js";
import { createFolderMemory, readFolderVersion, refreshFolder, restoreSnapshot, syncFile, takeDiskVersion, verifyLink } from "./linked.js";
import { trackBaseline } from "./source.js";
import templates from "./templates.json";
import castkitAssets from "./castkit-assets.json";
import {
  createDispatchController,
  missionCandidates,
} from "./controller/dispatch.js";
import { createReturnController } from "./controller/return.js";
import { $, el } from "./ui/dom.js";
import { modal, ask, confirm } from "./ui/dialogs.js";
import { notify, renderStatus, setPersistence, renderPersistence } from "./ui/status.js";
import { mountWorkspaces } from "./ui/workspaces.js";
import { renderTree, mountSidebar } from "./ui/sidebar.js";
import { preview, renderEditor, openFile, mountEditor } from "./ui/editor.js";
import { mountHistory } from "./ui/history.js";
import { mountStackIO, exportArchive } from "./ui/stack-io.js";
import {
  reviewReturn,
  mountNeedlecastLegacy,
} from "./ui/needlecast-legacy.js";
import { mountToolbar, renderToolbar } from "./ui/toolbar.js";
import { mountDispatchWizard } from "./ui/dispatch-wizard.js";
import { mountReturnReview } from "./ui/return-review.js";
import { mountImages } from "./ui/images.js";
import { mountWorkspace } from "./ui/workspace.js";
import { mountPalette } from "./ui/palette.js";
import { openDiskHistory } from "./history/disk.js";
import { mountDiskHistory } from "./ui/disk-history.js";
import { mountSource } from "./ui/source.js";
import { mountSplit } from "./ui/split.js";

/** @typedef {import("./types.js").Deps} Deps */

initTheme(window, $("theme"), $("theme-status"));
const state = createState();
/**
 * Workspace store (vfs.js): the durable `carbon-vfs` database, a per-window MemoryVfs when
 * IndexedDB is unavailable, or null once browser storage failed during this session.
 * @type {import("./vfs.js").Vfs|import("./vfs.js").MemoryVfs|null}
 */
let db = null;
/** Persistence state shown in the footer: see PERSISTENCE. */
let storage = "starting";
let writing = 0;
let busy = false;
/** View handles assigned after mounting; `deps` methods reach them lazily. */
let wizard = null,
  review = null,
  documents = null;

/** Footer wording per persistence state; never claims more durability than the store gives. */
const PERSISTENCE = {
  starting: "Opening browser storage…",
  saved: "Saved in this browser",
  saving: "Saving in this browser…",
  quota: "Browser storage is full — latest changes are only in this window; export",
  conflict: "Changed in another tab — this window is not saving; reload or export",
  memory: "Memory only — browser storage unavailable; export before closing",
  failed: "Browser storage unavailable — export before closing",
  error: "Last save to browser storage failed — earlier copy kept; retrying on your next change",
};
function showPersistence() {
  const key = storage === "saved" && writing ? "saving" : storage;
  setPersistence(PERSISTENCE[key], key);
  renderPersistence(state);
}
/** Browser storage failed for good in this window: keep working in memory and say so. */
function disableCache() {
  db = null;
  storage = "failed";
  showPersistence();
}
/**
 * Recovery download for storage failures: the open workspace WITH its unsaved drafts applied, built
 * in memory (no browser-storage commit, which is exactly what is failing). When the drafts cannot be
 * part of a valid workspace archive (validation, size or count limits), the committed workspace and
 * the drafts are downloaded separately, so recovery never depends on the workspace's spare capacity;
 * as a last resort each draft is downloaded as its own text file.
 */
function recoveryExport() {
  const { drafts } = state;
  const files = recoveryFiles(state.stack, drafts);
  for (const { name, bytes } of files) download(bytes, name);
  const plural = `${drafts.size} unsaved draft${drafts.size === 1 ? "" : "s"}`;
  notify(
    files.length === 1
      ? `Recovery archive requested, including ${plural}. Check that the download completed; Carbon still retries saving in this browser on your next change.`
      : `Recovery requested as ${files.length} downloads: the saved workspace and the ${plural} at their original paths. Check that every download completed; Carbon still retries saving in this browser on your next change.`,
    "pending",
  );
}
const exportAction = () => ({ label: "Download recovery copy", onClick: () => recoveryExport() });
/**
 * An explicit action that failed on quota or a conflict reports through `run()`, which shows
 * `e.actions`: give it the same recovery actions the background notice offers.
 */
function withRecovery(e) {
  if (!isQuota(e) && !isConflict(e)) return e;
  const actions = isConflict(e) ? [{ label: "Reload", onClick: () => location.reload() }, exportAction()] : [exportAction()];
  return Object.assign(new Error(e.message), { name: e.name, code: e.code, cause: e, actions });
}
/**
 * Classify a failed write. Quota and revision conflicts keep the store (the stored copy is
 * intact; the next change retries); anything else switches this window to memory only.
 * @param {Error} e
 * @param {boolean} announce show a notice (background writes); explicit actions report their own error
 */
function storageFailed(e, announce) {
  const was = storage;
  if (isConflict(e)) {
    storage = "conflict";
    if (announce && was !== "conflict")
      notify(`${e.message} Reload to continue with the newer copy (this window's unsaved changes are not kept), or export this window's copy first.`, "error", [
        { label: "Reload", onClick: () => location.reload() },
        exportAction(),
      ]);
  } else if (isQuota(e)) {
    storage = "quota";
    if (announce && was !== "quota")
      notify("Browser storage is full. The last saved copy in this browser is intact, but newer changes are only in this window. Export now; Carbon retries saving on your next change.", "error", [exportAction()]);
  } else if (announce) {
    disableCache();
    notify(`Browser storage failed: ${e.message}. Keep this window open and export.`, "error", [exportAction()]);
  } else if (storage !== "failed") storage = "error"; // an explicit action failed; it reports why and the next change retries
  showPersistence();
}
function storageSaved() {
  if (db?.durable && storage !== "failed") storage = "saved";
}
/** Queue a store write; a failure is reported (never thrown). */
function persist() {
  if (!db?.durable) return Promise.resolve();
  writing++;
  showPersistence();
  return persistState(state, db)
    .then(storageSaved, (e) => storageFailed(e, true))
    .finally(() => {
      writing--;
      showPersistence();
    });
}
/** Atomic commit through the store; the persistence state follows the outcome. */
async function storedCommit(candidate) {
  const durable = db?.durable;
  if (durable) writing++;
  try {
    await commitState(state, db, candidate);
    if (durable) storageSaved();
  } catch (e) {
    storageFailed(e, false);
    throw withRecovery(e);
  } finally {
    if (durable) writing--;
    showPersistence();
  }
}
/** Serialize UI operations so asynchronous imports cannot overwrite intervening edits. */
async function run(fn) {
  if (busy) return;
  busy = true;
  $("workspace").setAttribute("aria-busy", "true");
  deps.editor.setBusy(true);
  try {
    await fn();
  } catch (e) {
    notify(e.message, "error", e.actions || []);
  } finally {
    busy = false;
    $("workspace").setAttribute("aria-busy", "false");
    deps.editor.setBusy(false);
    renderStatus(deps);
  }
}
function requireStack() {
  assertStack(state.stack);
}
function requireSaved() {
  assert(
    state.drafts.size === 0,
    "Save or discard Entry drafts before this operation.",
  );
}
/**
 * Commit a new revision, retaining the previous one in History. Atomic for every workspace kind:
 * the store write comes first and nothing in `state` changes when it fails. `fields` are extra
 * candidate fields committed with it (drafts, current, documents, copy flags). `committed` runs after
 * a successful commit and before the render (for example to carry an editor session to a new path).
 */
async function replace(next, label, fields = {}, { committed } = {}) {
  // A different identity is a different workspace: it gets its own record and this one is kept.
  if (state.stack.manifest.id !== next.manifest.id) return openWorkspace(next);
  assert(isLocalFolder(next) === isLocalFolder(state.stack), "A Stack and an ordinary workspace cannot share an identity. Nothing was changed.");
  // Ordinary copies write the cache first; a failed write keeps the prior workspace. The same identity keeps
  // its link: in a linked folder every one of these revisions is virtual (the folder is written only by Sync).
  if (isLocalFolder(next) || isLocalFolder(state.stack)) {
    const history = new History([...state.history.items]);
    history.push(state.stack, label);
    const keep = isLocalFolder(next) ? canEdit(next, state.current) : next.files.has(state.current);
    await deps.commit({ stack: next, history, unexported: true, copyState: "pending", trusted: null, selected: new Set(),
      current: keep ? state.current : defaultDocument(next), ...fields });
    committed?.();
    // Dispatch / Return are Stack-only: drop a drawer or review the previous Stack left open, once the copy is committed.
    if (isLocalFolder(next)) {
      deps.closeDrawer();
      deps.closeReview();
    }
    render();
    return;
  }
  const history = new History([...state.history.items]);
  history.push(state.stack, label);
  const current = next.files.has(state.current) ? state.current : defaultDocument(next);
  await deps.commit({ stack: next, history, unexported: true, copyState: "pending", trusted: null, selected: new Set(), current, ...fields });
  committed?.(); // after the commit, before rendering (for example an editor-session rename)
  render();
}
const workspaceWarnings = (warnings) => warnings.length && notify(warnings.join(" "), "error");
function requireStore() {
  assert(db, "Browser storage failed in this window, so Carbon cannot keep another workspace beside this one. Export this workspace, then reload Carbon.");
  return db;
}
/** Track a workspace switch in the persistence state (the action reports its own error). */
async function switched(work) {
  try {
    await work;
    if (db?.durable) storageSaved();
  } catch (e) {
    // Only storage outcomes change the status; a refusal (cap, identity) leaves it as it was.
    if (db?.durable && (isQuota(e) || isConflict(e))) storageFailed(e, false);
    throw withRecovery(e);
  } finally {
    showPersistence();
  }
}
/** UI and link follow-up after the active workspace changed. */
async function activated() {
  deps.closeDrawer();
  deps.closeReview();
  $("workspace").classList.remove("side-open");
  await verifyLink(state);
  render();
}
/**
 * Open `next` as its own workspace, keeping the active one parked with its drafts, tabs,
 * History and Dispatches. A Stack whose identity is already stored activates that workspace
 * and opens the snapshot there (its previous revision goes to that workspace's History).
 * @param {import("./types.js").Documents} next
 * @param {Partial<import("./types.js").WorkspaceState>} [fields] initial fields (link, current, copy state…)
 */
async function openWorkspace(next, fields = {}, { expectRev } = {}) {
  const store = requireStore();
  const id = next.manifest.id;
  assert(id !== state.stack.manifest.id, "Internal error: openWorkspace on the active workspace");
  await store.list();
  const warnings = [];
  // Only an Envoy Stack can reuse a stored identity, and only one stored as a Stack: an archive
  // claiming the id of Scratch, a local copy or a linked folder never takes that workspace over.
  assert(
    isLocalFolder(next) || !id.startsWith("local-"),
    `This Stack's id (${id}) is reserved for Carbon's own workspaces. Nothing was opened.`,
  );
  if (Object.hasOwn(store.index, id)) {
    assert(
      store.index[id]?.kind === "stack" && !isLocalFolder(next),
      `A different workspace in this browser already uses the id ${id}. Nothing was opened.`,
    );
    const target = await loadMount(store, id, (m) => warnings.push(m));
    // The preview was built from this revision (0: no stored Stack); anything else must be previewed again.
    if (expectRev !== undefined && store.revs.get(id) !== expectRev) throw previewStale(id, expectRev, store.revs.get(id));
    assert(
      target.drafts.size === 0,
      `“${target.stack.manifest.title || id}” is already open in Carbon with unsaved drafts. Switch to it with Workspaces…, save or discard them, then import again.`,
    );
    const history = new History([...target.history.items]);
    history.push(target.stack, "Before importing full Stack");
    const current = next.files.has(target.current) ? target.current : null;
    await switched(activate(store, state, { ...target, history, trusted: null, ...fields, stack: next, current, selected: new Set() }, { write: true }));
  } else {
    // Previewed against a stored Stack that is gone now: preview again rather than create silently.
    if (expectRev !== undefined && expectRev !== 0) throw previewStale(id, expectRev, 0);
    // A new workspace starts without tabs but keeps the pane layout preference (swap, ratio).
    const layout = state.documents && { stackId: id, swapped: state.documents.swapped, ratio: state.documents.ratio };
    await switched(activate(store, state, { ...blankState(next), documents: layout, ...fields, stack: next }, { create: true }));
  }
  await activated();
  workspaceWarnings(warnings);
}
const previewStale = (id, expected, found) =>
  Object.assign(new VfsConflictError(id, expected, found), {
    message: "This Stack changed in browser storage (another Carbon tab) after the preview. Nothing was opened; import it again to see the current comparison.",
  });
/** Switch to a stored workspace (Scratch is created when it was never stored). */
async function switchWorkspace(id) {
  const store = requireStore();
  if (id === state.stack.manifest.id) return;
  const warnings = [];
  const { target, create } = await mountTarget(store, id, (m) => warnings.push(m));
  await switched(activate(store, state, target, { create }));
  await activated();
  notify(`Switched to ${state.stack.manifest.title || id}. Your previous workspace is kept in this browser.`);
  workspaceWarnings(warnings);
}
/** The stored Stack workspace with this id, for an import preview (null when none). */
async function storedStack(id) {
  if (!db) return null;
  await db.list();
  if (!Object.hasOwn(db.index, id) || db.index[id]?.kind !== "stack") return null;
  const target = await loadMount(db, id);
  return { stack: target.stack, rev: db.revs.get(id), drafts: target.drafts.size };
}
async function removeWorkspace(id, listedRev) {
  await removeMount(requireStore(), state, id, listedRev);
}
/** Save one Entry draft as a new revision (used by the Dispatch Context step). */
async function saveEntry(p) {
  const { stack, drafts } = state;
  if (!drafts.has(p)) return;
  // Same text guard as Save. The explicit LF choice for a mixed-line-ending Entry is offered by the Editor's Save only.
  let bytes;
  try {
    bytes = saveBytes(stack, p, drafts.get(p));
  } catch (e) {
    if (e instanceof MixedLineEndingsError)
      throw new Error(`${p} mixes line endings, so it is not saved from here. Open it and use Save in the Editor to choose LF line endings, or send the saved version. Your draft is kept.`);
    throw e;
  }
  const next = stack.change({ writes: new Map([[p, bytes]]) });
  const remaining = new Map(drafts);
  remaining.delete(p);
  await replace(next, `Before saving ${p}`, { drafts: remaining });
  notify("Entry saved as a new Stack revision. Export for a durable copy.");
}
function render() {
  documents?.reconcile();
  // Disk history controls are meaningful only for linked folders; imported copies keep Revision history.
  for (const id of ["disk-history", "export-history"]) $(id).hidden = !state.link;
  renderStatus(deps);
  renderTree(deps);
  renderEditor(deps);
  renderToolbar(deps);
  documents?.render();
  if (wizard) wizard.render();
}
/** Import Return dialog: paste or choose a file, pick the Dispatch it answers, route. */
async function importReturn(assignmentId = null, prefill = {}) {
  requireStack();
  const records = state.dispatches.filter((r) =>
    ["exported", "staged", "checkpoint", "rejected"].includes(r.status),
  );
  const result = await modal(
    "⇩ Import Return",
    (c) => {
      c.append(
        el(
          "p",
          "Paste the AI's reply or choose a file. Carbon checks it against the original Cast before showing any changes. Nothing is applied on import.",
          "hint",
        ),
      );
      if (prefill.error) {
        const err = el("div", undefined, "err");
        err.setAttribute("role", "alert");
        err.append(el("b", prefill.error));
        if (/original Cast not found/i.test(prefill.error))
          err.append(
            el(
              "p",
              "Import original Cast…: importing a Cast file is not available in this version. Open the Stack the assignment was dispatched from, or export a fresh Dispatch and ask for the Return again.",
            ),
          );
        c.append(err);
      }
      const forLabel = el("label", "Answers Dispatch"),
        select = el("select");
      select.id = "return-for";
      const detect = el("option", "Detect from packet (assignment_id)");
      detect.value = "";
      select.append(detect);
      for (const r of records) {
        const o = el(
          "option",
          `Dispatch ${r.seq} · ${r.draft.objective.trim().slice(0, 50) || "Untitled"} · rev ${r.baseRevision}`,
        );
        o.value = r.assignmentId;
        select.append(o);
      }
      select.value =
        prefill.assignmentId ??
        (assignmentId && records.some((r) => r.assignmentId === assignmentId)
          ? assignmentId
          : "");
      forLabel.append(select);
      const textLabel = el("label", "Return text"),
        text = el("textarea");
      text.id = "return-text";
      text.rows = 8;
      text.placeholder = "# Envoy Cast Return";
      text.value = prefill.text || "";
      text.setAttribute("spellcheck", "false");
      textLabel.append(text);
      const fileRow = el("div", undefined, "row"),
        file = el("input");
      file.type = "file";
      file.id = "return-file";
      file.accept = ".md,.txt,text/markdown,text/plain";
      file.setAttribute("aria-label", "Choose a Return file");
      file.onchange = async () => {
        const f = file.files[0];
        if (!f) return;
        assert(f.size <= 4 * 1024 * 1024, "Return file too large (4 MiB limit)");
        text.value = await f.text();
      };
      fileRow.append(
        file,
        el(
          "span",
          ".md or .txt. Imported HTML is shown as text, never rendered.",
          "hint",
        ),
      );
      c.append(
        forLabel,
        textLabel,
        fileRow,
        el(
          "p",
          "Legacy Carbon handoffs (envoy.handoff/v0.2) are routed to the existing review automatically.",
          "hint",
        ),
      );
      setTimeout(() => text.focus(), 0);
      return () => {
        assert(text.value.trim(), "Paste a Return or choose a file.");
        return { text: text.value, assignmentId: select.value || null };
      };
    },
    "Check Return",
  );
  if (!result) return;
  const kind = returns.route(result.text);
  if (kind === "unknown")
    return importReturn(assignmentId, {
      ...result,
      error:
        "Not a Return Carbon understands. Expected a packet starting with “# Envoy Cast Return” (envoy.return/v0.1) or a legacy “# Envoy Handoff” packet.",
    });
  if (kind === "legacy-handoff") return reviewReturn(deps, result.text);
  let model;
  try {
    model = await returns.stage(result.text, result.assignmentId);
  } catch (e) {
    return importReturn(assignmentId, { ...result, error: e.message });
  }
  render();
  review.open(model);
  notify(
    `Return for Dispatch ${model.dispatch.seq} staged. The Stack has not changed.`,
  );
}
/**
 * Beyond the `Deps` typedef, the Dispatch / Return views receive:
 * `castkitAssets` ({playbooks, contract, bootstrap}), `dispatch` and `returns` (the two
 * controllers), `saveEntry(path)`, `exportGzip()`, `newDispatch(opts?)`,
 * `openDispatch(assignmentId)`, `activeDispatch()`, `closeDrawer()`, `closeReview()`,
 * `importReturn(assignmentId|null)` and `openReview(assignmentId)`.
 * @type {Deps}
 */
const deps = {
  state,
  templates,
  castkitAssets,
  persist,
  /**
   * The one coupling between virtual revisions and the linked folder's source records: a candidate
   * that replaces `stack` without naming `link` carries the baseline forward (`trackBaseline`
   * shadows the bytes a changed or removed baseline path held). Actions that compute their own
   * baseline (Take disk, Import, Keep mine, Sync…) pass `link` and are left alone.
   */
  commit: (candidate) => {
    if (state.link && candidate?.stack && candidate.stack !== state.stack && !("link" in candidate)) {
      const baseline = trackBaseline(state.link.baseline, state.stack, candidate.stack);
      if (baseline !== state.link.baseline) candidate = { ...candidate, link: { ...state.link, baseline } };
    }
    return storedCommit(candidate);
  },
  cacheAvailable: () => db?.durable === true,
  disableCache,
  openWorkspace,
  storedStack,
  switchWorkspace,
  removeWorkspace,
  workspaceStore: () => db,
  run,
  action: (id, fn) => $(id).addEventListener("click", () => run(fn)),
  modal,
  ask,
  confirm,
  notify,
  render,
  renderStatus: () => renderStatus(deps),
  renderTree: () => renderTree(deps),
  preview: () => preview(deps),
  openFile: (p) => documents ? documents.navigate(p) : openFile(deps, p),
  replace,
  requireSaved,
  requireStack,
  download,
  reviewReturn: (text) => { requireStack(); return reviewReturn(deps, text); },
  saveEntry,
  // Linked folders (linked.js): the folder is read by Refresh and written by Sync only.
  syncFile: (path, options) => syncFile(deps, path, options),
  refreshFolder: () => refreshFolder(deps),
  takeDiskVersion: (path, options) => takeDiskVersion(deps, path, options),
  readFolderVersion: (path) => readFolderVersion(deps, path),
  /**
   * Before Sync writes the folder: the workspace this window holds must still be the stored one. Read
   * from the switcher index (written in the same transaction as every body), never through `read`,
   * which would adopt a newer revision and let a stale copy overwrite it later.
   */
  checkRevision: async () => {
    if (!db?.durable) return;
    const id = state.stack.manifest.id;
    await db.list();
    const listed = db.index[id]?.rev, held = db.revs.get(id);
    if (listed === held) return;
    const e = new VfsConflictError(id, held ?? 0, listed ?? 0);
    storageFailed(e, false); // the footer shows the conflict state, as after a refused commit
    throw withRecovery(e);
  },
  // Disk-backed history (history/disk.js) lives in `.carbon-history/` inside the linked folder. The
  // global is a test seam for tests/linked-browser.mjs only (fake handles cannot reach the real module);
  // it is honoured only for a file: page driven by WebDriver/Playwright, never for a person's session.
  diskHistory: (handle, options) =>
    typeof globalThis.carbonTestDiskHistory === "function" && location.protocol === "file:" && navigator.webdriver === true
      ? globalThis.carbonTestDiskHistory(handle, options)
      : openDiskHistory(handle, options),
  /**
   * History browsing is read-only and never creates `.carbon-history/`, so it needs no write consent: existing
   * backups stay reachable after reopening a folder, after Forget, or with future backups off.
   */
  openHistory: async () => {
    assert(state.link, "Local file history is kept only for linked folders. Open folder… links a folder; imported copies use Revision history instead.");
    assert(state.link.status === "linked", "Reconnect the linked folder before browsing its local file history.");
    return deps.diskHistory(state.link.handle, { create: false });
  },
  /** Disk-history Restore puts the old bytes into Carbon's copy (a new revision, History first); the folder is written only by Sync. */
  restoreFromDisk: async (path, bytes) => {
    const result = await restoreSnapshot(deps, path, bytes);
    render();
    return result;
  },
  folderName: () => state.link?.handle?.name || state.stack.manifest.title || state.stack.manifest.id,
  folderMemory: createFolderMemory(() => (db?.durable ? db.db : null)),
  exportGzip: () => run(() => exportArchive(deps, true)),
  downloadSnapshot: (label) =>
    download(
      archiveWorkspace(state.stack),
      isLocalFolder(state.stack) ? `${label}-${archiveName(state.stack)}` : `${state.stack.manifest.id}-${label}-r${state.stack.manifest.revision}.stack.tar`,
    ),
  // Dispatch / Return wiring (controllers are created below; views reach them lazily).
  dispatch: null,
  returns: null,
  newDispatch: (opts) => {
    try { requireStack(); return wizard.create(opts); }
    catch (e) { notify(e.message, "error"); }
  },
  openDispatch: (id) => {
    if (isLocalFolder(state.stack)) return notify("Open an Envoy Stack to work with Dispatches.", "error");
    const r = deps.dispatch.find(id);
    if (!r) return notify("Unknown Dispatch", "error");
    if (r.status === "staged") return deps.openReview(id);
    wizard.open(id);
  },
  activeDispatch: () => (wizard ? wizard.activeId() : null),
  closeDrawer: () => {
    if (wizard && wizard.isOpen()) wizard.close(false);
  },
  closeReview: () => {
    if (review && review.isActive()) review.close();
  },
  importReturn: (id) => run(() => importReturn(id)),
  openReview: (id) => {
    try {
      requireStack();
      review.open(deps.returns.review(id));
    } catch (e) {
      notify(e.message, "error");
    }
  },
};
const dispatch = createDispatchController({
  state,
  persist,
  commit: deps.commit,
  assets: castkitAssets,
  download,
  clipboard: (text) => navigator.clipboard.writeText(text),
});
const returns = createReturnController({
  state,
  persist,
  commit: deps.commit,
  download,
  history: state.history,
});
dispatch.missionCandidates = missionCandidates;
deps.dispatch = dispatch;
deps.returns = returns;
mountToolbar(deps);
mountSidebar(deps);
mountEditor(deps);
mountSplit(); // after mountEditor: it drives #view.onchange
documents = mountWorkspace(deps, { openEditor: (p) => openFile(deps, p) });
deps.workspace = documents;
deps.images = mountImages(deps, { isBusy: () => busy });
mountHistory(deps);
mountDiskHistory(deps);
mountSource(deps);
mountStackIO(deps);
mountWorkspaces(deps);
mountNeedlecastLegacy(deps);
wizard = mountDispatchWizard(deps);
review = mountReturnReview(deps);
mountPalette(deps, { isBusy: () => busy });
/** Memory-only window: parked workspaces with work in them vanish on close too (a pristine Scratch does not count). */
const parkedWorkAtRisk = () =>
  db instanceof MemoryVfs &&
  [...db.bodies.entries()].some(([id, body]) => id !== state.stack.manifest.id && (body.drafts?.length || body.unexported));
window.addEventListener("beforeunload", (e) => {
  if (state.drafts.size || state.unexported || parkedWorkAtRisk()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
/**
 * Open the `carbon-vfs` store and restore the active workspace (Scratch when none). A damaged
 * record is never overwritten: a damaged non-Scratch workspace falls back to Scratch, and a
 * damaged Scratch (or an unreadable store) runs this window in memory only.
 */
async function start() {
  busy = true;
  deps.editor.setBusy(true);
  render();
  const warnings = [];
  let recovered = false;
  try {
    db = await openVfs({
      onVersionChange: () => {
        disableCache();
        notify("A newer Carbon opened this browser storage. This window stopped saving; export, then reload.", "error", [exportAction()]);
      },
    });
    const loaded = await db.load();
    let restored = null;
    if (loaded.record)
      try {
        // A body without a valid revision would refuse every later save: treat it as damaged.
        assert(Number.isSafeInteger(loaded.record.rev) && loaded.record.rev > 0, "its storage revision is unreadable");
        restored = restore(loaded.record, (m) => warnings.push(m));
        assert(restored.stack.manifest.id === loaded.id, "its stored identity does not match");
      } catch (e) {
        // A damaged Scratch has no safe fallback: run in memory so nothing can overwrite it.
        if (loaded.id === SCRATCH_ID) throw new Error(`Scratch could not be restored (${e.message}); its stored copy is left untouched`);
        restored = null;
        warnings.push(`The workspace “${loaded.record?.title || loaded.id}” could not be restored (${e.message}); its stored copy is left untouched. Opened Scratch instead.`);
      }
    if (!restored && loaded.id !== SCRATCH_ID) {
      const scratch = await db.read(SCRATCH_ID);
      if (scratch)
        try {
          assert(Number.isSafeInteger(scratch.rev) && scratch.rev > 0, "its storage revision is unreadable");
          restored = restore(scratch, (m) => warnings.push(m));
          assert(restored.stack.manifest.id === SCRATCH_ID, "its stored identity does not match");
        } catch (e) {
          // A damaged Scratch has no safe fallback: memory only below, so nothing overwrites it.
          throw new Error(`Scratch could not be restored (${e.message}); its stored copy is left untouched`);
        }
    }
    if (restored) {
      Object.assign(state, restored);
      recovered = true;
    }
    storage = "saved";
  } catch (e) {
    db?.close?.();
    db = new MemoryVfs();
    storage = "memory";
    warnings.push(`Browser storage unavailable: ${e.message}. Carbon works in this window only; export before closing.`);
  }
  showPersistence();
  await verifyLink(state);
  if (warnings.length) notify(warnings.join(" "), "error");
  else if (recovered)
    notify(
      state.link && state.link.status !== "linked"
        ? "Recovered local workspace. The linked folder needs Reconnect folder… before Refresh or Sync; your files and drafts stay editable in Carbon."
        : "Recovered local workspace. Export archives for durable copies.",
    );
  else
    notify(
      (await legacyDatabasePresent())
        ? "Ready. Start typing in Scratch; notes are saved in this browser until you export them. Workspaces from earlier Carbon test builds are not loaded here: open that build, export them, then import the files (see docs/virtual-workspace.md)."
        : "Ready. Start typing in Scratch; notes are saved in this browser until you export them.",
    );
  busy = false;
  deps.editor.setBusy(false);
  render();
  if (!recovered) deps.editor.focus(); // a new Scratch note (also in a memory-only window) is ready to type into
}
start();
