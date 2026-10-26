import { canEdit, isLocalFolder, isMarkdown } from "../local-files.js";
/**
 * Sidebar: file tree, search, selection checkboxes (seed for the next Dispatch and the
 * legacy Needlecast scope), + Entry and + Folder, the Assets list and the Dispatches
 * cards.
 * Ids used: #tree, #search, #new-entry, #new-folder, #selection-status (via renderStatus),
 * #assets, #assets-section, #dispatches, #new-dispatch.
 * Exports `statusChip` so the drawer and review mode share one status vocabulary.
 */
import { assertNewPath, suggestPath } from "../../core/naming.js";
import { viewableIn } from "../workspace.js";
import { isTextLike } from "../asset-data.js";
import { entry } from "../../core/entries.js";
import { encode } from "../../core/validate.js";
import { SOURCE_STATES, sourceRows } from "../source.js";
import { $, el } from "./dom.js";

/** @typedef {import("../types.js").Deps} Deps */
/** @typedef {import("../types.js").WorkspaceState} WorkspaceState */

/**
 * Status vocabulary: class, glyph and words per Dispatch status. Each chip combines a
 * glyph, a word and a border style (see style.css) so no state relies on hue alone.
 * @type {Record<string, [string, string, string]>}
 */
export const STATUS = {
  draft: ["draft", "◌", "Draft"],
  exported: ["exported", "↗", "Exported · awaiting Return"],
  staged: ["staged", "⇩", "Return staged · not accepted"],
  accepted: ["accepted", "✓", "Accepted"],
  checkpoint: ["checkpoint", "⏸", "Checkpoint · no changes"],
  rejected: ["rejected", "⊘", "Return rejected"],
  abandoned: ["abandoned", "–", "Abandoned"],
};

/**
 * Build a status chip for a Dispatch record.
 * @param {string} status a `DispatchStatus`
 * @param {string} [extra] appended text, for example " → rev 7"
 * @returns {HTMLElement}
 */
export function statusChip(status, extra = "") {
  const [cls, glyph, words] = STATUS[status] || ["draft", "?", status];
  const chip = el("span", undefined, `chip ${cls}`);
  const g = el("span", glyph, "g");
  g.setAttribute("aria-hidden", "true");
  chip.append(g, words + extra);
  return chip;
}

/**
 * Human-readable byte size.
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Render the file tree filtered by the #search query. Markdown Entries get a selection
 * checkbox; every file gets a button that opens it. Paths and names are rendered as text.
 * @param {Deps} deps
 */
export function renderTree(deps) {
  const { state, run, openFile, renderStatus } = deps;
  const { stack, drafts, selected, current } = state;
  // Linked folder: each file's state against the folder (text + glyph), plus the paths only the folder or only the baseline knows.
  const source = state.link ? new Map(sourceRows(state.link, stack).map((r) => [r.path, r])) : null;
  const tree = { dirs: new Map(), files: [] };
  const query = $("search").value.toLowerCase();
  const folder = (p) => {
    let node = tree;
    for (const part of p.split("/").filter(Boolean)) {
      if (!node.dirs.has(part))
        node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    return node;
  };
  if (!query) for (const p of stack.directories) folder(p);
  for (const p of [...stack.files.keys()].sort()) {
    if (
      query &&
      !p.toLowerCase().includes(query) &&
      !(
        isMarkdown(p) &&
        canEdit(stack, p) &&
        (drafts.get(p) ?? stack.text(p)).toLowerCase().includes(query)
      )
    )
      continue;
    const parts = p.split("/");
    parts.pop();
    folder(parts.join("/")).files.push(p);
  }
  function branch(node) {
    const ul = el("ul");
    for (const [name, child] of [...node.dirs].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const li = el("li"),
        details = el("details");
      details.open = true;
      details.append(el("summary", name), branch(child));
      li.append(details);
      ul.append(li);
    }
    for (const p of node.files) {
      const li = el("li"),
        row = el("div", undefined, "file-row");
      if (canEdit(stack, p) && !isLocalFolder(stack)) {
        const check = el("input");
        check.type = "checkbox";
        check.checked = selected.has(p);
        check.setAttribute("aria-label", `Include ${p} in Needlecast`);
        check.onchange = () => {
          check.checked ? selected.add(p) : selected.delete(p);
          renderStatus();
        };
        row.append(check);
      }
      const b = el("button", undefined, p === current ? "selected" : "");
      b.append(el("span", p.split("/").pop(), "name"));
      if (drafts.has(p)) b.append(" ", el("span", "● unsaved", "tag dirty"));
      const src = source?.get(p);
      if (src && src.state !== "synced") {
        const { glyph, label } = SOURCE_STATES[src.state];
        const tag = el("span", `${glyph} ${label}`, `tag source${src.state === "conflict" || src.state === "missing" ? " is-conflict" : ""}`);
        tag.title = `${label}${src.moveTo ? ` (moved in folder to ${src.moveTo})` : ""}`;
        b.append(" ", tag);
      }
      b.title = p;
      b.onclick = () => run(() => openFile(p));
      row.append(b);
      if (viewableIn(stack, p)) {
        const view = el("button", "View", "open-in-viewer");
        view.setAttribute("aria-label", `Open ${p} in Viewer`);
        view.onclick = () => run(() => deps.workspace.openViewer(p));
        row.append(view);
      }
      li.append(row);
      ul.append(li);
    }
    return ul;
  }
  $("tree").replaceChildren(branch(tree));
  if (!tree.files.length && !tree.dirs.size)
    $("tree").append(
      el("p", "No matches. Try a shorter word or clear the search.", "hint"),
    );
  if (source && !query) renderSourceSections(deps, [...source.values()]);
  renderAssets(deps);
  renderDispatches(deps);
}

/**
 * Linked folder only: the paths that are not in Carbon's tree. "New in folder" lists incoming disk
 * files with Import (and Import all); "Deleted in Carbon" lists deleted paths whose folder version
 * is still known, with Restore and Forget. Both are collapsible and rendered as text.
 * @param {Deps} deps
 * @param {ReturnType<typeof sourceRows>} rows
 */
function renderSourceSections(deps, rows) {
  const { run } = deps;
  const incoming = rows.filter((r) => r.state === "incoming"),
    deleted = rows.filter((r) => r.state === "deletedInCarbon");
  const section = (title, members, buttons, all) => {
    if (!members.length) return;
    const details = el("details", undefined, "side-sec source-sec");
    details.open = true;
    details.append(el("summary", `${title} (${members.length})`));
    if (all) details.append(all);
    const ul = el("ul");
    for (const row of members) {
      const li = el("li");
      li.append(el("span", row.path), ...buttons(row));
      ul.append(li);
    }
    details.append(ul);
    $("tree").append(details);
  };
  const button = (label, fn, aria) => {
    const b = el("button", label, "sm");
    b.type = "button";
    if (aria) b.setAttribute("aria-label", aria);
    b.onclick = () => run(fn);
    return b;
  };
  const importable = incoming.filter((r) => r.captured !== false);
  section(
    `${SOURCE_STATES.incoming.glyph} New in folder`,
    incoming,
    (row) => (row.captured === false ? [el("span", "not captured; Refresh again", "hint")] : [button("Import", () => deps.source.importPaths([row.path]), `Import ${row.path}`)]),
    importable.length > 1 ? button(`Import all (${importable.length})`, () => deps.source.importPaths(importable.map((r) => r.path))) : null,
  );
  section(`${SOURCE_STATES.deletedInCarbon.glyph} Deleted in Carbon`, deleted, (row) => [
    button("Restore", () => deps.source.restore(row.path), `Restore ${row.path}`),
    button("Forget", () => deps.source.forget(row.path), `Forget ${row.path}`),
  ]);
}

/**
 * Refresh the "● unsaved" tags on existing tree buttons without rebuilding the tree.
 * Called from `renderStatus` so editor input keeps the sidebar honest.
 * @param {WorkspaceState} state
 */
export function renderDirtyTags(state) {
  for (const b of $("tree").querySelectorAll("button[title]")) {
    const tag = b.querySelector(".tag.dirty"),
      dirty = state.drafts.has(b.title);
    if (dirty && !tag) b.append(" ", el("span", "● unsaved", "tag dirty"));
    else if (!dirty && tag) {
      tag.previousSibling?.remove();
      tag.remove();
    }
  }
}

/**
 * Render the Assets section: every non-Markdown file except the manifest, with its size. In an
 * ordinary workspace editable text files are documents, not Assets, and the remaining text-like
 * files (too large to edit) are tagged TXT. Clicking a row opens the file (or the Asset dialog).
 * The section hides when there are none.
 * @param {Deps} deps
 */
export function renderAssets(deps) {
  const { state, run, openFile } = deps;
  const list = $("assets");
  list.replaceChildren();
  const local = isLocalFolder(state.stack);
  const paths = [...state.stack.files.keys()]
    .filter((p) => !isMarkdown(p) && p !== "stack.yaml" && !(local && canEdit(state.stack, p)))
    .sort();
  $("assets-section").hidden = !paths.length;
  for (const p of paths) {
    const li = el("li"),
      b = el("button", undefined, "asset-row");
    b.title = p;
    b.append(
      el("span", local && isTextLike(state.stack.files.get(p)) ? "TXT" : "BIN", "tag"),
      el("span", p, "mono"),
      el("span", formatBytes(state.stack.files.get(p).length), "sz"),
    );
    b.onclick = () => run(() => openFile(p));
    li.append(b);
    list.append(li);
  }
}

/**
 * Render the Dispatches cards (newest first): "Dispatch <seq> · rev <base>", status chip
 * and the first lines of the objective. Clicking a card opens the drawer, or review mode
 * when a Return is staged. Objectives are untrusted only insofar as they are user text;
 * they are rendered as text regardless.
 * @param {Deps} deps
 */
export function renderDispatches(deps) {
  const { state, openDispatch, activeDispatch } = deps;
  const list = $("dispatches");
  list.replaceChildren();
  // Records travel inside their Stack's workspace; only the open Stack's own are ever listed.
  const records = state.dispatches.filter((r) => r.stackId === state.stack.manifest.id).reverse();
  if (!records.length) {
    list.append(
      el(
        "li",
        "None yet. A Dispatch packages an assignment for an external AI.",
        "hint",
      ),
    );
    return;
  }
  const active = activeDispatch ? activeDispatch() : null;
  for (const r of records) {
    const li = el("li"),
      card = el("button", undefined, "dcard");
    card.type = "button";
    if (r.assignmentId === active) card.classList.add("current");
    card.dataset.assignment = r.assignmentId;
    const r1 = el("span", undefined, "r1");
    r1.append(
      el("span", `Dispatch ${r.seq} · rev ${r.baseRevision}`, "mono"),
      statusChip(
        r.status,
        r.status === "accepted" && r.acceptedRevision != null
          ? ` → rev ${r.acceptedRevision}`
          : "",
      ),
    );
    card.append(r1, el("span", r.draft.objective.trim() || "Untitled draft", "obj"));
    card.onclick = () => openDispatch(r.assignmentId);
    li.append(card);
    list.append(li);
  }
}

/**
 * Wire search, + Entry and + Folder.
 * @param {Deps} deps
 */
export function mountSidebar(deps) {
  const { state, action, modal, ask, replace, persist, render, templates } =
    deps;
  $("search").oninput = () => renderTree(deps);
  $("new-dispatch").onclick = () => deps.newDispatch();
  action("new-entry", async () => {
    const { stack } = state;
    // An ordinary workspace creates any text file: Markdown names start from a template (without
    // frontmatter), any other name starts empty. A Stack creates Markdown Entries only.
    const local = isLocalFolder(stack);
    const suggest = (kind) => suggestPath(stack, kind, new Date(), local ? { parent: "" } : {});
    const result = await modal(
      local ? "New file" : "Create Entry",
      (c) => {
        const l = el("label", "Filename / relative path"),
          input = el("input");
        l.append(input);
        const label = el("label", local ? "Template (Markdown files)" : "Template"),
          select = el("select");
        for (const kind of Object.keys(templates)) {
          const opt = el("option", kind);
          opt.value = kind;
          select.append(opt);
        }
        select.value = "note";
        let suggestion = suggest(select.value);
        input.value = suggestion;
        select.onchange = () => {
          if (input.value === suggestion) {
            suggestion = suggest(select.value);
            input.value = suggestion;
          }
        };
        label.append(select);
        c.append(
          label,
          l,
          el(
            "p",
            local
              ? "Any file name, with folders if you like: notes/today.md, todo.txt, config.yaml or README. A .md name starts from the template; any other file starts empty and is edited as plain text."
              : "Change the suggestion or include folders, for example entries/research/question.md. The Entry's stable ID is generated separately.",
            "hint",
          ),
        );
        return () => ({
          p: assertNewPath(stack, input.value, false, { text: local }),
          kind: select.value,
        });
      },
      "Create",
    );
    if (!result) return;
    assertNewPath(stack, result.p, false, { text: local });
    deps.workspace?.canOpen(result.p);
    const title = result.p.split("/").pop().replace(/\.md$/i, "");
    let source = templates[result.kind]
      .replace("ent-replace-with-stable-id", "ent-" + crypto.randomUUID())
      .replace(/^title:.*$/m, () => `title: ${JSON.stringify(title)}`)
      .replace(/^# .*$/m, () => `# ${title}`);
    if (local) source = isMarkdown(result.p) ? entry(source).body : "";
    await replace(
      stack.change({ writes: new Map([[result.p, encode(source)]]) }),
      local ? "Before creating file" : "Before creating Entry",
    );
    state.current = result.p;
    render();
    await persist();
  });
  action("new-folder", async () => {
    const { stack } = state;
    const p = await ask(
      "Create virtual folder",
      "Relative folder path",
      suggestPath(stack, "folder"),
      (value) => assertNewPath(stack, value, true),
    );
    if (p === null) return;
    assertNewPath(stack, p, true);
    await replace(
      stack.change({ directories: new Set([...stack.directories, p]) }),
      "Before creating folder",
    );
  });
}
