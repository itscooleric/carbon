/**
 * Docked Dispatch drawer: five wizard steps for a draft (Assignment · Context · Playbooks ·
 * Deliverables · Review & export) and a status body for every later state. All domain
 * behavior comes from the dispatch controller in `deps.dispatch`; this module only renders
 * the draft, forwards edits through `updateDraft` and calls `export`.
 * Ids used: #drawer (hidden when closed), #drawer-title, #drawer-chip, #drawer-sub,
 * #drawer-steps (buttons with aria-current="step"), #drawer-body, #drawer-foot,
 * #drawer-back, #drawer-skip, #drawer-next, #drawer-close, #drawer-discard,
 * #draft-objective, #draft-mission, #draft-criteria, #draft-create, #draft-consent,
 * #playbook-file (hidden file input), #workspace (class with-drawer).
 *
 * Trust: Entry paths, bodies and imported Playbook text are untrusted and rendered as
 * text (`el`, textContent). The Cast preview is shown in a <pre> as text.
 */
import { entry } from "../../core/entries.js";
import { $, el } from "./dom.js";
import { statusChip, formatBytes, renderDispatches } from "./sidebar.js";
import { isLocalFolder } from "../local-files.js";

/** @typedef {import("../types.js").Deps} Deps */

export const STEPS = [
  "Assignment",
  "Context",
  "Playbooks",
  "Deliverables",
  "Review & export",
];
const PRESETS = [
  ["question", "Ask a question", "Answer in the Return. No file changes."],
  ["plan", "Update a plan", "Replace the selected plan body."],
  ["report", "Write a report", "New report Entry + plan update."],
  ["custom", "Custom", "Choose everything yourself."],
];
const PRESET_PLAYBOOKS = {
  question: ["Research"],
  plan: ["Planning"],
  report: ["Research", "Report generation"],
  custom: [],
};
const TARGETS = [
  ["text", "Text only (paste)", "One dispatch.md. No binary files."],
  ["files", "Files / attachments", "dispatch.md + selected Asset files."],
  ["tar", "TAR-capable", ".dispatch.tar package, or .stack.tar + dispatch.md for the complete Stack."],
];
const MAX_PLAYBOOKS = 8;
const MAX_PLAYBOOK_BYTES = 16384;
const MAX_PLAYBOOK_CHARS = 16000;
const CAST_BUDGET = 65536;
const VIA_WORDS = {
  copy: "copied to the clipboard",
  "download-md": "downloaded as dispatch.md",
  "download-files": "downloaded as files",
  "download-tar": "downloaded as a TAR package",
};

const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const bytes = (s) => new TextEncoder().encode(s).length;

/**
 * Mount the drawer. Returns the view handle used by the composition root.
 * @param {Deps} deps
 * @returns {{open: (id: string) => void, create: (opts?: object) => void, close: (keep?: boolean) => void,
 *   render: () => void, isOpen: () => boolean, activeId: () => string|null}}
 */
export function mountDispatchWizard(deps) {
  const { state, dispatch, notify, confirm, run } = deps;
  /** View-only state: open record, Playbook preview, last rename targets. */
  const ui = { id: null, pbPreview: null };
  // An ordinary copy has no Dispatch: render nothing for a record retained from an earlier Stack.
  const record = () => (ui.id && !isLocalFolder(state.stack) ? dispatch.find(ui.id) : null);
  const isDraft = (r) => r && r.status === "draft";
  const entries = () => [...state.stack.files.keys()].filter((p) => /\.md$/i.test(p)).sort();
  const assets = () =>
    [...state.stack.files.keys()].filter((p) => !/\.md$/i.test(p) && p !== "stack.yaml").sort();
  const size = (p) => formatBytes(state.stack.files.get(p)?.length || 0);
  const playbooks = () => (deps.castkitAssets && deps.castkitAssets.playbooks) || {};
  const titleOf = (p) => {
    try {
      const t = entry(state.stack.text(p)).data.title;
      return typeof t === "string" && t.trim() ? t.trim() : p;
    } catch {
      return p;
    }
  };

  // ---- small builders ---------------------------------------------------------------
  const btn = (text, onClick, cls = "") => {
    const b = el("button", text, cls);
    b.type = "button";
    b.onclick = onClick;
    return b;
  };
  const check = (content, checked, onChange, { disabled = false, type = "checkbox", name } = {}) => {
    const label = el("label", undefined, "check"),
      input = el("input");
    input.type = type;
    if (name) input.name = name;
    input.checked = checked;
    input.disabled = disabled;
    input.onchange = () => onChange(input.checked, input);
    const span = el("span");
    span.append(...(Array.isArray(content) ? content : [content]));
    label.append(input, span);
    return label;
  };
  const callout = (glyph, nodes, cls = "") => {
    const c = el("div", undefined, `callout ${cls}`),
      g = el("span", glyph, "g");
    g.setAttribute("aria-hidden", "true");
    const body = el("span");
    body.append(...(Array.isArray(nodes) ? nodes : [nodes]));
    c.append(g, body);
    return c;
  };
  const field = (label, control, hint, forId) => {
    const f = el("div", undefined, "field");
    const l = el(forId ? "label" : "span", label, "flabel");
    if (forId) l.htmlFor = forId;
    f.append(l, control);
    if (hint) f.append(typeof hint === "string" ? el("span", hint, "hint") : hint);
    return f;
  };
  const code = (text) => el("code", text);
  const small = (text) => el("small", text);

  /** Controller reads that must never break rendering: fall back to empty results. */
  const safeIssues = (id) => {
    try {
      return dispatch.issues(id);
    } catch (e) {
      return [{ step: 0, text: e.message }];
    }
  };
  const safePreview = (id) => {
    try {
      return dispatch.preview(id);
    } catch (e) {
      return {
        castSource: `# preview unavailable: ${e.message}`,
        included: [],
        omitted: [],
        sizes: { castBytes: 0, textBytes: 0, assetBytes: 0 },
      };
    }
  };

  /** Forward a draft patch to the controller and re-render the drawer and cards. */
  function update(patch, { rerender = true } = {}) {
    const r = record();
    if (!isDraft(r)) return;
    try {
      dispatch.updateDraft(r.assignmentId, patch);
    } catch (e) {
      notify(e.message, "error");
    }
    if (rerender) render();
    renderDispatches(deps);
  }

  function findPlaybook(name) {
    const all = playbooks(),
      want = normalize(name);
    const key =
      Object.keys(all).find((k) => normalize(k) === want) ||
      Object.keys(all).find((k) => normalize(k).startsWith(want) || want.startsWith(normalize(k)));
    return key ? { name: key, source: "built-in", content: all[key] } : null;
  }

  function uniqueName(name, r) {
    let n = name,
      i = 2;
    while (r.draft.playbooks.some((p) => p.name === n)) n = `${name} (${i++})`;
    return n;
  }

  function uniquePath(base) {
    if (!state.stack.files.has(base)) return base;
    let i = 2;
    while (state.stack.files.has(base.replace(/\.md$/i, `-${i}.md`))) i++;
    return base.replace(/\.md$/i, `-${i}.md`);
  }

  /** Presets only pre-fill: re-seed Playbooks and permissions once when applied. */
  function applyPreset(r, key) {
    const d = r.draft;
    const pbs = PRESET_PLAYBOOKS[key].map(findPlaybook).filter(Boolean);
    const plan =
      d.context.find((p) => /plan/i.test(p)) ||
      (state.current && d.context.includes(state.current) ? state.current : null);
    const permissions = {
      create: key === "report" ? [uniquePath("entries/report.md")] : [],
      replace: ["plan", "report"].includes(key) && plan ? [plan] : [],
      metadata: [],
      delete: [],
      rename: [],
    };
    update({ preset: key, playbooks: pbs, permissions });
  }

  // ---- open / close -------------------------------------------------------------------
  function render() {
    const drawer = $("drawer"),
      r = record();
    if (!r) {
      drawer.hidden = true;
      $("workspace").classList.remove("with-drawer");
      return;
    }
    drawer.hidden = false;
    $("workspace").classList.add("with-drawer");
    $("drawer-title").textContent = `Dispatch ${r.seq}`;
    $("drawer-chip").replaceChildren(
      statusChip(r.status, r.status === "accepted" && r.acceptedRevision != null ? ` → rev ${r.acceptedRevision}` : ""),
    );
    const base = isDraft(r) ? state.stack.manifest.revision : r.baseRevision;
    const sub = $("drawer-sub");
    sub.replaceChildren();
    const s1 = el("span", "Stack ");
    s1.append(el("b", state.stack.manifest.title || state.stack.manifest.id), " · base revision ", el("b", String(base)));
    sub.append(s1, el("span", r.draft.mission ? `Mission: ${r.draft.mission}` : "No Mission (one-off)"));
    if (isDraft(r)) {
      renderSteps(r);
      $("drawer-steps").hidden = false;
      $("drawer-foot").hidden = false;
      const body = [stepAssignment, stepContext, stepPlaybooks, stepDeliverables, stepReview][r.draft.step](r);
      $("drawer-body").replaceChildren(body);
      renderFoot(r);
    } else {
      $("drawer-steps").hidden = true;
      $("drawer-foot").hidden = true;
      $("drawer-body").replaceChildren(statusBody(r));
    }
  }

  function renderSteps(r) {
    const nav = $("drawer-steps");
    nav.replaceChildren();
    const issues = safeIssues(r.assignmentId);
    STEPS.forEach((name, i) => {
      const b = el("button", undefined);
      b.type = "button";
      const n = el("span", undefined, "n");
      const hasIssue = issues.some((x) => x.step === i);
      const done = i < r.draft.step && !hasIssue;
      n.append(el("span", done ? "✓" : String(i + 1)));
      b.append(n, name);
      if (done) b.classList.add("done");
      if (hasIssue && i !== r.draft.step) b.classList.add("issue");
      if (i === r.draft.step) b.setAttribute("aria-current", "step");
      b.setAttribute("aria-label", `Step ${i + 1} of ${STEPS.length}: ${name}${hasIssue ? " (needs attention)" : done ? " (complete)" : ""}`);
      b.onclick = () => goto(i, true);
      b.onkeydown = (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const buttons = [...nav.querySelectorAll("button")];
          const next = buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
          next.focus();
        }
      };
      nav.append(b);
    });
  }

  function renderFoot(r) {
    const step = r.draft.step;
    $("drawer-back").disabled = step === 0;
    $("drawer-skip").hidden = step > 2;
    $("drawer-next").hidden = step === 4;
    $("drawer-next").textContent = step < 4 ? `Next: ${STEPS[step + 1]} →` : "";
  }

  function goto(step, focusStep = false) {
    const r = record();
    if (!isDraft(r)) return;
    update({ step: Math.max(0, Math.min(4, step)) });
    $("drawer-body").scrollTo(0, 0);
    if (focusStep) document.querySelector("#drawer-steps [aria-current=step]")?.focus();
    else if (step === 0) $("draft-objective")?.focus();
  }

  function open(id) {
    ui.id = id;
    ui.pbPreview = null;
    render();
    renderDispatches(deps);
    const r = record();
    setTimeout(() => {
      if (isDraft(r) && r.draft.step === 0) $("draft-objective")?.focus();
      else (document.querySelector("#drawer-steps [aria-current=step]") || $("drawer-close"))?.focus();
    }, 0);
  }

  /** Start a draft from the toolbar, the editor or the empty state and open it. */
  function create(opts = {}) {
    const current = record();
    if (!Object.keys(opts).length && isDraft(current) && !$("drawer").hidden) {
      $("draft-objective")?.focus();
      return;
    }
    const preset = opts.preset || "question";
    let r;
    try {
      r = dispatch.startDraft({
        seedContext: opts.seedContext ?? [...state.selected],
        openPath: opts.openPath ?? state.current,
        preset,
      });
    } catch (e) {
      notify(e.message, "error");
      return;
    }
    ui.id = r.assignmentId;
    applyPreset(r, preset);
    open(r.assignmentId);
  }

  function close(keep = true) {
    // Fields that save on `change` (criteria, create path, rename targets) commit on blur.
    // Blur the focused drawer field while the record is still open so Esc keeps the value.
    const active = document.activeElement;
    if (active && active !== document.body && $("drawer").contains(active)) active.blur();
    const r = record();
    ui.id = null;
    render();
    renderDispatches(deps);
    if (keep && isDraft(r))
      notify(`Draft Dispatch ${r.seq} kept in Dispatches. Nothing was exported.`);
    else if (keep && r) notify("Dispatch panel closed.");
    $("dispatch").focus();
  }

  // ---- step 1: Assignment ---------------------------------------------------------------
  function stepAssignment(r) {
    const d = r.draft,
      frag = document.createDocumentFragment();
    const presets = el("div", undefined, "presets");
    presets.setAttribute("role", "radiogroup");
    presets.setAttribute("aria-label", "What kind of work?");
    for (const [key, label, hint] of PRESETS) {
      const l = el("label", undefined, "preset"),
        input = el("input");
      input.type = "radio";
      input.name = "preset";
      input.value = key;
      input.checked = d.preset === key;
      input.onchange = () => applyPreset(r, key);
      const span = el("span", label);
      span.append(small(hint));
      l.append(input, span);
      presets.append(l);
    }
    frag.append(field("What kind of work?", presets));
    const objective = el("textarea");
    objective.id = "draft-objective";
    objective.rows = 6;
    objective.placeholder =
      "Describe the task or question in your own words. e.g. Compare tool-calling support in Vendor A and B and update the plan.";
    objective.value = d.objective;
    objective.oninput = () => {
      update({ objective: objective.value }, { rerender: false });
      renderSteps(r);
    };
    frag.append(
      field("Assignment", objective, "Free-form. This text is the primary instruction and outranks Playbooks.", "draft-objective"),
    );
    const mission = el("select", undefined, "field-select");
    mission.id = "draft-mission";
    const none = el("option", "None — one-off assignment");
    none.value = "";
    mission.append(none);
    const candidates = dispatch.missionCandidates
      ? dispatch.missionCandidates(state.stack)
      : entries().filter((p) => {
          try {
            return entry(state.stack.text(p)).data.kind === "mission";
          } catch {
            return false;
          }
        });
    for (const p of candidates) {
      const o = el("option", `${titleOf(p)} · ${p}`);
      o.value = p;
      mission.append(o);
    }
    mission.value = d.mission && candidates.includes(d.mission) ? d.mission : "";
    mission.onchange = () => {
      const m = mission.value || null;
      const context = m && !d.context.includes(m) ? [...d.context, m] : d.context;
      update({ mission: m, context });
      $("draft-mission")?.focus();
    };
    frag.append(
      field(
        "Mission (optional)",
        mission,
        d.mission
          ? "The Mission Entry is added to context and the Return receipt can be linked to it."
          : "Without a Mission the Return is reviewed on its own. You can link it later.",
        "draft-mission",
      ),
    );
    const details = el("details", undefined, "adv");
    details.open = d.criteria.length > 0;
    details.append(el("summary", "Completion criteria (optional)"));
    const wrap = el("div");
    const criteria = el("textarea");
    criteria.id = "draft-criteria";
    criteria.rows = 3;
    criteria.placeholder = "One per line. e.g. Every claim cites a source ID.";
    criteria.value = d.criteria.join("\n");
    criteria.setAttribute("aria-label", "Completion criteria, one per line");
    criteria.onchange = () =>
      update({ criteria: criteria.value.split("\n").map((s) => s.trim()).filter(Boolean) }, { rerender: false });
    wrap.append(criteria);
    details.append(wrap);
    frag.append(details);
    const b = el("b", "Quick path:");
    frag.append(
      callout("⇥", [
        b,
        ` for a simple question, write the assignment and choose Skip to review. Context defaults to ${
          d.context.length ? `${d.context.length} checked ${d.context.length === 1 ? "Entry" : "Entries"}` : "nothing (assignment only)"
        }; the answer comes back in the Return summary.`,
      ]),
    );
    return frag;
  }

  // ---- step 2: Context ------------------------------------------------------------------
  function stepContext(r) {
    const d = r.draft,
      frag = document.createDocumentFragment(),
      all = entries(),
      complete = d.scope === "complete";
    const strip = (p, patch = {}) => {
      const perms = d.permissions;
      return {
        context: d.context.filter((x) => x !== p),
        mission: d.mission === p ? null : d.mission,
        permissions: {
          ...perms,
          replace: perms.replace.filter((x) => x !== p),
          delete: perms.delete.filter((x) => x !== p),
          metadata: perms.metadata.filter((m) => m.path !== p),
          rename: perms.rename.filter(([from]) => from !== p),
        },
        ...patch,
      };
    };
    frag.append(
      complete
        ? callout("▣", [el("b", "Complete Stack: every Entry and Asset."), " Exported as the complete .stack.tar plus dispatch.md, which carries the Cast. Use only when the destination must see the whole Stack."], "scope")
        : callout("◧", [el("b", "Selected context only — omitted files stay in your Stack."), " The AI sees the files checked below, not the complete Stack. Omitted files are listed in the packet as omitted."], "scope"),
    );
    if (!all.length)
      frag.append(callout("○", "This Stack has no Entries. The AI receives only the assignment and Playbooks."));
    else {
      const list = el("ul", undefined, "ctx");
      const head = el("li", undefined, "head");
      const included = complete ? all.length : d.context.filter((p) => all.includes(p)).length;
      head.append(el("span", `Entries · ${included} of ${all.length}`));
      const bulk = el("span", undefined, "row");
      bulk.append(
        btn("All", () => update({ context: all }), "sm"),
        btn("Open Entry", () => update({ context: state.current ? [state.current] : [], mission: d.mission && d.mission === state.current ? d.mission : null }), "sm"),
        btn("None", () => update({ context: [], mission: null, permissions: { create: d.permissions.create, replace: [], metadata: [], delete: [], rename: [] } }), "sm"),
      );
      for (const b of bulk.children) b.disabled = complete;
      head.append(bulk);
      list.append(head);
      for (const p of all) {
        const on = complete || d.context.includes(p),
          dirty = state.drafts.has(p);
        const li = el("li", undefined, on ? "" : "off");
        const input = el("input");
        input.type = "checkbox";
        input.id = `ctx-${p}`;
        input.checked = on;
        input.disabled = complete;
        input.setAttribute("aria-label", `Include ${p} in this Dispatch`);
        input.onchange = () =>
          update(input.checked ? { context: [...d.context, p] } : strip(p));
        const label = el("label", undefined, "path");
        label.htmlFor = input.id;
        label.append(p);
        if (p === d.mission) label.append(" ", el("span", "MISSION", "tag"));
        if (p === state.current) label.append(" ", el("span", "OPEN", "tag"));
        li.append(input, label, el("span", size(p), "sz"));
        if (dirty && on) {
          const sub = el("div", undefined, "sub");
          const acts = el("span", undefined, "acts");
          acts.append(
            btn("Save Entry now", () => run(async () => {
              await deps.saveEntry(p);
              render();
            }), "sm"),
            btn("Send saved version", () =>
              run(async () => {
                const ok = await confirm(
                  "Send the saved version?",
                  [
                    `${p} has unsaved edits in the editor. The Cast carries the saved revision; the unsaved edits are discarded from the editor.`,
                    "Choose Save Entry now instead to send your edits.",
                  ],
                  "Discard edits and send saved version",
                );
                if (!ok) return;
                state.drafts.delete(p);
                await deps.persist();
                deps.render();
              }), "sm"),
          );
          sub.append(callout("●", ["Unsaved edits in the editor. Drafts are never sent silently.", el("br"), acts], "warn"));
          li.append(sub);
        }
        list.append(li);
      }
      frag.append(list);
      if (!included && !complete)
        frag.append(callout("○", "No Entries selected. The AI receives only the assignment and Playbooks — fine for a general question."));
    }
    const as = assets();
    if (as.length) {
      const list = el("ul", undefined, "ctx");
      const head = el("li", undefined, "head");
      head.append(el("span", "Assets (optional)"));
      list.append(head);
      for (const p of as) {
        const on = complete || d.assets.includes(p);
        const li = el("li", undefined, on ? "" : "off");
        const input = el("input");
        input.type = "checkbox";
        input.id = `asset-${p}`;
        input.checked = on;
        input.disabled = complete;
        input.setAttribute("aria-label", `Include Asset ${p}`);
        input.onchange = () =>
          update(
            input.checked
              ? { assets: [...d.assets, p], target: d.target === "text" ? "files" : d.target }
              : { assets: d.assets.filter((x) => x !== p) },
          );
        const label = el("label", undefined, "path");
        label.htmlFor = input.id;
        label.append(p, " ", el("span", "BINARY", "tag"));
        li.append(input, label, el("span", size(p), "sz"));
        li.append(el("div", "Only carried by file or TAR exports. A text-only paste lists it as omitted.", "sub"));
        list.append(li);
      }
      frag.append(list);
    }
    const pv = safePreview(r.assignmentId);
    const inventory = el("div", undefined, "inventory");
    const box = (title, items, empty) => {
      const b = el("div", undefined, "inv");
      b.append(el("b", `${title} · ${items.length}`));
      if (items.length) {
        const ul = el("ul");
        for (const p of items) ul.append(el("li", p));
        b.append(ul);
      } else b.append(el("span", empty, "muted"));
      return b;
    };
    inventory.append(box("Included", pv.included, "Assignment only"), box("Omitted", pv.omitted, "Nothing"));
    frag.append(inventory);
    const details = el("details", undefined, "adv");
    details.open = complete;
    details.append(el("summary", "Advanced: export the complete Stack instead"));
    const wrap = el("div");
    wrap.append(
      check(["Selected context ", small("envoy.dispatch/v0.1, complete_stack: false. Default.")], !complete, () => update({ scope: "selected" }), { type: "radio", name: "scope" }),
      check(["Complete Stack archive ", small("The complete .stack.tar plus dispatch.md (with the Cast). Requires a TAR-capable destination.")], complete, () => update({ scope: "complete", target: "tar" }), { type: "radio", name: "scope" }),
    );
    details.append(wrap);
    frag.append(details);
    return frag;
  }

  // ---- step 3: Playbooks ----------------------------------------------------------------
  function addPlaybook(r, pb) {
    if (r.draft.playbooks.length >= MAX_PLAYBOOKS) return notify(`At most ${MAX_PLAYBOOKS} Playbooks.`, "error");
    if (bytes(pb.content) > MAX_PLAYBOOK_BYTES || pb.content.length > MAX_PLAYBOOK_CHARS)
      return notify(`${pb.name} is ${formatBytes(bytes(pb.content))}; Playbooks are limited to 16 KiB.`, "error");
    const named = { ...pb, name: uniqueName(pb.name, r) };
    ui.pbPreview = named.name;
    update({ playbooks: [...r.draft.playbooks, named] });
  }

  function stepPlaybooks(r) {
    const d = r.draft,
      frag = document.createDocumentFragment();
    frag.append(
      callout("ℹ", "Playbooks are optional Markdown instructions that guide method and presentation. They grant no paths, tools or permissions. They are copied into the Cast now; later edits do not change this Dispatch.", "info"),
    );
    const selected = el("div", undefined, "pbbox");
    if (!d.playbooks.length) {
      const row = el("div", undefined, "pb");
      row.append(el("span"), el("span", "None. The assignment and safety contract still apply.", "muted"), el("span"));
      selected.append(row);
    }
    d.playbooks.forEach((p, i) => {
      const row = el("div", undefined, "pb sel");
      const ord = el("span", String(i + 1), "ord");
      ord.setAttribute("aria-label", `Order ${i + 1}`);
      const cell = el("span");
      const name = btn(p.name, () => {
        ui.pbPreview = p.name;
        render();
      }, "quiet sm pbname");
      cell.append(name, " ", el("span", `${p.source} · ${formatBytes(bytes(p.content))}`, "src"));
      const ctl = el("span", undefined, "ctl");
      const move = (delta) => {
        const list = [...d.playbooks];
        [list[i], list[i + delta]] = [list[i + delta], list[i]];
        update({ playbooks: list });
        $("drawer-body").querySelectorAll(delta < 0 ? ".pb-up" : ".pb-down")[i + delta]?.focus();
      };
      const up = btn("↑", () => move(-1), "sm pb-up"),
        down = btn("↓", () => move(1), "sm pb-down"),
        remove = btn("✕", () => update({ playbooks: d.playbooks.filter((_, k) => k !== i) }), "sm");
      up.disabled = i === 0;
      down.disabled = i === d.playbooks.length - 1;
      up.setAttribute("aria-label", `Move ${p.name} up`);
      down.setAttribute("aria-label", `Move ${p.name} down`);
      remove.setAttribute("aria-label", `Remove ${p.name}`);
      ctl.append(up, down, remove);
      const first = el("span");
      first.append(ord);
      row.append(first, cell, ctl);
      selected.append(row);
    });
    frag.append(field(`Selected, in processing order · ${d.playbooks.length} of ${MAX_PLAYBOOKS}`, selected));
    const avail = el("div", undefined, "pbbox");
    const names = Object.keys(playbooks()).filter((n) => !d.playbooks.some((p) => p.name === n && p.source === "built-in"));
    if (!names.length) {
      const row = el("div", undefined, "pb");
      row.append(el("span"), el("span", "All built-ins selected.", "muted"), el("span"));
      avail.append(row);
    }
    for (const n of names) {
      const row = el("div", undefined, "pb");
      const cell = el("span");
      cell.append(btn(n, () => {
        ui.pbPreview = n;
        render();
      }, "quiet sm pbname"), " ", el("span", "built-in", "src"));
      const add = btn("+ Add", () => addPlaybook(r, { name: n, source: "built-in", content: playbooks()[n] }), "sm");
      add.disabled = d.playbooks.length >= MAX_PLAYBOOKS;
      const ctl = el("span", undefined, "ctl");
      ctl.append(add);
      row.append(el("span"), cell, ctl);
      avail.append(row);
    }
    const availField = field("Available", avail);
    const tools = el("div", undefined, "row");
    const importBtn = btn("Import Markdown Playbook…", () => $("playbook-file").click());
    importBtn.disabled = d.playbooks.length >= MAX_PLAYBOOKS;
    const fromEntry = el("select");
    fromEntry.setAttribute("aria-label", "Use a Stack Entry as a Playbook");
    const first = el("option", "Use a Stack Entry as Playbook…");
    first.value = "";
    fromEntry.append(first);
    for (const p of entries()) {
      const o = el("option", p);
      o.value = p;
      fromEntry.append(o);
    }
    fromEntry.disabled = d.playbooks.length >= MAX_PLAYBOOKS;
    fromEntry.onchange = () => {
      const p = fromEntry.value;
      if (!p) return;
      addPlaybook(r, { name: titleOf(p), source: `stack: ${p}`, content: state.drafts.get(p) ?? state.stack.text(p) });
    };
    tools.append(importBtn, fromEntry);
    availField.append(tools, el("span", "Limit 16 KiB each. Imported files are shown in full before use; nested “include” references are not followed.", "hint"));
    frag.append(availField);
    const previewName = ui.pbPreview || d.playbooks[0]?.name;
    const pb = d.playbooks.find((p) => p.name === previewName) || (playbooks()[previewName] ? { name: previewName, content: playbooks()[previewName] } : null);
    if (pb) {
      const pre = el("pre", pb.content, "pbprev");
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", `Playbook preview: ${pb.name}`);
      frag.append(field(`Preview · ${pb.name}`, pre));
    }
    return frag;
  }

  // ---- step 4: Deliverables -------------------------------------------------------------
  function scalarKeys(p) {
    try {
      const data = entry(state.stack.text(p)).data;
      return Object.keys(data).filter((k) => k !== "id" && ["string", "number", "boolean"].includes(typeof data[k]));
    } catch {
      return [];
    }
  }

  function stepDeliverables(r) {
    const d = r.draft,
      perms = d.permissions,
      frag = document.createDocumentFragment();
    const setPerms = (patch) => update({ permissions: { ...perms, ...patch } });
    const what = el("div", undefined, "field");
    what.append(el("span", "What should come back?", "flabel"));
    what.append(check(["Answer and evidence in the Return summary", small("Always included. A conversational answer needs nothing else.")], true, () => {}, { disabled: true }));
    what.append(
      check(["New report Entry", small("Complete Markdown file with a new unique ID.")], perms.create.length > 0, (on) =>
        setPerms({ create: on ? [uniquePath("entries/report.md")] : [] }),
      ),
    );
    if (perms.create.length) {
      const wrap = el("div", undefined, "field indent");
      const input = el("input");
      input.type = "text";
      input.id = "draft-create";
      input.value = perms.create[0];
      const hint = el("span", undefined, "hint");
      const refresh = () => {
        const p = input.value.trim();
        hint.replaceChildren();
        if (!p) hint.append("Enter a path ending in .md.");
        else if (state.stack.files.has(p)) hint.append("⚠ Already exists — choose another path.");
        else {
          hint.append("→ ", code(p), " · new · no existing Entry at this path");
        }
      };
      refresh();
      input.oninput = refresh;
      input.onchange = () => setPerms({ create: input.value.trim() ? [input.value.trim()] : [] });
      const l = el("label", "Exact path", "small");
      l.htmlFor = input.id;
      wrap.append(l, input, hint);
      what.append(wrap);
    }
    frag.append(what);
    const replace = el("div", undefined, "field");
    replace.append(el("span", "Entries the AI may revise (replace body)", "flabel"));
    const ctx = d.context.filter((p) => state.stack.files.has(p));
    if (!ctx.length) replace.append(el("p", "No Entries in context. Only new files can be proposed.", "hint"));
    for (const p of ctx)
      replace.append(
        check([code(p), small("Keeps its ID and frontmatter unless a field is allowed below.")], perms.replace.includes(p), (on) =>
          setPerms({
            replace: on ? [...perms.replace, p] : perms.replace.filter((x) => x !== p),
            metadata: on ? perms.metadata : perms.metadata.filter((m) => m.path !== p),
          }),
        ),
      );
    frag.append(replace);
    const advanced = perms.metadata.reduce((n, m) => n + m.keys.length, 0) + perms.delete.length + perms.rename.length;
    const details = el("details", undefined, "adv");
    details.open = advanced > 0;
    details.append(el("summary", `Advanced permissions · ${advanced ? `${advanced} on` : "all off"}`));
    const wrap = el("div");
    wrap.append(el("span", "Metadata (existing scalar fields only)", "flabel"));
    if (!perms.replace.length) wrap.append(el("p", "Allow a replacement first.", "hint"));
    for (const p of perms.replace) {
      const keys = scalarKeys(p);
      if (!keys.length) wrap.append(el("p", `${p} has no scalar frontmatter fields.`, "hint"));
      for (const k of keys) {
        const entryKeys = perms.metadata.find((m) => m.path === p)?.keys || [];
        wrap.append(
          check([code(p), " · ", code(k)], entryKeys.includes(k), (on) => {
            const keep = perms.metadata.filter((m) => m.path !== p);
            const next = on ? [...entryKeys, k] : entryKeys.filter((x) => x !== k);
            setPerms({ metadata: next.length ? [...keep, { path: p, keys: next }] : keep });
          }),
        );
      }
    }
    wrap.append(el("p", "IDs, nested fields and adding or removing fields cannot be changed.", "hint"));
    wrap.append(el("span", "Deletions", "flabel"));
    if (!ctx.length) wrap.append(el("p", "—", "hint"));
    for (const p of ctx)
      wrap.append(
        check(["May delete ", code(p)], perms.delete.includes(p), (on) =>
          setPerms({ delete: on ? [...perms.delete, p] : perms.delete.filter((x) => x !== p) }),
        ),
      );
    wrap.append(el("span", "Renames", "flabel"));
    if (!ctx.length) wrap.append(el("p", "—", "hint"));
    for (const p of ctx) {
      const pair = perms.rename.find(([from]) => from === p);
      const row = el("div", undefined, "rename-row");
      row.append(
        check(["May rename ", code(p)], !!pair, (on) =>
          setPerms({
            rename: on ? [...perms.rename, [p, p.replace(/\.md$/i, "-renamed.md")]] : perms.rename.filter(([from]) => from !== p),
          }),
        ),
      );
      if (pair) {
        const to = el("input");
        to.type = "text";
        to.value = pair[1];
        to.setAttribute("aria-label", `New path for ${p}`);
        to.onchange = () =>
          setPerms({ rename: perms.rename.map(([from, t]) => (from === p ? [from, to.value.trim() || t] : [from, t])) });
        const arrow = el("span", "→ ", "muted");
        row.append(arrow, to);
      }
      wrap.append(row);
    }
    wrap.append(el("span", "Tools, network, execution", "flabel"));
    wrap.append(check(["Not available ", small("Not available — Carbon has no tool runtime. A destination's own tools are outside this Cast.")], false, () => {}, { disabled: true }));
    details.append(wrap);
    frag.append(details);
    const count = perms.create.length + perms.replace.length + advanced;
    frag.append(el("p", `${count} file permission${count === 1 ? "" : "s"}. A Return cannot widen these.`, "hint"));
    return frag;
  }

  // ---- step 5: Review & export ----------------------------------------------------------
  function stepReview(r) {
    const d = r.draft,
      frag = document.createDocumentFragment(),
      issues = safeIssues(r.assignmentId),
      pv = safePreview(r.assignmentId),
      complete = d.scope === "complete";
    const seg = el("div", undefined, "seg");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "What can the destination AI actually accept?");
    for (const [key, label, hint] of TARGETS) {
      const l = el("label"),
        input = el("input");
      input.type = "radio";
      input.name = "target";
      input.value = key;
      input.checked = d.target === key;
      // Complete scope is only exportable as the TAR (.stack.tar + dispatch.md).
      input.disabled = complete && key !== "tar";
      input.onchange = () => update({ target: key });
      const span = el("span", label);
      span.append(small(hint));
      l.append(input, span);
      seg.append(l);
    }
    frag.append(field("What can the destination AI actually accept?", seg, "Choose by what you have observed in that session, not by provider name."));
    if (issues.length) {
      const box = el("div", undefined, "err");
      box.setAttribute("role", "alert");
      box.append(el("b", "Resolve before export"));
      for (const issue of issues) {
        const line = el("div", `• ${issue.text} `);
        line.append(btn(issue.fix || `Go to ${STEPS[issue.step]}`, () => goto(issue.step), "sm fix"));
        if (issue.step === 4 && d.assets.length) line.append(" ", btn("Remove Assets", () => update({ assets: [] }), "sm"));
        box.append(line);
      }
      frag.append(box);
    }
    const dl = el("dl", undefined, "summary");
    const rowOf = (term, value) => {
      dl.append(el("dt", term));
      const dd = el("dd");
      dd.append(...(Array.isArray(value) ? value : [value]));
      dl.append(dd);
      return dd;
    };
    rowOf("Assignment", d.objective.trim() || el("span", "—", "muted"));
    rowOf("Mission", d.mission || "None (one-off)");
    rowOf("Base", `${state.stack.manifest.title || state.stack.manifest.id} · revision ${state.stack.manifest.revision}`);
    const nEntries = complete ? entries().length : d.context.length,
      nAssets = complete ? assets().length : d.assets.length;
    rowOf("Scope", complete ? "▣ Complete Stack archive" : `◧ Selected context · ${nEntries} ${nEntries === 1 ? "Entry" : "Entries"}${nAssets ? ` + ${nAssets} Asset${nAssets === 1 ? "" : "s"}` : ""} · ${pv.omitted.length} omitted`);
    if (d.playbooks.length) {
      const ol = el("ol");
      for (const p of d.playbooks) {
        const li = el("li", p.name + " ");
        li.append(el("span", p.source, "muted small"));
        ol.append(li);
      }
      rowOf("Playbooks", ol);
    } else rowOf("Playbooks", "None");
    rowOf("May create", d.permissions.create.length ? d.permissions.create.map(code) : "Nothing");
    rowOf("May replace", d.permissions.replace.length ? d.permissions.replace.flatMap((p, i) => (i ? [", ", code(p)] : [code(p)])) : "Nothing");
    const adv = [
      d.permissions.metadata.length && `metadata: ${d.permissions.metadata.map((m) => `${m.path}#${m.keys.join(",")}`).join(", ")}`,
      d.permissions.delete.length && `delete: ${d.permissions.delete.length}`,
      d.permissions.rename.length && `rename: ${d.permissions.rename.length}`,
    ].filter(Boolean);
    rowOf("Advanced", adv.length ? adv.join(" · ") : "All off");
    const sizeDd = rowOf(
      "Size",
      `${d.target === "tar" ? (complete ? "stack.tar + dispatch.md" : "dispatch.tar") : "dispatch.md"} ≈ ${formatBytes(pv.sizes.castBytes + pv.sizes.textBytes + (d.target !== "text" ? pv.sizes.assetBytes : 0))}${pv.sizes.assetBytes && d.target === "text" ? ` · ${formatBytes(pv.sizes.assetBytes)} binary not carried` : ""}`,
    );
    const meter = el("div", undefined, "meter");
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", "Cast metadata used");
    const pct = Math.min(100, Math.round((pv.sizes.castBytes / CAST_BUDGET) * 100));
    meter.setAttribute("aria-valuenow", String(pct));
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    const bar = el("i");
    bar.style.width = `${pct}%`;
    meter.append(bar);
    sizeDd.append(meter, el("span", `Cast metadata ${formatBytes(pv.sizes.castBytes)} of 64 KiB · context text ${formatBytes(pv.sizes.textBytes)}`, "hint"));
    frag.append(dl);
    const inspect = el("details", undefined, "adv");
    inspect.append(el("summary", "Inspect Cast (envoy.cast/v0.1)"));
    const wrap = el("div");
    wrap.append(el("pre", pv.castSource, "raw"));
    inspect.append(wrap);
    frag.append(inspect);
    const consentLabel = check(
      [
        el("b", "I approve sharing this context with an external AI."),
        small(
          `${complete ? "The complete Stack" : `${nEntries} ${nEntries === 1 ? "Entry" : "Entries"}${nAssets ? ` and ${nAssets} Asset${nAssets === 1 ? "" : "s"}` : ""}`}, the assignment and ${d.playbooks.length} Playbook${d.playbooks.length === 1 ? "" : "s"}. Carbon sends nothing; you copy or download the packet yourself. Accepting any Return is a separate decision.`,
        ),
      ],
      d.consent,
      (on) => {
        update({ consent: on });
        $("draft-consent")?.focus();
      },
    );
    consentLabel.classList.add("consent");
    consentLabel.querySelector("input").id = "draft-consent";
    frag.append(consentLabel);
    const can = !issues.length && d.consent;
    const row = el("div", undefined, "row export-row");
    const exportVia = (via) =>
      run(async () => {
        await dispatch.export(r.assignmentId, via);
        deps.render();
        notify(
          `Dispatch ${r.seq} ${VIA_WORDS[via]}. Carbon registered the original Cast against revision ${r.baseRevision}. Nothing has been sent — paste it into your AI.`,
          "pending",
          [{ label: "Import Return…", onClick: () => deps.importReturn(r.assignmentId) }],
        );
      });
    const make = (label, via, cls = "") => {
      const b = btn(label, () => exportVia(via), cls);
      b.disabled = !can;
      b.dataset.via = via;
      return b;
    };
    // Buttons come from the controller's supported actions, so nothing offered is refused.
    const labels = {
      copy: "Copy dispatch.md",
      "download-md": "Download dispatch.md",
      "download-files": `Download files (${1 + d.assets.length})`,
      "download-tar": complete ? "Download stack.tar + dispatch.md" : "Download selected TAR",
    };
    const actions = dispatch.exportActions(r.assignmentId);
    // When the target supports nothing (text with Assets, colliding loose files), keep its own
    // buttons visible but disabled next to the blocker that explains why.
    const nominal = { text: ["copy", "download-md"], files: ["download-files"], tar: ["download-tar"] };
    (actions.length ? actions : nominal[d.target]).forEach((via, i) => {
      const b = make(labels[via], via, i === 0 ? "primary" : "");
      if (!actions.includes(via)) b.disabled = true;
      row.append(b);
    });
    frag.append(row);
    frag.append(el("p", `Export registers the original Cast and base revision ${state.stack.manifest.revision} in this browser so a Return can be checked against it.`, "hint"));
    return frag;
  }

  // ---- pending / terminal bodies --------------------------------------------------------
  function timeline(items) {
    const ol = el("ol", undefined, "timeline");
    for (const [cls, glyph, text, sub] of items) {
      const li = el("li", undefined, cls);
      const dot = el("span", glyph, "dot");
      dot.setAttribute("aria-hidden", "true");
      const t = el("span", text);
      if (sub) t.append(el("small", sub));
      if (cls === "now") li.setAttribute("aria-current", "step");
      li.append(dot, t);
      ol.append(li);
    }
    return ol;
  }

  function summaryRow(r) {
    const d = r.draft,
      dl = el("dl", undefined, "summary");
    const add = (t, v) => {
      dl.append(el("dt", t));
      const dd = el("dd");
      dd.append(v);
      dl.append(dd);
    };
    add("Assignment", d.objective.trim() || "—");
    add("Scope", `${d.context.length} ${d.context.length === 1 ? "Entry" : "Entries"} · ${d.scope === "complete" ? "complete Stack" : "selected context"}`);
    add("Cast", code(r.assignmentId));
    return dl;
  }

  function statusBody(r) {
    const frag = document.createDocumentFragment(),
      id = r.assignmentId,
      via = r.exported?.via || "copy";
    const again = (label, how) =>
      btn(label, () =>
        run(async () => {
          await dispatch.exportAgain(id, how);
          notify(`Dispatch ${r.seq} ${VIA_WORDS[how]} again (same bytes). Nothing has been sent.`, "pending");
        }),
      );
    const importBtn = (label = "⇩ Import Return…", cls = "primary") => btn(label, () => deps.importReturn(id), cls);
    const abandon = () =>
      btn("Abandon Dispatch", () =>
        run(async () => {
          const ok = await confirm("Abandon this Dispatch?", [`Dispatch ${r.seq} is closed. Nothing in the Stack changes. A Return for it can no longer be reviewed.`], "Abandon");
          if (!ok) return;
          dispatch.abandon(id);
          deps.render();
          notify(`Dispatch ${r.seq} abandoned. Nothing was changed.`);
        }),
      );
    const continueBtn = (label) =>
      btn(label, () => {
        try {
          const next = dispatch.continueFrom(id);
          open(next.assignmentId);
          notify(`New Dispatch ${next.seq} at revision ${state.stack.manifest.revision}. Context starts from Dispatch ${r.seq}'s files; accepted results are in the Stack.`);
        } catch (e) {
          notify(e.message, "error");
        }
      }, "primary");
    const exportedAt = r.exported?.at ? new Date(r.exported.at).toLocaleString() : "";
    if (r.status === "exported") {
      frag.append(
        callout("↗", [el("b", "Waiting on you, outside Carbon."), ` The packet was ${VIA_WORDS[via]}. Carbon has not sent it anywhere and cannot see whether it was delivered. This Dispatch is not complete until a Return is reviewed and accepted.`], "scope"),
        timeline([
          ["done", "✓", "Prepared", `Base revision ${r.baseRevision}`],
          ["done", "✓", via === "copy" ? "Copied" : "Downloaded", exportedAt],
          ["now", "…", "Work with an external AI", "Paste or upload the packet; bring the Return back here"],
          ["todo", "4", "Import Return"],
          ["todo", "5", "Review and accept or reject"],
        ]),
      );
      const row = el("div", undefined, "row");
      // Repeat only actions the controller supports for this record (complete scope: TAR only).
      const actions = dispatch.exportActions(id),
        download = actions.find((x) => x !== "copy");
      row.append(importBtn());
      if (actions.includes("copy")) row.append(again("Copy again", "copy"));
      if (download) row.append(again("Download again", download));
      frag.append(row, summaryRow(r));
      const more = el("details", undefined, "adv");
      more.append(el("summary", "More"));
      const wrap = el("div");
      wrap.append(el("p", "The original Cast is kept in browser storage. If you might clear browser data before the Return arrives, download it too.", "hint"));
      const r2 = el("div", undefined, "row");
      r2.append(btn("Download original Cast", () => run(() => dispatch.downloadCast(id))), abandon());
      wrap.append(r2);
      more.append(wrap);
      frag.append(more);
    } else if (r.status === "staged") {
      frag.append(callout("⇩", "A Return is staged for review. The Stack has not changed."));
      const row = el("div", undefined, "row");
      row.append(btn("Open review", () => deps.openReview(id), "primary"), abandon());
      frag.append(row, summaryRow(r));
    } else if (r.status === "accepted") {
      frag.append(
        timeline([
          ["done", "✓", "Exported"],
          ["done", "✓", "Return reviewed"],
          ["done", "✓", `Accepted as revision ${r.acceptedRevision}`, `Revision ${r.acceptedRevision - 1} kept in History · receipt saved`],
        ]),
        summaryRow(r),
      );
      const row = el("div", undefined, "row");
      row.append(continueBtn(`↗ New Dispatch from revision ${state.stack.manifest.revision}`), btn("Export TAR.GZ", () => deps.exportGzip()));
      frag.append(row);
    } else if (r.status === "checkpoint") {
      frag.append(callout("⏸", [el("b", "Checkpoint only."), " The Return reported no changes, or none were accepted. Its receipt is saved; the Stack is unchanged."]), summaryRow(r));
      const row = el("div", undefined, "row");
      row.append(continueBtn("↗ New Dispatch"), importBtn("Import another Return…", ""));
      frag.append(row);
    } else if (r.status === "rejected") {
      frag.append(callout("⊘", "The last Return was rejected. The Stack is unchanged; the rejected Return stays in this Dispatch's history."), summaryRow(r));
      const row = el("div", undefined, "row");
      row.append(importBtn("Import another Return…", ""), continueBtn("↗ New Dispatch"));
      frag.append(row);
    } else {
      frag.append(summaryRow(r), el("p", "Abandoned. Nothing was changed.", "hint"));
    }
    return frag;
  }

  // ---- wiring -----------------------------------------------------------------------------
  $("drawer-close").onclick = () => close(true);
  $("drawer-back").onclick = () => goto((record()?.draft.step || 1) - 1, true);
  $("drawer-skip").onclick = () => goto(4, true);
  $("drawer-next").onclick = () => goto((record()?.draft.step || 0) + 1, true);
  $("drawer-discard").onclick = () =>
    run(async () => {
      const r = record();
      if (!isDraft(r)) return;
      const ok = await confirm("Discard this draft?", [`Draft Dispatch ${r.seq} is removed. Nothing was exported.`], "Discard draft");
      if (!ok) return;
      dispatch.discard(r.assignmentId);
      close(false);
      notify("Draft discarded.");
    });
  $("playbook-file").onchange = async () => {
    const f = $("playbook-file").files[0];
    $("playbook-file").value = "";
    const r = record();
    if (!f || !isDraft(r)) return;
    if (f.size > MAX_PLAYBOOK_BYTES)
      return notify(`${f.name} is ${formatBytes(f.size)}; Playbooks are limited to 16 KiB.`, "error");
    const text = await f.text();
    const name = (text.match(/^title:\s*"?([^"\n]+?)"?\s*$/m) || text.match(/^# (.+)$/m) || [, f.name.replace(/\.md$/i, "")])[1];
    addPlaybook(r, { name: name.trim() || f.name, source: `imported: ${f.name}`, content: text });
  };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("dialog").open || !ui.id || $("drawer").hidden) return;
    if (document.querySelector(".menu[open]")) return;
    e.preventDefault();
    close(true);
  });

  return {
    open,
    create,
    close,
    render,
    isOpen: () => !!ui.id && !$("drawer").hidden,
    activeId: () => ui.id,
  };
}
