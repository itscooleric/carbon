/** Native modal palette with ordinary buttons/disclosures and a separate editor bridge. */
import { $, el } from "./dom.js";
import { History } from "../../core/stack.js";
import { assert } from "../../core/validate.js";
import {
  buildIndex,
  searchIndex,
  matcher,
  excerpt,
  occurrences,
  normalizeSource,
  MAX_QUERY,
} from "../palette/search.js";
import { templateCommands, planTemplate } from "../palette/templates.js";
import { createNavigator } from "../palette/navigation.js";
import { syncSidebarToggle } from "./toolbar.js";


/**
 * Shell commands: each forwards to an existing control so behaviour, guards and
 * enablement stay owned by that control's module. Disabled or hidden controls are omitted.
 * [id, label, keywords, control id, shortcut]
 */
const SHELL_COMMANDS = [
  ["dispatch", "New Dispatch…", "assign ai cast send", "dispatch", "Ctrl/Cmd+Shift+D"],
  ["dispatch-this", "Dispatch this Entry…", "assign ai cast send current", "dispatch-this"],
  ["import-return", "Import Return…", "ai reply result review paste", "import-return"],
  ["new-entry", "New Entry", "create note file add", "new-entry"],
  ["new-folder", "New folder", "create directory add", "new-folder"],
  ["save-entry", "Save Entry", "write commit", "save-entry", "Ctrl/Cmd+S"],
  ["rename", "Rename / move Entry…", "move path", "rename"],
  ["download-file", "Download file", "save copy", "download-file"],
  ["delete", "Delete Entry…", "remove trash", "delete"],
  ["insert-image", "Insert image…", "picture png jpeg webp attach", "insert-image"],
  ["toggle-split", "Toggle split preview", "side by side editor preview vscode", "toggle-split"],
  ["toggle-layout", "Split: preview right / below", "orientation horizontal vertical stacked layout", "toggle-layout"],
  ["toggle-task", "Toggle task", "checkbox todo check", "toggle-task", "Alt+C"],
  ["format-bold", "Bold", "strong format", "format-bold", "Ctrl/Cmd+B"],
  ["select-next", "Select next occurrence", "multiple cursors selection", "select-next"],
  ["text-details", "Text details…", "bytes bom byte order mark line endings crlf lf cr encoding utf-8 inspect invisible", "text-details"],
  ["inspect-chars", "Inspect characters…", "unicode code point nbsp zero width bidi control invisible selection", "inspect-chars"],
  ["files-toggle", "Toggle file explorer", "sidebar tree files panel", "files-toggle", "Ctrl/Cmd+\\"],
  ["show-viewer", "Toggle Viewer", "reference panel split pane", "show-viewer"],
  ["open-current-viewer", "Open current Entry in Viewer", "reference panel", "open-current-viewer"],
  ["swap-panes", "Swap Editor and Viewer", "panes layout", "swap-panes"],
  ["open-scratch", "Scratch notes", "default notes home workspace switch", "open-scratch"],
  ["workspaces", "Workspaces…", "switch workspace mount folder stack open", "workspaces"],
  ["open-files", "Open files as local copy…", "import open markdown", "open-files"],
  ["import", "Import files / archive…", "open tar gz stack", "import"],
  ["folder-import", "Import folder as local copy…", "import directory", "folder-import"],
  ["open-folder", "Open folder (linked)…", "import directory", "open-folder"],
  ["save-folder", "Save new folder copy…", "export directory", "save-folder"],
  ["create-stack", "Create Envoy Stack from copy…", "convert", "create-stack"],
  ["export-tar", "Export TAR", "archive snapshot download", "export-tar"],
  ["export-gzip", "Export TAR.GZ", "archive snapshot download compressed", "export-gzip"],
  ["export-handoff", "Needlecast export (legacy)", "handoff v0.2", "export-handoff"],
  ["register-dispatch", "Register original handoff (legacy)", "needlecast v0.2", "register-dispatch"],
  ["history", "History", "revisions restore undo", "history"],
  ["sync-file", "Sync file to folder…", "linked folder write disk save original", "sync-file"],
  ["source-changes", "Folder changes…", "linked folder conflicts import missing compare", "source-changes"],
  ["disk-history", "Local file history…", "linked folder backups versions restore", "disk-history"],
  ["export-history", "Export local history…", "linked folder backups versions archive", "export-history"],
  ["refresh-folder", "Refresh from folder", "linked folder read disk observe rescan compare", "refresh-folder"],
  ["reconnect-folder", "Reconnect folder…", "linked folder permission access", "reconnect-folder"],
  ["forget-folder", "Forget remembered consent…", "linked folder permission remember withdraw", "forget-folder"],
  ["new-stack", "New Stack", "workspace create", "new-stack"],
  ["capabilities", "Capabilities", "about permissions", "capabilities"],
  ["show-shortcuts", "Keyboard shortcuts", "keys help", "show-shortcuts", "F1"],
];
const VIEWS = [["edit", "View: Editor only"], ["split", "View: Split editor and preview"], ["preview", "View: Preview only"]];
const THEME_LABELS = [["system", "Theme: System"], ["dark", "Theme: Graphite dark"], ["light", "Theme: Graphite light"]];

export function mountPalette(deps, { isBusy }) {
  const dialog = $("command-palette"),
    input = $("palette-query"),
    results = $("palette-results"),
    status = $("palette-status"),
    launcher = $("palette-launcher");
  const navigator = createNavigator(() => deps.editor.view);
  let generation = 0,
    buildGeneration = 0,
    index = null,
    commands = [],
    commandError = null,
    timer,
    opener,
    mode = false,
    composing = false,
    lastStack = null;
  const blocked = () => isBusy() || $("dialog").open || !$("review").hidden;
  function highlighted(text, query) {
    const node = el("span");
    let at = 0;
    if (query)
      for (const match of text.matchAll(matcher(query))) {
        node.append(text.slice(at, match.index), el("mark", match[0]));
        at = match.index + match[0].length;
      }
    node.append(text.slice(at));
    return node;
  }
  function button(label, fn, description = "", query = "") {
    const b = el("button", undefined, "palette-result");
    b.type = "button";
    b.dataset.paletteAction = "";
    b.append(highlighted(label, query));
    if (description) b.append(el("small", description));
    b.onclick = fn;
    return b;
  }
  function close(restoreFocus = true) {
    generation++;
    buildGeneration++;
    clearTimeout(timer);
    if (dialog.open) dialog.close();
    if (restoreFocus)
      (opener?.isConnected ? opener : launcher).focus({ preventScroll: true });
  }
  async function activate(action) {
    if (blocked()) return;
    try {
      assert(
        index?.stack === deps.state.stack,
        "The active Stack changed. Reopen the palette.",
      );
      let focus;
      // Keep the modal open on failed validation/commit; run's existing error handler stays intact.
      await deps.run(async () => {
        try {
          focus = await action();
        } catch (error) {
          status.textContent = error.message;
          throw error;
        }
      });
      if (!focus) return;
      close(false);
      focus();
    } catch (error) {
      status.textContent = error.message;
    }
  }
  async function openEntry(record, match = null) {
    const { state } = deps;
    assert(
      state.stack.files.has(record.path),
      "This Entry no longer exists. Search again.",
    );
    if (match)
      assert(
        normalizeSource(
          state.drafts.get(record.path) ?? state.stack.text(record.path),
        ) === record.source,
        "This Entry changed. Reopen the palette to search again.",
      );
    navigator.clear();
    const sidebarTop = $("sidebar").scrollTop;
    const folderKey = (node) => {
      const names = [];
      for (
        let folder = node;
        folder;
        folder = folder.parentElement.closest("details")
      )
        names.unshift(folder.querySelector(":scope > summary").textContent);
      return names.join("/");
    };
    const folders = new Map(
      [...$("tree").querySelectorAll("details")].map((node) => [
        folderKey(node), node.open,
      ]),
    );
    await deps.openFile(record.path);
    // Close the overlay/drawer only when opening an Entry; cancellation preserves both.
    if (!$("drawer").hidden) deps.closeDrawer();
    for (const node of $("tree").querySelectorAll("details"))
      if (folders.has(folderKey(node))) node.open = folders.get(folderKey(node));
    $("sidebar").scrollTop = sidebarTop;
    $("workspace").classList.remove("side-open");
    syncSidebarToggle();
    if (match && $("view").value === "preview") {
      $("view").value = "edit";
      $("view").onchange();
    }
    if (match) navigator.reveal(record.source, match);
    return () =>
      $("view").value === "preview"
        ? $("preview").focus()
        : deps.editor.focus();
  }
  function registrations() {
    const configured = templateCommands(deps.state.stack);
    commandError = configured.error;
    return [
      {
        id: "go-entry",
        label: "Go to Entry",
        keywords: "open find note",
        run: () => {
          mode = true;
          input.value = "";
          $("palette-all").hidden = false;
          input.placeholder = "Entry title, filename, path or ID";
          update();
          input.focus();
        },
      },
      {
        id: "toggle-preview",
        label: "Toggle Preview",
        keywords: "editor reading",
        run: () =>
          activate(async () => {
            if (!$("drawer").hidden) deps.closeDrawer();
            $("workspace").classList.remove("side-open");
            syncSidebarToggle();
            return () => $("toggle-preview").click();
          }),
      },
      ...SHELL_COMMANDS.filter(([, , , id]) => {
        const control = $(id);
        return control && !control.disabled && !control.closest("[hidden]");
      }).map(([id, label, keywords, control, keys]) => ({
        id: "shell:" + id,
        // Save follows the live button text ("Save Entry", "Save in copy", "Save in Carbon").
        label: control === "save-entry" ? $(control).textContent.trim() || label : label,
        keywords,
        description: `Command · ${keys || control}`,
        run: () =>
          activate(async () => {
            if (control !== "dispatch-this" && control !== "save-entry" && !$("drawer").hidden)
              deps.closeDrawer();
            return () => $(control).click();
          }),
      })),
      ...VIEWS.filter(([value]) => $("view").value !== value).map(([value, label]) => ({
        id: "view:" + value,
        label,
        keywords: "editor preview split layout",
        run: () =>
          activate(async () => () => {
            deps.workspace?.showEditor();
            $("view").value = value;
            $("view").onchange();
            if (value === "preview") $("preview").focus();
            else deps.editor.focus();
          }),
      })),
      ...THEME_LABELS.filter(([value]) => $("theme").value !== value).map(([value, label]) => ({
        id: "theme:" + value,
        label,
        keywords: "appearance color dark light graphite",
        run: () =>
          activate(async () => () => {
            $("theme").value = value;
            $("theme").dispatchEvent(new Event("change"));
            (opener?.isConnected ? opener : launcher).focus({ preventScroll: true });
          }),
      })),
      ...configured.commands.map((command) => ({
        id: "template:" + command.id,
        label: command.label,
        keywords: `template open create ${command.id} ${command.path}`,
        description: `Template ${command.id} · ${command.path}`,
        run: () =>
          activate(async () => {
            const { state } = deps;
            const plan = planTemplate(
              state.stack,
              state.drafts,
              deps.templates,
              command,
            );
            deps.workspace?.canOpen(plan.path);
            if (plan.next) {
              const history = new History([...state.history.items]);
              history.push(state.stack, `Before ${command.label}`);
              await deps.commit({
                stack: plan.next,
                history,
                current: plan.path,
                unexported: true,
                copyState: "pending",
                trusted: null,
              });
              deps.notify(
                "Template Entry created as a new revision. Existing drafts are still unsaved.",
              );
            }
            return openEntry({ path: plan.path });
          }),
      })),
    ];
  }
  function render(found, token) {
    results.replaceChildren();
    const warnings = [
      commandError,
      index.limited
        ? "Entity alias index is limited to 5,000 names; Entry and content search remain complete."
        : "",
      index.ambiguous
        ? `${index.ambiguous} ambiguous or unresolved entity names omitted; use an explicit Entry path.`
        : "",
      index.invalidDrafts
        ? "Some draft metadata is incomplete; saved metadata is used while draft contents remain searchable."
        : "",
    ].filter(Boolean);
    const total =
      found.commands.length +
      found.entries.length +
      found.entities.length +
      found.content.length;
    status.textContent =
      (total
        ? `${total} result${total === 1 ? "" : "s"}${mode ? " · Entries only" : ""}.`
        : "No results. Try a shorter phrase or clear the search.") +
      (warnings.length ? " " + warnings.join(" ") : "");
    function group(name, items, make) {
      if (!items.length) return;
      const section = el("section"),
        heading = el("h3", `${name} (${items.length})`),
        list = el("div");
      section.setAttribute("aria-label", name);
      section.append(heading, list);
      results.append(section);
      let count = 0;
      const more = button("Show more " + name.toLowerCase(), () =>
        append(true),
      );
      function append(focus = false) {
        const first = count;
        for (; count < Math.min(first + 40, items.length); count++)
          list.append(make(items[count]));
        more.remove();
        if (count < items.length) section.append(more);
        if (focus) {
          const item = list.children[first];
          (item?.querySelector("button,summary") || item)?.focus();
        }
      }
      append();
    }
    group("Commands", found.commands, (c) =>
      button(c.label, c.run, c.description || `Command · ${c.id}`, found.query),
    );
    group("Entries", found.entries, (r) =>
      button(
        r.label,
        () => activate(() => openEntry(r)),
        `${r.path}${r.id ? " · " + r.id : ""}${r.draft ? " · unsaved draft" : ""}`,
        found.query,
      ),
    );
    group("Entities", found.entities, (r) =>
      button(r.label, () => activate(() => openEntry(r)), r.path, found.query),
    );
    group("Content", found.content, (record) => {
      const details = el("details", undefined, "palette-document"),
        summary = el("summary"),
        list = el("div", undefined, "palette-excerpts");
      summary.append(
        el("strong", record.label),
        el(
          "small",
          `${record.path} · ${record.count} occurrence${record.count === 1 ? "" : "s"}${record.draft ? " · unsaved draft" : ""}`,
        ),
      );
      details.append(summary, list);
      let shown = 0,
        next = 0,
        loading = false;
      const more = button("Show more occurrences", async () => {
        if (loading) return;
        loading = true;
        more.disabled = true;
        const page = await occurrences(record.source, found.query, {
          from: next,
          limit: 20,
          cancelled: () => token !== generation,
        });
        if (page && token === generation) append(page.matches, true);
        loading = false;
        more.disabled = false;
      });
      function append(matches, focus = false) {
        let first;
        for (const match of matches) {
          const context = excerpt(record.source, match);
          const b = button(
            (context.prefix ? "…" : "") +
              context.text +
              (context.suffix ? "…" : ""),
            () => activate(() => openEntry(record, match)),
            `Occurrence ${++shown} · line ${context.line}`,
            found.query,
          );
          b.dataset.from = match.from;
          list.append(b);
          first ||= b;
          next = match.to;
        }
        more.remove();
        if (shown < record.count) list.append(more);
        if (focus) first?.focus();
      }
      details.addEventListener("toggle", () => {
        if (details.open && !shown) append(record.matches.slice(0, 5));
      });
      return details;
    });
  }
  async function update() {
    const token = ++generation;
    clearTimeout(timer);
    results.replaceChildren();
    if (!index) {
      status.textContent = "Indexing the active Stack…";
      return;
    }
    status.textContent = "Searching…";
    try {
      const found = await searchIndex(index, input.value, commands, {
        entriesOnly: mode,
        cancelled: () => token !== generation || !dialog.open,
      });
      if (found && token === generation && dialog.open) render(found, token);
    } catch (e) {
      if (token === generation) status.textContent = e.message;
    }
  }
  async function open() {
    if (dialog.open) {
      input.focus();
      return;
    }
    if (blocked()) return;
    opener = document.activeElement;
    composing = false;
    if (lastStack !== deps.state.stack.manifest.id) {
      input.value = "";
    }
    mode = false;
    input.placeholder = "Commands, Entries, entities or contents";
    lastStack = deps.state.stack.manifest.id;
    $("palette-all").hidden = !mode;
    index = null;
    commands = registrations();
    const token = ++buildGeneration;
    dialog.showModal();
    input.focus();
    input.select();
    update();
    try {
      const built = await buildIndex(deps.state, {
        cancelled: () => token !== buildGeneration || !dialog.open,
      });
      if (built && token === buildGeneration && dialog.open) {
        index = built;
        update();
      }
    } catch (e) {
      if (token === buildGeneration) status.textContent = e.message;
    }
  }
  input.maxLength = MAX_QUERY;
  input.addEventListener("compositionstart", () => {
    composing = true;
    generation++;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    update();
  });
  input.addEventListener("input", () => {
    generation++;
    clearTimeout(timer);
    results.replaceChildren();
    if (!composing) {
      status.textContent = "Searching…";
      timer = setTimeout(update, 100);
    }
  });
  $("palette-all").onclick = () => {
    mode = false;
    $("palette-all").hidden = true;
    input.placeholder = "Commands, Entries, entities or contents";
    update();
    input.focus();
  };
  $("palette-close").onclick = () => close();
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (!composing) close();
  });
  dialog.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.isComposing || composing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (
      (e.ctrlKey || e.metaKey) &&
      ["s", "d", "p"].includes(e.key.toLowerCase())
    ) {
      e.preventDefault();
      if (e.shiftKey && e.key.toLowerCase() === "p") {
        input.focus();
        input.select();
      }
      return;
    }
    const rows = [...results.querySelectorAll("button,summary")].filter(
      (node) => !node.disabled && node.getClientRects().length,
    );
    const current = rows.indexOf(document.activeElement);
    let next;
    if (e.key === "ArrowDown") next = (current + 1) % rows.length;
    if (e.key === "ArrowUp")
      next = current <= 0 ? rows.length - 1 : current - 1;
    if (e.target !== input && e.key === "Home") next = 0;
    if (e.target !== input && e.key === "End") next = rows.length - 1;
    if (next !== undefined && rows.length) {
      e.preventDefault();
      rows[next].focus();
      rows[next].scrollIntoView({ block: "nearest" });
    }
    if (e.target === input && e.key === "Enter" && rows.length) {
      e.preventDefault();
      rows[0].click();
    }
    if (
      e.target.tagName === "SUMMARY" &&
      ["ArrowRight", "ArrowLeft"].includes(e.key)
    ) {
      e.preventDefault();
      e.target.parentElement.open = e.key === "ArrowRight";
    }
  });
  launcher.onclick = open;
  window.addEventListener("keydown", (e) => {
    if (
      !e.isComposing &&
      !e.altKey &&
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      e.key.toLowerCase() === "p"
    ) {
      e.preventDefault();
      open();
    }
  });
}
