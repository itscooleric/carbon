/** Offline raster IO: atomic insertion and short-lived, validated blob URLs only. */
import { isConflict, isQuota } from "../vfs.js";
import { assert } from "../../core/validate.js";
import { History } from "../../core/stack.js";
import { isolateHistory } from "@codemirror/commands";
import {
  inspectImage,
  imagePath,
  resolveLocalFile,
  planImages,
  IMAGE_PIXELS,
} from "../images/assets.js";
import { $, el } from "./dom.js";

export function mountImages(deps, { isBusy }) {
  const checked = new WeakMap(),
    roots = new Map();
  let pickerSnapshot = null;
  function release(root) {
    const previous = roots.get(root);
    if (previous) for (const url of previous.urls) URL.revokeObjectURL(url);
    roots.delete(root);
  }
  function begin(root) {
    release(root);
    const job = { urls: new Set() };
    roots.set(root, job);
    return job;
  }
  const current = (root, job) => roots.get(root) === job && root.isConnected;
  function urlFor(root, job, bytes, info) {
    if (!current(root, job)) return null;
    const url = URL.createObjectURL(new Blob([bytes], { type: info.mime }));
    job.urls.add(url);
    return url;
  }
  new MutationObserver(() => {
    for (const root of roots.keys()) if (!root.isConnected) release(root);
  }).observe(document.body, { childList: true, subtree: true });
  $("dialog").addEventListener("close", () => release($("dialog-content")));
  function validate(bytes) {
    if (!checked.has(bytes))
      checked.set(
        bytes,
        (async () => {
          const info = inspectImage(bytes),
            blob = new Blob([bytes], { type: info.mime });
          let width, height;
          if (typeof createImageBitmap === "function") {
            const bitmap = await createImageBitmap(blob);
            width = bitmap.width;
            height = bitmap.height;
            bitmap.close();
          } else {
            const url = URL.createObjectURL(blob),
              image = new Image();
            try {
              image.src = url;
              await image.decode();
              width = image.naturalWidth;
              height = image.naturalHeight;
            } finally {
              image.removeAttribute("src");
              URL.revokeObjectURL(url);
            }
          }
          assert(
            width > 0 &&
              height > 0 &&
              width <= 8192 &&
              height <= 8192 &&
              width * height <= IMAGE_PIXELS,
            "Decoded image exceeds display limits",
          );
          return { ...info, width, height };
        })(),
      );
    return checked.get(bytes);
  }
  async function enlarge(path, opener) {
    const bytes = deps.state.stack.files.get(path);
    assert(bytes, "Image asset no longer exists");
    const info = await validate(bytes),
      dialog = $("image-dialog"),
      area = $("image-viewport");
    assert(!dialog.open, "Close the image viewer first");
    const job = begin(area),
      image = new Image();
    image.alt = path;
    image.draggable = false;
    image.src = urlFor(area, job, bytes, info);
    area.replaceChildren(image);
    $("image-title").textContent = path;
    let scale = 1;
    function zoom(value) {
      scale = Math.max(0.1, Math.min(4, value));
      image.style.width = `${Math.round(info.width * scale)}px`;
      $("image-scale").textContent =
        `${Math.round(scale * 100)}% · ${info.width} × ${info.height}`;
    }
    const fit = () =>
      zoom(
        Math.min(
          1,
          (area.clientWidth - 20) / info.width,
          (area.clientHeight - 20) / info.height,
        ),
      );
    $("image-fit").onclick = fit;
    $("image-actual").onclick = () => zoom(1);
    $("image-in").onclick = () => zoom(scale * 1.25);
    $("image-out").onclick = () => zoom(scale / 1.25);
    for (const [name, left, top] of [
      ["left", -150, 0],
      ["right", 150, 0],
      ["up", 0, -150],
      ["down", 0, 150],
    ])
      $("image-pan-" + name).onclick = () =>
        area.scrollBy({ left, top, behavior: "instant" });
    $("image-download").onclick = () =>
      deps.download(bytes, path.split("/").pop());
    const close = () => {
      dialog.close();
      release(area);
      area.replaceChildren();
      const restored = opener?.isConnected
        ? opener
        : [...document.querySelectorAll("button[data-image-path]")].find(
            (b) => b.dataset.imagePath === path && b.getClientRects().length,
          );
      (restored || $("insert-image")).focus({ preventScroll: true });
    };
    $("image-close").onclick = close;
    dialog.oncancel = (e) => {
      e.preventDefault();
      close();
    };
    dialog.onkeydown = (e) => {
      e.stopPropagation();
      if (
        (e.ctrlKey || e.metaKey) &&
        ["s", "d", "p"].includes(e.key.toLowerCase())
      )
        e.preventDefault();
    };
    dialog.showModal();
    fit();
    $("image-close").focus();
  }
  function openImage(path, button) {
    if (isBusy()) {
      // The existing Asset dialog owns the operation lock until it closes.
      if ($("dialog").open && $("dialog").contains(button))
        enlarge(path, button).catch((e) => deps.notify(e.message, "error"));
      return;
    }
    // Decoding is asynchronous; use the app's operation lock until the inspector is ready.
    deps.run(() => enlarge(path, button));
  }
  async function renderImage(root, job, slot, path, alt, inline = true) {
    try {
      const bytes = deps.state.stack.files.get(path);
      assert(
        bytes && imagePath(path),
        "Local PNG, JPEG or WebP asset not found",
      );
      const info = await validate(bytes);
      if (!current(root, job) || !root.contains(slot)) return;
      const button = el("button", undefined, "local-image"),
        image = new Image();
      button.dataset.imagePath = path;
      button.type = "button";
      button.setAttribute("aria-label", `Enlarge image: ${alt || path}`);
      image.alt = alt || path;
      image.draggable = false;
      image.src = urlFor(root, job, bytes, info);
      await image.decode();
      if (!current(root, job) || !root.contains(slot)) return;
      button.append(image);
      button.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openImage(path, button);
      };
      // Linked images get an image control without nesting interactive elements.
      const outer = slot.closest("a,button");
      if (outer && root.contains(outer)) outer.replaceWith(...outer.childNodes);
      slot.replaceWith(button);
      if (!inline)
        button.append(
          el(
            "small",
            `${info.width} × ${info.height} · Original image · Click to enlarge`,
          ),
        );
    } catch (error) {
      if (current(root, job) && root.contains(slot))
        slot.textContent = `[Image: ${alt || path} — ${error.message}]`;
    }
  }
  async function hydrate(root, from) {
    const job = begin(root);
    let pixels = 0,
      count = 0;
    for (const slot of [...root.querySelectorAll("[data-carbon-image]")]) {
      if (!current(root, job)) return;
      const alt = slot.dataset.imageAlt || "Image",
        path = resolveLocalFile(
          deps.state.stack,
          slot.dataset.carbonImage,
          from,
        );
      if (!path || !imagePath(path)) {
        slot.textContent = `[Image: ${alt} — local asset missing, ambiguous or unsupported]`;
        continue;
      }
      try {
        const info = inspectImage(deps.state.stack.files.get(path));
        if (
          ++count > 12 ||
          pixels + info.width * info.height > 32 * 1024 * 1024
        ) {
          const button = el("button", `Open image: ${alt}`);
          button.onclick = (e) => {
            e.stopPropagation();
            openImage(path, button);
          };
          const outer = slot.closest("a,button");
          if (outer && root.contains(outer))
            outer.replaceWith(...outer.childNodes);
          slot.replaceWith(button);
          continue;
        }
        pixels += info.width * info.height;
        await renderImage(root, job, slot, path, alt);
      } catch (e) {
        slot.textContent = `[Image: ${alt} — ${e.message}]`;
      }
    }
  }
  function renderAsset(root, path) {
    const job = begin(root),
      slot = el("p", "Loading local image…");
    root.append(slot);
    return renderImage(root, job, slot, path, path, false);
  }
  function snapshot(range = null) {
    const view = deps.editor.view;
    assert(
      deps.state.current && !view.composing,
      "Open an Entry and finish composing text before inserting an image",
    );
    return {
      stack: deps.state.stack,
      path: deps.state.current,
      source: view.state.doc.toString(),
      range: range || {
        from: view.state.selection.main.from,
        to: view.state.selection.main.to,
      },
    };
  }
  function insert(files, saved) {
    if (isBusy())
      return deps.notify(
        "Wait for the current operation before inserting images.",
      );
    return deps.run(async () => {
      assert(
        files.length && files.length <= 8,
        "Insert up to 8 PNG, JPEG or WebP images at once",
      );
      const images = [];
      for (const file of files) {
        assert(file.size <= 8 * 1024 * 1024, "Image exceeds 8 MiB");
        const bytes = new Uint8Array(await file.arrayBuffer());
        await validate(bytes);
        images.push(bytes);
      }
      const view = deps.editor.view,
        { state } = deps;
      assert(
        saved.stack === state.stack &&
          saved.path === state.current &&
          saved.source === view.state.doc.toString(),
        "The Entry changed. Insert the image again at the new position.",
      );
      const plan = planImages(
        state.stack,
        state.current,
        saved.source,
        saved.range,
        images,
      );
      const history = new History([...state.history.items]);
      history.push(state.stack, "Before inserting images");
      const drafts = new Map(state.drafts);
      drafts.set(state.current, plan.draft);
      // Persist original assets AND their draft references together before touching CodeMirror.
      try {
        await deps.commit({
          stack: plan.stack,
          drafts,
          history,
          unexported: true,
          copyState: "pending",
          trusted: null,
        });
      } catch (error) {
        // Storage full or changed in another tab: recoverable, so keep the store (it retries) and
        // keep the recovery actions the commit attached.
        if (isQuota(error) || isConflict(error))
          throw Object.assign(new Error(`Image insertion was not saved: ${error.message}`), { actions: error.actions || [] });
        deps.disableCache();
        throw Error(`Image insertion was not saved: ${error.message}. Draft cache disabled. Retry to insert in memory, then export before closing.`);
      }
      view.dispatch({
        changes: plan.changes,
        selection: { anchor: plan.caret },
        userEvent: "input.paste",
        annotations: isolateHistory.of("full"),
      });
      deps.render();
      view.focus();
      deps.notify(
        `${images.length} image${images.length === 1 ? "" : "s"} inserted. Save the Entry before exporting its references.${deps.cacheAvailable() ? "" : " No recovery cache: export before closing this window."}`,
      );
    });
  }
  $("insert-image").onclick = () => {
    if (isBusy()) return;
    try {
      pickerSnapshot = snapshot();
      $("image-files").click();
    } catch (e) {
      deps.notify(e.message, "error");
    }
  };
  $("image-files").onchange = () => {
    const files = [...$("image-files").files];
    $("image-files").value = "";
    if (files.length && pickerSnapshot) insert(files, pickerSnapshot);
    pickerSnapshot = null;
  };
  function handleInput(event, view) {
    const data = event.clipboardData || event.dataTransfer;
    if (!data) return false;
    if (event.type === "dragover") {
      if (![...data.items].some((item) => item.kind === "file")) return false;
      event.preventDefault();
      data.dropEffect = "copy";
      return true;
    }
    const files = [...data.files];
    if (!files.length) return false;
    event.preventDefault();
    try {
      let range = null;
      if (event.type === "drop") {
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
        assert(at !== null, "Drop the image inside the Markdown text");
        range = { from: at, to: at };
      }
      insert(files, snapshot(range));
    } catch (e) {
      deps.notify(e.message, "error");
    }
    return true;
  }
  return { hydrate, renderAsset, release, handleInput, supports: imagePath };
}
