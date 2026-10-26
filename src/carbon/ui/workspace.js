import { canEdit } from "../local-files.js";
/** Independent Editor/Viewer tabs. Entry editing stays in the existing adapter. */
import { assert, encode } from "../../core/validate.js";
import {
  workspaceState,
  addTab,
  removeTab,
  canOpen,
  isEntry,
  viewableIn,
} from "../workspace.js";
import { $, el } from "./dom.js";
import { syncSidebarToggle } from "./toolbar.js";
import { renderEntryPreview } from "./entry-preview.js";
import { assetPreview } from "./asset-preview.js";

export function mountWorkspace(deps, { openEditor }) {
  const { state } = deps;
  let viewed = null,
    viewedSource = null,
    viewedStackId = null,
    viewedStack = null,
    scrollTimer,
    restoring = null;
  const model = () => state.documents;
  function reconcile() {
    state.documents = workspaceState(state.stack, state.current, model());
    if (!model().editors.includes(state.current)) state.current = model().editors[0] || null;
    deps.editor.setOpenPaths(model().editors);
  }
  function rememberScroll() {
    if (
      !restoring &&
      viewed &&
      viewedStackId === state.stack.manifest.id &&
      model().viewers.includes(viewed)
    )
      model().scroll[viewed] = $("viewer-content").scrollTop;
  }
  function dismissOverlay() {
    $("workspace").classList.remove("side-open");
    syncSidebarToggle();
  }
  function layout() {
    const m = model(),
      docs = $("documents");
    docs.classList.toggle("viewer-shown", m.shown);
    docs.classList.toggle("viewer-first", m.swapped);
    docs.dataset.side = m.shown ? m.side : "editor";
    docs.style.setProperty("--editor-width", `${m.ratio}%`);
    $("viewer-pane").hidden = !m.shown;
    $("workspace-splitter").hidden = !m.shown;
    const viewerLabel = m.shown ? "Hide Viewer" : "Show Viewer";
    $("show-viewer").setAttribute("aria-label", viewerLabel);
    $("show-viewer").title = viewerLabel;
    $("show-viewer").setAttribute("aria-expanded", String(m.shown));
    $("swap-panes").disabled = !m.shown;
    $("workspace-editor").setAttribute(
      "aria-pressed",
      String(m.side === "editor" || !m.shown),
    );
    $("workspace-viewer").setAttribute(
      "aria-pressed",
      String(m.side === "viewer" && m.shown),
    );
    $("workspace-splitter").setAttribute(
      "aria-valuenow",
      String(Math.round(m.ratio)),
    );
    $("workspace-splitter").setAttribute(
      "aria-valuetext",
      `Editor ${Math.round(m.ratio)} percent`,
    );
    deps.editor.view.requestMeasure();
    restoreScroll();
  }
  function restoreScroll() {
    const root = $("viewer-content"), restore = restoring;
    if (!restore?.ready || !root.clientHeight) return;
    root.scrollTop = restore.top;
    requestAnimationFrame(() => {
      if (restoring === restore) restoring = null;
    });
  }
  // Explicit user scrolling wins over a pending asynchronous restoration.
  for (const name of ["wheel", "touchstart", "pointerdown", "keydown"])
    $("viewer-content").addEventListener(name, () => { restoring = null; }, { passive: true });
  new ResizeObserver(restoreScroll).observe($("viewer-content"));
  function focusTab(kind, path) {
    [...$(kind + "-tabs").querySelectorAll('[role="tab"]')]
      .find((b) => b.dataset.path === path)
      ?.focus();
  }
  function tabs(kind, paths, active) {
    const root = $(kind + "-tabs");
    root.replaceChildren();
    for (const [i, path] of paths.entries()) {
      const wrap = el("span", undefined, "document-tab"),
        tab = el("button"),
        close = el("button", "×", "close-tab");
      wrap.setAttribute("role", "presentation");
      tab.type = close.type = "button";
      tab.id = `${kind}-tab-${i}`;
      tab.dataset.path = path;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(path === active));
      tab.setAttribute(
        "aria-controls",
        kind === "editor" ? "editor-panel" : "viewer-content",
      );
      tab.tabIndex = path === active ? 0 : -1;
      tab.title = path;
      tab.textContent = path.split("/").pop();
      close.setAttribute("aria-label", `Close ${kind} tab ${path}`);
      close.tabIndex = -1;
      const select = async () => {
        if (kind === "editor") await navigate(path);
        else await openViewer(path, false);
        focusTab(kind, path);
      };
      tab.onclick = () => deps.run(select);
      tab.onkeydown = (event) => {
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End", "Delete"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Delete") return close.click();
        const n =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? paths.length - 1
              : (i + (event.key === "ArrowRight" ? 1 : -1) + paths.length) %
                paths.length;
        deps.run(async () => {
          if (kind === "editor") await navigate(paths[n]);
          else await openViewer(paths[n], false);
          focusTab(kind, paths[n]);
        });
      };
      close.onclick = () =>
        deps.run(async () => {
          rememberScroll();
          if (kind === "viewer") {
            model().viewer = removeTab(model().viewers, model().viewer, path);
            delete model().scroll[path];
          } else {
            state.current = removeTab(model().editors, state.current, path);
            if (state.drafts.has(path))
              deps.notify(
                "Editor tab closed. Its unsaved draft is kept in the file tree.",
              );
          }
          deps.render();
          await deps.persist();
          const next = kind === "editor" ? state.current : model().viewer;
          if (next) focusTab(kind, next);
          else
            $(kind === "editor" ? "workspace-editor" : "show-viewer").focus();
        });
      wrap.append(tab, close);
      root.append(wrap);
      if (path === active)
        $(kind === "editor" ? "editor-panel" : "viewer-content").setAttribute(
          "aria-labelledby",
          tab.id,
        );
    }
    if (!paths.length) {
      root.append(
        el(
          "span",
          kind === "editor" ? "No open Entries" : "No open references",
          "hint",
        ),
      );
      $(kind === "editor" ? "editor-panel" : "viewer-content").removeAttribute(
        "aria-labelledby",
      );
    }
    dirtyTabs();
  }
  function dirtyTabs() {
    for (const b of document.querySelectorAll('.document-tabs [role="tab"]')) {
      const dirty = state.drafts.has(b.dataset.path);
      const path = b.dataset.path,
        name = path.split("/").pop();
      const siblings =
        model()[b.closest("#editor-tabs") ? "editors" : "viewers"];
      const duplicate =
        siblings.filter((p) => p.split("/").pop() === name).length > 1;
      b.textContent = duplicate ? path : name;
      b.classList.toggle("dirty", dirty);
      b.setAttribute(
        "aria-label",
        b.dataset.path + (dirty ? ", unsaved draft" : ""),
      );
    }
  }
  function refreshViewer() {
    const path = model().viewer,
      root = $("viewer-content");
    // A Markdown document shows its draft rendered; other editable text shows its draft as text.
    const editable = Boolean(path) && canEdit(state.stack, path),
      markdown = editable && isEntry(path);
    const source = path
      ? (editable ? state.drafts.get(path) : undefined) ?? (markdown ? state.stack.text(path) : state.stack.files.get(path))
      : null;
    const resolvedTargetsChanged = isEntry(path) && viewedStack !== state.stack;
    if (
      viewed === path &&
      viewedSource === source &&
      viewedStackId === state.stack.manifest.id &&
      !resolvedTargetsChanged
    )
      return;
    rememberScroll();
    viewed = path;
    viewedSource = source;
    viewedStackId = state.stack.manifest.id;
    viewedStack = state.stack;
    $("viewer-path").textContent = path || "Reference Viewer";
    deps.images?.release(root);
    root.onclick = null;
    root.replaceChildren();
    const restore = { path, top: model().scroll[path] || 0 };
    restoring = restore;
    let hydrated;
    if (!path)
      root.append(
        el("h2", "Keep references beside your notes"),
        el(
          "p",
          "Choose Open in Viewer beside a file, or open the current Entry here. Viewer tabs never replace your editable note.",
        ),
      );
    else if (markdown)
      hydrated = renderEntryPreview(deps, root, source, path, openViewer);
    else if (deps.images?.supports(path) && !editable) hydrated = deps.images.renderAsset(root, path);
    else {
      // A draft is re-rendered as it is typed (lower highlighting cap); committed bytes are not.
      const live = typeof source === "string", bytes = live ? encode(source) : source;
      assetPreview(root, path, bytes, {
        download: () => deps.download(bytes, path.split("/").pop()),
        live,
      });
    }
    root.scrollTop = restore.top;
    Promise.resolve(hydrated).then(() => {
      requestAnimationFrame(() => {
        if (restoring !== restore) return;
        restore.ready = true;
        restoreScroll();
      });
    });
  }
  function render() {
    layout();
    tabs("editor", model().editors, state.current);
    tabs("viewer", model().viewers, model().viewer);
    $("open-current-viewer").disabled = !state.current;
    refreshViewer();
  }
  async function navigate(path) {
    if (!canEdit(state.stack, path)) return openEditor(path);
    assert(state.stack.files.has(path), "Entry no longer exists");
    addTab(model().editors, path);
    model().side = "editor";
    dismissOverlay();
    await openEditor(path);
    deps.editor.focus();
  }
  async function openViewer(path, focus = true) {
    assert(
      viewableIn(state.stack, path) && state.stack.files.has(path),
      "This file cannot be opened in Viewer",
    );
    rememberScroll();
    addTab(model().viewers, path);
    model().viewer = path;
    model().shown = true;
    model().side = "viewer";
    if ($("view").value === "split") {
      $("view").value = "edit";
      $("view").onchange();
    }
    dismissOverlay();
    if (!$("drawer").hidden) deps.closeDrawer();
    render();
    await deps.persist();
    if (focus) $("viewer-content").focus({ preventScroll: true });
  }
  $("viewer-content").addEventListener("scroll", () => {
    if (restoring) return;
    rememberScroll();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => deps.persist(), 500);
  });
  $("show-viewer").onclick = () =>
    deps.run(async () => {
      rememberScroll();
      model().shown = !model().shown;
      model().side = model().shown ? "viewer" : "editor";
      if (model().shown && $("view").value === "split") {
        $("view").value = "edit";
        $("view").onchange();
      }
      layout();
      await deps.persist();
    });
  $("swap-panes").onclick = () =>
    deps.run(async () => {
      model().swapped = !model().swapped;
      layout();
      await deps.persist();
    });
  for (const side of ["editor", "viewer"])
    $("workspace-" + side).onclick = () =>
      deps.run(async () => {
        model().side = side;
        if (side === "viewer") model().shown = true;
        layout();
        await deps.persist();
        if (side === "editor") deps.editor.focus();
        else $("viewer-content").focus({ preventScroll: true });
      });
  $("open-current-viewer").onclick = () =>
    deps.run(() => openViewer(state.current));
  const splitter = $("workspace-splitter");
  function resize(value) {
    model().ratio = Math.max(25, Math.min(75, value));
    layout();
  }
  splitter.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    resize(
      event.key === "Home"
        ? 50
        : model().ratio +
            (event.key === "ArrowRight" ? 5 : -5) * (model().swapped ? -1 : 1),
    );
    deps.persist();
  };
  splitter.onpointerdown = (event) => {
    if (event.button === 0) {
      splitter.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  };
  splitter.onpointermove = (event) => {
    if (!splitter.hasPointerCapture(event.pointerId)) return;
    const rect = $("documents").getBoundingClientRect();
    const left = ((event.clientX - rect.left) / rect.width) * 100;
    resize(model().swapped ? 100 - left : left);
  };
  splitter.onpointerup = splitter.onpointercancel = (event) => {
    if (splitter.hasPointerCapture(event.pointerId))
      splitter.releasePointerCapture(event.pointerId);
    deps.persist();
  };
  return {
    reconcile,
    render,
    navigate,
    openViewer,
    dirtyTabs,
    refreshViewer,
    showEditor() {
      model().side = "editor";
      layout();
      return deps.persist();
    },
    canOpen: (path) => canOpen(model().editors, path),
    rename(from, to) {
      for (const key of ["editors", "viewers"])
        model()[key] = model()[key].map((p) => (p === from ? to : p));
      if (model().viewer === from) model().viewer = to;
      model().scroll[to] = model().scroll[from] || 0;
      delete model().scroll[from];
      deps.editor.renameSession(from, to);
    },
  };
}
