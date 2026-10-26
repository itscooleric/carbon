/**
 * Shell chrome: header menus (native <details>), the file-explorer toggle, the mobile
 * formatting row, the keyboard-shortcuts dialog and the shell shortcuts.
 * Ids used: #menu-import, #menu-export, #menu-more, #menu-doc (details), #import-return,
 * #dispatch, #files-toggle, #workspace, #show-shortcuts, #shortcuts-dialog,
 * #shortcuts-close. Buttons inside the menus keep their existing ids (#import,
 * #folder-import, #open-folder, #save-folder, #export-tar, #export-gzip, #export-handoff,
 * #register-dispatch, #history, #new-stack, #capabilities, #rename, #delete, …); their
 * handlers are bound by the modules that own them.
 *
 * Explorer: at ≥860px the sidebar is docked and collapses with `.side-collapsed` (the
 * preference is remembered in localStorage); below 860px it is an overlay toggled with
 * `.side-open`, which existing navigation code dismisses.
 */
import { $ } from "./dom.js";

/** @typedef {import("../types.js").Deps} Deps */

const MENUS = ["menu-import", "menu-export", "menu-more", "menu-doc"];
const SIDEBAR_KEY = "envoy.carbon.sidebar";
const NARROW = "(max-width: 859px)";

const narrow = () => matchMedia(NARROW).matches;

/** @returns {boolean} whether the file explorer is currently shown */
export function sidebarVisible() {
  const ws = $("workspace");
  return narrow()
    ? ws.classList.contains("side-open")
    : !ws.classList.contains("side-collapsed");
}

/** Reflect the explorer state on #files-toggle. Safe to call from any module. */
export function syncSidebarToggle() {
  $("files-toggle").setAttribute("aria-expanded", String(sidebarVisible()));
}

/** Show or hide the file explorer for the current layout. */
export function toggleSidebar() {
  const ws = $("workspace");
  if (narrow()) ws.classList.toggle("side-open");
  else {
    ws.classList.toggle("side-collapsed");
    try {
      localStorage.setItem(
        SIDEBAR_KEY,
        ws.classList.contains("side-collapsed") ? "collapsed" : "open",
      );
    } catch {
      /* Preference storage is optional. */
    }
  }
  syncSidebarToggle();
}

/**
 * Close every open shell menu.
 * @param {boolean} [refocus=false] move focus back to the summary of the menu that was open
 */
export function closeMenus(refocus = false) {
  for (const id of MENUS) {
    const menu = $(id);
    if (menu && menu.open) {
      menu.open = false;
      if (refocus) menu.querySelector("summary")?.focus();
    }
  }
}

/**
 * Update shell state that depends on the workspace. (The selection counter text is owned
 * by `renderStatus`, which runs after every checkbox change.)
 * @param {Deps} deps
 */
export function renderToolbar(deps) {
  void deps;
  syncSidebarToggle();
  syncProxies();
}

/** Formatting-row buttons mirror the enabled state of the control they forward to. */
function syncProxies() {
  for (const b of document.querySelectorAll("[data-proxy]")) {
    const target = $(b.dataset.proxy);
    b.disabled = !target || target.disabled;
  }
}

/**
 * Wire menus, Dispatch / Import Return, the explorer toggle, the formatting row, the
 * shortcuts dialog and the shell shortcuts. Menus close on outside click, on Escape (focus
 * returns to the summary) and after a menu button is activated. Arrow keys move between
 * items inside an open menu.
 * @param {Deps} deps
 */
export function mountToolbar(deps) {
  for (const id of MENUS) {
    const menu = $(id);
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      for (const other of MENUS) if (other !== id) $(other).open = false;
    });
    menu.addEventListener("click", (e) => {
      if (e.target.closest(".menu-pop button"))
        setTimeout(() => (menu.open = false), 0);
    });
    menu.addEventListener("keydown", (e) => {
      if (!menu.open || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
      const items = [
        ...menu.querySelectorAll(
          ".menu-pop button:not(:disabled):not([hidden]), .menu-pop input",
        ),
      ];
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      const next =
        e.key === "ArrowDown"
          ? items[(i + 1) % items.length]
          : items[(i - 1 + items.length) % items.length];
      next.focus();
    });
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu")) closeMenus();
    const proxy = e.target.closest("[data-proxy]");
    if (proxy && !proxy.disabled) {
      e.preventDefault();
      $(proxy.dataset.proxy)?.click();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape" && MENUS.some((id) => $(id).open)) {
      e.stopPropagation();
      closeMenus(true);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      deps.newDispatch();
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === "\\") {
      e.preventDefault();
      toggleSidebar();
    }
    if (e.key === "F1" && !document.querySelector("dialog[open]")) {
      e.preventDefault();
      $("show-shortcuts").click();
    }
  });
  $("dispatch").onclick = () => deps.newDispatch();
  $("import-return").onclick = () => deps.importReturn(null);
  $("files-toggle").onclick = toggleSidebar;
  const shortcuts = $("shortcuts-dialog");
  let shortcutsOpener = null;
  $("show-shortcuts").onclick = () => {
    shortcutsOpener = document.activeElement;
    shortcuts.showModal();
    $("shortcuts-close").focus();
  };
  $("shortcuts-close").onclick = () => shortcuts.close();
  shortcuts.addEventListener("close", () => {
    const back = shortcutsOpener?.isConnected ? shortcutsOpener : $("palette-launcher");
    back.focus({ preventScroll: true });
  });
  try {
    if (localStorage.getItem(SIDEBAR_KEY) === "collapsed")
      $("workspace").classList.add("side-collapsed");
  } catch {
    /* Preference storage is optional. */
  }
  matchMedia(NARROW).addEventListener("change", syncSidebarToggle);
  const observer = new MutationObserver(syncProxies);
  for (const b of document.querySelectorAll("[data-proxy]")) {
    const target = $(b.dataset.proxy);
    if (target) observer.observe(target, { attributes: true, attributeFilter: ["disabled"] });
  }
  renderToolbar(deps);
}
