/** One sanitized Markdown/navigation pipeline for Editor Preview and independent Viewer. */
import { resolveLocalFile } from "../images/assets.js";
import { viewableIn } from "../workspace.js";
import { assert } from "../../core/validate.js";
import { renderMarkdown, resolveEntry } from "../markdown.js";
import { el } from "./dom.js";

export function renderEntryPreview(deps, root, source, path, navigate) {
  deps.images?.release(root);
  try {
    root.innerHTML = renderMarkdown(source, window, deps.state.stack);
  } catch (error) {
    root.replaceChildren(el("p", error.message));
  }
  for (const a of [...root.querySelectorAll("a")]) {
    const href = a.getAttribute("href");
    let target = null;
    if (href && !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) {
      try {
        target = resolveEntry(
          deps.state.stack,
          decodeURIComponent(href.split("#")[0]),
          path,
        );
        if (!target) {
          const file = resolveLocalFile(deps.state.stack, href, path);
          if (viewableIn(deps.state.stack, file)) target = file;
        }
      } catch {}
    }
    if (target) {
      a.setAttribute("href", "#");
      a.dataset.entry = target;
      a.title = target;
    } else {
      const b = el("button", undefined, "external-link");
      b.type = "button";
      b.append(...a.childNodes);
      if (href) {
        b.dataset.href = href;
        b.title = href;
      }
      a.replaceWith(b);
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    nodes = [];
  while (walker.nextNode())
    if (!walker.currentNode.parentElement.closest("code,pre,a,button"))
      nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.textContent,
      matches = [...text.matchAll(/\[\[([^\]\n]+)\]\]/g)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let start = 0;
    for (const m of matches) {
      fragment.append(text.slice(start, m.index));
      const target = resolveEntry(deps.state.stack, m[1], path),
        a = el("a", m[1].split("|")[1] || m[1]);
      a.href = "#";
      a.dataset.entry = target || "";
      a.title = target || "Unresolved or ambiguous Entry";
      fragment.append(a);
      start = m.index + m[0].length;
    }
    fragment.append(text.slice(start));
    node.replaceWith(fragment);
  }
  const hydrated = deps.images?.hydrate(root, path);
  root.onclick = (event) => {
    const a = event.target.closest("a,button.external-link");
    if (!a || !root.contains(a)) return;
    event.preventDefault();
    deps.run(async () => {
      if (a.dataset.entry !== undefined) {
        assert(a.dataset.entry, "Unresolved or ambiguous wiki link");
        return navigate(a.dataset.entry);
      }
      const href = a.dataset.href;
      if (href?.startsWith("#")) return;
      assert(href, "Unsafe link removed");
      await deps.modal(
        "Link destination",
        (c) => {
          c.append(
            el(
              "p",
              "External links do not open automatically. Copy this address into your browser if needed.",
            ),
            el("pre", href),
          );
        },
        null,
      );
    });
  };
  return hydrated;
}
