import {
  isLocalFolder, isScratch, isMarkdown, canEdit, sourceFor, toEditorText, textFormat, textIssue,
  describeLineEndings, saveBytes,
} from "../local-files.js";
/**
 * Editor pane: draft handling, Markdown preview (plain text files get a read-only text view),
 * wiki-link navigation, backlinks, view select, Save / Rename / Delete and Ctrl/Cmd+S.
 * Ids used: #editor, #preview, #links, #current-path, #view, #panes, #save-entry, #rename,
 * #delete, #dispatch-this (starts a Dispatch with the open Entry as context).
 *
 * Trust: Entry text is untrusted. The preview goes through `renderMarkdown` (DOMPurify)
 * and is then post-processed so no actionable external `href` remains in the DOM (CB-1).
 */
import { renameWorkspace } from "../workspace.js";
import { History } from "../../core/stack.js";
import { assert, encode } from "../../core/validate.js";
import { backlinkedEntries } from "../markdown.js";
import { $, el } from "./dom.js";
import { createEditor } from "../editor/view.js";
import { renderEntryPreview } from "./entry-preview.js";
import { assetPreview } from "./asset-preview.js";
import { textDetails, codePointsAt, FLAG_NOTES, lineEndMarker } from "../text-inspect.js";

/** @typedef {import("../types.js").Deps} Deps */

/** Files already named in a mixed-line-endings notice this session (workspace id + path). */
const toldMixed = new Set();

/**
 * Open a file from the tree: an editable file (a Markdown Entry; in an ordinary workspace any
 * bounded text) becomes the current file; the manifest and other files open in a read-only dialog
 * that says why they cannot be edited and offers the exact bytes for download.
 * @param {Deps} deps
 * @param {string} p
 * @returns {Promise<void>}
 */
export async function openFile(deps, p) {
  const { state, modal, download, render, persist } = deps;
  const { stack } = state;
  if (canEdit(stack, p)) {
    state.current = p;
    render();
    await persist();
    const format = textFormat(stack.text(p)), key = `${stack.manifest.id}\n${p}`;
    if (format.eol === "mixed" && !toldMixed.has(key)) {
      toldMixed.add(key);
      deps.notify(`${p} mixes line endings (${describeLineEndings(format)}). You can edit it; Save asks before changing them to LF.`, "info");
    }
  } else if (p === "stack.yaml" && !isLocalFolder(stack))
    await modal(
      "Stack manifest",
      (c) => {
        c.append(
          el("pre", stack.text(p)),
          el(
            "p",
            "Manifest identity and revisions are managed by Carbon. Other metadata stays byte-preserved.",
          ),
        );
      },
      null,
    );
  else
    await modal(
      "Asset",
      (c) => {
        c.append(el("p", `${p} — ${stack.files.get(p).length} bytes`));
        if (deps.images?.supports(p)) deps.images.renderAsset(c, p);
        else {
          const issue = isLocalFolder(stack) && textIssue(stack.files.get(p));
          if (issue)
            c.append(el("p", `Read-only: ${issue}. Carbon keeps its bytes unchanged; download it to inspect or change it elsewhere.`, "hint"));
          assetPreview(c, p, stack.files.get(p));
        }
        const b = el("button", "Download Asset");
        b.onclick = () => download(stack.files.get(p), p.split("/").pop());
        c.append(b);
      },
      null,
    );
}

/**
 * Render the current Entry (draft or saved text) into #preview and list backlinks in
 * #links. Wiki links `[[target]]` outside code and links become `href="#"` anchors with
 * `data-entry` (empty when unresolved).
 * @param {Deps} deps
 */
export function preview(deps) {
  const { state, run, openFile } = deps;
  const { stack, current, drafts } = state;
  deps.images?.release($("preview"));
  $("preview").setAttribute("aria-label", current && !isMarkdown(current) ? "Plain text preview" : "Markdown preview");
  if (!current) {
    $("preview").replaceChildren(
      el("h1", "Your notebook starts here"),
      el(
        "p",
        "Open existing files or a folder from Open / Import, or create a new Entry. No Stack manifest is needed to start writing.",
      ),
      el(
        "p",
        "Save Entry commits edits to this workspace. Export TAR.GZ creates a portable copy with every Entry and Asset.",
      ),
    );
    // Empty Stack: offer the three ways forward. A question needs no Entries and no Mission.
    if (![...stack.files.keys()].some((p) => /\.md$/i.test(p))) {
      const row = el("div", undefined, "empty-actions");
      const add = el("button", "+ New Entry", "primary"),
        askAI = el("button", "↗ Ask a question…", "outline"),
        imp = el("button", "Import files / archive…");
      add.onclick = () => $("new-entry").click();
      askAI.onclick = () =>
        deps.newDispatch({ seedContext: [], preset: "question" });
      imp.onclick = () => $("import").click();
      // Dispatch needs an Envoy Stack, so an ordinary workspace does not offer a question (RFC D14).
      row.append(...(isLocalFolder(stack) ? [add, imp] : [add, askAI, imp]));
      $("preview").append(
        el(
          "p",
          "Or send a one-off question to an external AI. A question needs no Entries and no Mission.",
        ),
        row,
      );
    }
    $("links").textContent = "Links between Entries will appear here.";
    return;
  }
  const source = current ? (drafts.get(current) ?? stack.text(current)) : "";
  if (!isMarkdown(current)) {
    // Plain text is never interpreted: no frontmatter, Markdown, HTML or wiki links. The text view
    // shows the draft through text nodes (or sanitized highlight.js spans).
    $("preview").replaceChildren(el("p", "Not a Markdown file, so nothing is rendered: its content is shown as text and never run.", "hint"));
    assetPreview($("preview"), current, drafts.has(current) ? encode(source) : stack.files.get(current), { editing: true });
    $("links").replaceChildren();
    return;
  }
  renderEntryPreview(deps, $("preview"), source, current, openFile);
  $("links").replaceChildren(el("span", "Backlinks: "));
  for (const p of backlinkedEntries(stack, current)) {
    const b = el("button", p);
    b.onclick = () => run(() => openFile(p));
    $("links").append(b);
  }
}

/**
 * Render the editor pane from state: path label, editor session and enablement, preview.
 * @param {Deps} deps
 */
export function renderEditor(deps) {
  const { state } = deps;
  const { stack, current, drafts } = state;
  $("current-path").textContent = current || (isLocalFolder(stack) ? "No file open" : "No Entry selected");
  deps.editor.sync(
    stack,
    current,
    current ? toEditorText(drafts.get(current) ?? stack.text(current)) : "",
  );
  for (const id of ["select-next", "text-details", "inspect-chars"]) $(id).disabled = !current;
  // Markdown formatting and image references belong to Markdown documents only.
  for (const id of ["toggle-task", "format-bold", "insert-image"])
    $(id).disabled = !isMarkdown(current);
  preview(deps);
}

/**
 * Ask before saving a file whose committed text mixes line endings. The only save offered rewrites
 * every line break as LF (a BOM is kept); the dialog can also download the exact original bytes.
 * @param {Deps} deps
 * @param {string} path
 * @returns {Promise<boolean>} true for the explicit "Save with LF line endings"
 */
async function chooseLineEndings(deps, path) {
  const { state, modal } = deps;
  const original = state.stack.files.get(path);
  const answer = await modal(
    "Mixed line endings",
    (c) => {
      const download = el("button", "Download original file");
      download.type = "button";
      download.onclick = () => deps.download(original, path.split("/").pop());
      c.append(
        el("p", `${path} mixes line endings (${describeLineEndings(textFormat(state.stack.text(path)))}). The Editor uses one kind, so Carbon cannot save your edit without changing them. Nothing has been saved; your draft is kept either way.`),
        el("p", "Save with LF line endings writes every line break of this file as LF this once. Otherwise cancel, or download the original exactly as it is."),
        download,
      );
      return () => true;
    },
    "Save with LF line endings",
  );
  return answer === true;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Read-only "Text details": the committed file's bytes, BOM and line endings versus the unsaved draft. */
function showTextDetails(deps) {
  const { state, modal } = deps;
  const { stack, current, drafts } = state;
  if (!current) return;
  const d = textDetails(stack, current, drafts.get(current));
  const where = state.link
    ? "Linked folder: Carbon's copy in this browser, not the folder. Save keeps it here; the folder changes only through Sync file to folder…."
    : isScratch(stack) ? "Scratch: saved in this browser only, not on disk."
      : isLocalFolder(stack) ? "Local copy in this browser, not on disk: the source files are unchanged until you download or export."
        : `Envoy Stack revision ${stack.manifest.revision}, kept in this browser.`;
  const eol = d.issue ? `Unknown: ${d.issue}.`
    : d.eol === "none" ? "No line breaks. Lines you add will use LF."
      : d.eol === "mixed" ? `Mixed: ${describeLineEndings({ counts: d.counts })}. Save asks before rewriting every line break as LF.`
        : `${d.eol.toUpperCase()} throughout (${plural(d.breaks, "line break")}); Save keeps it.`;
  const draft = !d.draft ? "None: the Editor shows the committed text."
    : `Yes, unsaved: it would save as ${plural(d.draft.bytes, "byte")}${d.draft.rewritesLineEndings ? " with LF line endings, after you confirm" : ` with the same ${d.bom ? "BOM and " : ""}line endings`}${d.draft.refused ? `, which Save refuses (over ${d.limit / 1024 ** 2} MiB or containing NUL); the draft is kept` : ""}. The committed bytes above are unchanged until Save.`;
  const inv = d.invisibles;
  return modal("Text details", (c) => {
    const dl = el("dl", undefined, "text-details");
    for (const [k, v] of [
      ["File", `${current} · ${plural(d.bytes, "committed byte")} (editing limit ${d.limit / 1024 ** 2} MiB)`],
      ["Where", where],
      ["Byte-order mark", d.issue ? "Unknown" : d.bom ? "Present (UTF-8 BOM, 3 bytes). The Editor hides it; Save keeps it." : "Absent."],
      ["Line endings", eol],
      ["Unsaved draft", draft],
      ...(inv ? [["Characters", [
        ["tab", "tabs"], ["space", "unusual spaces"], ["zero-width", "zero-width"], ["bidi", "bidirectional controls"],
        ["control", "other controls"], ["separator", "line/paragraph separators"], ["noncharacter", "noncharacters"],
        ["tag", "tag characters"], ["invisible", "other invisible"], ["surrogate", "lone surrogates"],
      ].map(([f, label]) => `${label}: ${inv.counts[f]}`).join(" · ") + ` · lines ending in whitespace: ${inv.trailing}`]] : []),
    ]) dl.append(el("dt", k), el("dd", v));
    c.append(dl);
    if (inv?.warn)
      c.append(el("p", "This text contains characters that are invisible or change text direction. Select a passage and use Inspect characters to see each code point.", "hint warn"));
    c.append(el("p", "The Editor shows LF text without a BOM; Save re-applies the committed file's convention. Nothing here changes the file.", "hint"));
  }, null);
}
/** Read-only code points at the caret or in the selection, by code point (a surrogate pair is one). */
function inspectCharacters(deps) {
  const { state, modal } = deps;
  if (!state.current) return;
  const { doc, selection } = deps.editor.view.state;
  const r = codePointsAt(doc.toString(), selection.main.from, selection.main.to);
  return modal("Inspect characters", (c) => {
    c.append(el("p", r.caret
      ? `At the cursor (line ${r.line}, column ${r.column}): the ${r.to <= selection.main.from ? "previous" : "next"} character.`
      : `Selection from line ${r.line}, column ${r.column}: ${plural(r.total, "code point")} in ${plural(r.to - r.from, "UTF-16 unit")}${r.truncated ? `; the first ${r.items.length} are listed` : ""}.`));
    if (!r.items.length) c.append(el("p", "The document is empty.", "hint"));
    else {
      const table = el("table", undefined, "code-points"), head = el("tr");
      for (const h of ["Code point", "Character", "Name", "Note"]) head.append(el("th", h));
      table.append(head);
      for (const i of r.items) {
        const row = el("tr"), [note, warn] = FLAG_NOTES[i.flag] ?? ["", false];
        row.append(el("td", i.hex), el("td", i.flag && i.flag !== "space" ? "" : i.char), el("td", i.name ?? "(no name data bundled)"), el("td", (warn ? `⚠ ${note}` : note) + (i.ascii ? ` (stands for "${i.ascii}")` : "")));
        if (warn) row.className = "warn";
        table.append(row);
      }
      c.append(table);
    }
    c.append(el("p", "Names come from a small bundled list of whitespace, control and format characters; other characters show no name.", "hint"));
  }, null);
}

/**
 * Wire editor input (draft tracking, debounced preview and cache), the view select,
 * preview link activation, Save Entry, Rename / move, Delete and Ctrl/Cmd+S.
 * @param {Deps} deps
 */
export function mountEditor(deps) {
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
    renderStatus,
    openFile,
  } = deps;
  let previewTimer, cacheTimer;
  const togglePreview = () => {
    deps.workspace?.showEditor();
    $("view").value = $("view").value === "preview" ? "edit" : "preview";
    $("view").onchange();
    if ($("view").value === "preview") $("preview").focus();
    else deps.editor.focus();
  };
  // "Show invisibles" labels line ends with the committed file's convention, never the draft's.
  const committedEol = (path) => {
    try {
      return textFormat(state.stack.text(path)).eol;
    } catch {
      return "none"; // committed bytes that do not decode (defensive: Refresh keeps a drafted file's readable old baseline)
    }
  };
  deps.editor = createEditor({
    parent: $("editor"),
    getContext: () => state,
    togglePreview,
    // Images become Markdown references; in plain text, paste and drop stay ordinary text input.
    handleImages: (event, view) =>
      (isMarkdown(state.current) && deps.images?.handleInput(event, view)) || false,
    lineEnding: committedEol,
    onChange: (text) => {
      const { stack, current, drafts } = state;
      if (!current) return;
      const saved = stack.text(current), value = sourceFor(stack, text, saved);
      // Undoing every edit leaves no draft, also in a file whose mixed line endings a draft cannot reproduce.
      if (value === saved || text === toEditorText(saved)) drafts.delete(current);
      else drafts.set(current, value);
      renderStatus();
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        preview(deps);
        deps.workspace?.refreshViewer();
      }, 160);
      clearTimeout(cacheTimer);
      cacheTimer = setTimeout(persist, 300);
    },
  });
  for (const [id, command] of [
    ["toggle-task", "task"],
    ["select-next", "next"],
    ["format-bold", "bold"],
  ]) {
    $(id).onclick = () => deps.editor.command(deps.editor[command]);
  }
  $("toggle-preview").onclick = togglePreview;
  $("occurrence-shortcut").onchange = () =>
    deps.editor.setOccurrenceKey($("occurrence-shortcut").checked);
  $("show-invisibles").onchange = () => {
    const on = $("show-invisibles").checked;
    deps.editor.setInvisibles(on);
    if (on) notify(`Showing spaces (·), tabs (→), unusual spaces (⍽), trailing whitespace and line ends (${lineEndMarker(state.current ? committedEol(state.current) : "none")[0]}: the committed file's convention). Markers are display only: never saved, copied, exported or searched.`, "info");
  };
  action("text-details", () => showTextDetails(deps));
  action("inspect-chars", () => inspectCharacters(deps));
  if (matchMedia("(max-width: 600px)").matches) {
    $("view").value = "edit";
    $("panes").className = "split edit";
  }
  $("view").onchange = () =>
    ($("panes").className = "split " + $("view").value);
  action("download-file", () => {
    const { stack, current, drafts } = state;
    if (current) deps.download(drafts.has(current) ? encode(drafts.get(current)) : stack.files.get(current), current.split("/").pop());
  });
  action("save-entry", async () => {
    const { stack, current, drafts } = state;
    if (!current || !drafts.has(current)) return;
    const draft = drafts.get(current);
    // A file that mixes line endings is rewritten only by the explicit LF choice, never by Save alone.
    const lf = textFormat(stack.text(current)).eol === "mixed";
    if (lf) {
      if (!(await chooseLineEndings(deps, current))) {
        notify(`Not saved: ${current} keeps its mixed line endings. Your draft is kept.`);
        return;
      }
      assert(
        state.stack === stack && state.current === current && state.drafts.get(current) === draft,
        "The file changed while the line-ending question was open. Nothing was saved; save again.",
      );
    }
    const bytes = saveBytes(stack, current, draft, { lf });
    // Every workspace saves to Carbon's own copy; a linked folder is written only by Sync file to folder….
    const next = stack.change({
      writes: new Map([[current, bytes]]),
    });
    if (isLocalFolder(stack)) {
      const history = new History([...state.history.items]), remaining = new Map(drafts);
      history.push(stack, `Before saving ${current}`);
      remaining.delete(current);
      await deps.commit({ stack: next, history, drafts: remaining, unexported: true, copyState: "pending" });
      deps.render();
    } else {
      const remaining = new Map(drafts);
      remaining.delete(current);
      await replace(next, `Before saving ${current}`, { drafts: remaining });
    }
    notify((isScratch(stack) ? "Saved in Scratch in this browser. Export to keep a copy outside the browser." : state.link ? `Saved in Carbon (this browser) only. The folder is unchanged; use Sync file to folder… to write ${current} there.` : isLocalFolder(stack) ? "Saved in this local copy. Download the file or export the folder to keep your changes; source files are unchanged." : "Entry saved as a new Stack revision. Export for a durable copy.") + (lf ? " Its line endings are now LF, as you chose; History keeps the previous version." : ""));
  });
  action("rename", async () => {
    requireSaved();
    const { stack, current } = state;
    if (!current) return;
    // An ordinary workspace renames any file (its mode follows the new name); a Stack keeps Entries Markdown.
    const local = isLocalFolder(stack);
    const p = await ask(
      local ? "Rename or move file" : "Rename or move Entry",
      local ? "New relative path" : "New relative .md path",
      current,
    );
    if (p === null || p === current) return;
    assert(local || isMarkdown(p), "Entry path must end in .md");
    const next = stack.change({ moves: [[current, p]] });
    if (isLocalFolder(stack)) {
      const history = new History([...state.history.items]);
      history.push(stack, "Before moving Entry");
      await deps.commit({ stack: next, history, current: p,
        documents: renameWorkspace(state.documents, [[current, p]]),
        unexported: true, copyState: "pending" });
      deps.editor.renameSession(current, p);
      deps.render();
    } else {
      // The editor session moves to the new path after the commit and before the render, which would
      // otherwise drop the old path's session (selection, scroll, undo).
      await replace(next, "Before moving Entry", { current: p, documents: renameWorkspace(state.documents, [[current, p]]) }, {
        committed: () => deps.editor.renameSession(current, p),
      });
    }
    notify(
      isLocalFolder(stack) ? "Moved in this copy. Path-based links and image references may need updating." : "Moved. Stable-ID wiki links still resolve; path-based links may need updating.",
    );
  });
  action("delete", async () => {
    requireSaved();
    const { stack, current } = state;
    if (!current) return;
    const ok = await modal(
      "Delete Entry?",
      (c) => {
        c.append(
          el("p", current),
          el(
            "p",
            "A prior revision will remain in History. The next full archive will omit this file.",
          ),
        );
        return () => true;
      },
      "Delete Entry",
    );
    if (ok)
      await replace(
        stack.change({ deletes: [current] }),
        "Before deleting Entry",
      );
  });
  $("dispatch-this").onclick = () => {
    const { current } = state;
    deps.newDispatch({
      seedContext: current ? [current] : [],
      openPath: current,
      preset: current && /plan/i.test(current) ? "plan" : "question",
    });
  };
  window.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (
      e.target === $("preview") &&
      e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      e.key.toLowerCase() === "p"
    ) {
      e.preventDefault();
      togglePreview();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      $("save-entry").click();
    }
  });
}
