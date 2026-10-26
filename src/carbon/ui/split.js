/**
 * Editor/preview split, VS Code style.
 *
 * - `#toggle-split` (icon in the pane bar) opens or closes the preview beside the editor.
 *   It drives the existing `#view` value (edit ⇄ split), so every other path (Alt+P, the
 *   palette, tests) keeps working and the button just reflects it.
 * - `#toggle-layout` (Document menu / palette) flips the split between side-by-side and
 *   stacked. Narrow editors (<560px, e.g. a phone or a window with the explorer and drawer
 *   open) stack automatically.
 * - `#preview-splitter` resizes the two halves by pointer, touch or keyboard
 *   (arrows ±2%, Home 50%). Ratio and layout are remembered in localStorage.
 *
 * `#view` stays the single source of truth for edit / split / preview.
 */
import { $ } from "./dom.js";

const KEY = "envoy.carbon.split";
const MIN = 20;
const MAX = 80;

/** @returns {{ratio:number, layout:"right"|"below"}} */
function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return {
      ratio: Math.min(MAX, Math.max(MIN, Number(v.ratio) || 50)),
      layout: v.layout === "below" ? "below" : "right",
    };
  } catch {
    return { ratio: 50, layout: "right" };
  }
}

/** Wire the split controls. Called from mountToolbar. */
export function mountSplit() {
  const panes = $("panes"),
    splitter = $("preview-splitter"),
    toggle = $("toggle-split"),
    layoutButton = $("toggle-layout"),
    view = $("view");
  const state = load();
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* Preference storage is optional. */
    }
  };
  /** Side-by-side (vertical bar) when the splitter is taller than wide. */
  const vertical = () => splitter.offsetHeight >= splitter.offsetWidth;
  const apply = () => {
    panes.style.setProperty("--pane-ratio", `${state.ratio}%`);
    panes.dataset.layout = state.layout;
    splitter.setAttribute("aria-valuenow", String(Math.round(state.ratio)));
    const below = state.layout === "below";
    layoutButton.textContent = below ? "Preview on the right" : "Preview below";
    reflect();
  };
  const reflect = () => {
    const mode = view.value;
    toggle.setAttribute("aria-pressed", String(mode === "split"));
    const label = mode === "split" ? "Close preview" : "Open preview to the side";
    toggle.setAttribute("aria-label", label);
    toggle.title = `${label} (Alt+P switches Edit/Preview)`;
    layoutButton.disabled = mode !== "split";
    splitter.dataset.orient = vertical() ? "v" : "h";
    splitter.setAttribute("aria-orientation", vertical() ? "vertical" : "horizontal");
  };
  // editor.js sets #panes.className directly (and calls #view.onchange), so observe it.
  new MutationObserver(reflect).observe(panes, { attributes: true, attributeFilter: ["class"] });
  new ResizeObserver(reflect).observe(panes);
  view.addEventListener("change", reflect);

  toggle.onclick = () => {
    view.value = view.value === "split" ? "edit" : "split";
    view.onchange();
    document.querySelector("#editor .cm-content")?.focus({ preventScroll: true });
  };
  layoutButton.onclick = () => {
    state.layout = state.layout === "below" ? "right" : "below";
    save();
    apply();
  };

  const setRatio = (r) => {
    state.ratio = Math.min(MAX, Math.max(MIN, r));
    splitter.setAttribute("aria-valuenow", String(Math.round(state.ratio)));
    panes.style.setProperty("--pane-ratio", `${state.ratio}%`);
  };
  splitter.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    panes.classList.add("resizing");
    const move = (ev) => {
      const box = panes.getBoundingClientRect();
      setRatio(
        vertical()
          ? ((ev.clientX - box.left) / box.width) * 100
          : ((ev.clientY - box.top) / box.height) * 100,
      );
    };
    const up = () => {
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
      splitter.removeEventListener("pointercancel", up);
      panes.classList.remove("resizing");
      save();
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
    splitter.addEventListener("pointercancel", up);
  });
  splitter.addEventListener("dblclick", () => {
    setRatio(50);
    save();
  });
  splitter.addEventListener("keydown", (e) => {
    const v = vertical();
    const delta =
      { ArrowLeft: v ? -2 : 0, ArrowRight: v ? 2 : 0, ArrowUp: v ? 0 : -2, ArrowDown: v ? 0 : 2 }[e.key];
    if (delta) setRatio(state.ratio + delta);
    else if (e.key === "Home") setRatio(50);
    else return;
    e.preventDefault();
    save();
  });
  // Phones start in Edit (full height); the split button opens the preview.
  if (matchMedia("(max-width: 600px)").matches && view.value === "split") {
    view.value = "edit";
    view.onchange();
  }
  apply();
}
