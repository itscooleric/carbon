/**
 * Full-width Return review mode. Renders a `ReviewModel` built by the return controller:
 * banner, proposed-change list with operation badges, unified diff (diff-view.js), the
 * receipt and Carbon checks column, and the decision footer. Carbon never decides validity
 * here; `model.checks`, `model.canAccept` and `model.reason` come from the controller.
 * Ids used: #review (hidden when inactive), #review-heading, #review-banner, #review-files,
 * #review-diff, #review-receipt, #review-foot, #review-reject, #review-keep, #review-reason,
 * #review-accept, #review-save-receipt, #review-save-answer, #review-redispatch,
 * #review-open-dirty, #workspace (hidden while review is active).
 *
 * Trust: summaries, evidence, paths and bodies come from the Return and are rendered as
 * text only. Esc does not exit review; the explicit footer buttons do.
 */
import { assertNewPath, suggestPath } from "../../core/naming.js";
import { encode } from "../../core/validate.js";
import { $, el } from "./dom.js";
import { statusChip } from "./sidebar.js";
import { diffTable, wholeFile, renameView, metadataBox, changedLineCount } from "./diff-view.js";

/** @typedef {import("../types.js").Deps} Deps */

const OPS = {
  create: ["add", "NEW"],
  replace: ["mod", "EDIT"],
  delete: ["del", "DELETE"],
  rename: ["ren", "RENAME"],
};
const SELF = {
  complete: ["self-complete", "●", "Reported complete"],
  partial: ["checkpoint", "◐", "Reported partial"],
  blocked: ["warn", "■", "Reported blocked"],
  failed: ["warn", "✕", "Reported failed"],
  cancelled: ["warn", "⊘", "Reported cancelled"],
};

/**
 * Operation badge: text and border style both carry the meaning.
 * @param {{op: string, permitted: boolean}} change
 * @returns {HTMLElement}
 */
function opBadge(change) {
  const [cls, word] = OPS[change.op] || ["mod", change.op.toUpperCase()];
  return el("span", change.permitted ? word : `✕ ${word}`, `op ${change.permitted ? cls : "bad"}`);
}

/**
 * Mount review mode.
 * @param {Deps} deps
 * @returns {{open: (model: object) => void, close: () => void, isActive: () => boolean, render: () => void}}
 */
export function mountReturnReview(deps) {
  const { state, returns, notify, confirm, run } = deps;
  /** View state: the model being reviewed, the selected change and expanded diff hunks. */
  const ui = { model: null, sel: 0, expanded: new Map() };
  const btn = (text, onClick, cls = "", id) => {
    const b = el("button", text, cls);
    b.type = "button";
    b.onclick = onClick;
    if (id) b.id = id;
    return b;
  };
  const section = (title, nodes) => {
    const s = el("div", undefined, "rsec");
    s.append(el("h3", title), ...nodes);
    return s;
  };
  const listOrNone = (items, none = "None.") => {
    if (!items.length) return [el("p", none, "hint")];
    const ul = el("ul");
    for (const x of items) ul.append(el("li", x));
    return [ul];
  };
  const linesOf = (text) => (text == null ? 0 : text.split("\n").length);

  function exit(focusId = "dispatch") {
    ui.model = null;
    $("review").hidden = true;
    $("workspace").hidden = false;
    deps.render();
    $(focusId)?.focus();
  }

  function open(model) {
    ui.model = model;
    ui.sel = 0;
    ui.expanded = new Map();
    deps.closeDrawer();
    $("workspace").hidden = true;
    $("review").hidden = false;
    render();
    setTimeout(() => $("review-heading").focus(), 0);
  }

  function select(i) {
    const n = ui.model?.changes.length || 0;
    if (!n) return;
    ui.sel = Math.max(0, Math.min(n - 1, i));
    render();
    document.querySelector("#review-files [aria-current]")?.focus();
  }

  function render() {
    const m = ui.model;
    if (!m) return;
    const r = m.dispatch,
      changes = m.changes,
      current = state.stack.manifest.revision;
    // Banner
    const banner = $("review-banner");
    banner.replaceChildren();
    const h = el("h2", `Dispatch ${r.seq} · ${r.draft.objective.trim().slice(0, 120) || "Untitled"}`);
    h.id = "review-heading";
    h.tabIndex = -1;
    const [selfCls, selfGlyph, selfWords] = SELF[m.selfStatus] || SELF.complete;
    const selfChip = el("span", undefined, `chip ${selfCls}`);
    const g = el("span", selfGlyph, "g");
    g.setAttribute("aria-hidden", "true");
    selfChip.append(g, `${selfWords} `, el("span", "(self-reported)", "muted"));
    const counts = Object.keys(OPS)
      .map((k) => [k, changes.filter((c) => c.op === k).length])
      .filter(([, n]) => n)
      .map(([k, n]) => `${n} ${OPS[k][1].toLowerCase()}`)
      .join(" · ");
    const facts = el("div", undefined, "facts");
    facts.append(el("span", `Stack unchanged at revision ${current}`), el("span", counts || "no file operations"));
    banner.append(el("span", "Return review", "eyebrow"), h, statusChip("staged"), selfChip, el("span", undefined, "spacer"), facts);
    // File list
    const files = $("review-files");
    files.replaceChildren();
    files.hidden = !changes.length;
    if (changes.length) {
      files.append(el("span", `Proposed changes · ${changes.length}`, "eyebrow"));
      const ul = el("ul");
      changes.forEach((c, i) => {
        const li = el("li");
        const b = el("button", undefined, `rfile${i === ui.sel ? " sel" : ""}`);
        b.type = "button";
        if (i === ui.sel) b.setAttribute("aria-current", "true");
        let meta;
        if (!c.permitted) meta = "Not permitted by Cast";
        else if (c.op === "rename") meta = `→ ${c.to}`;
        else if (c.op === "create") meta = `${linesOf(c.after)} lines`;
        else if (c.op === "delete") meta = `${linesOf(c.before)} lines removed`;
        else {
          const n = changedLineCount(c.before || "", c.after || "");
          meta = `${n == null ? "many" : n} changed lines${c.metadata?.length ? " · metadata" : ""}`;
        }
        b.append(opBadge(c), el("span", c.path, "p"), el("span", meta, "m"));
        b.onclick = () => select(i);
        li.append(b);
        ul.append(li);
      });
      files.append(ul, el("p", "J / K to move between files.", "hint"));
    }
    // Centre
    const diff = $("review-diff");
    diff.replaceChildren();
    if (!changes.length) {
      const answer = el("div", undefined, "answer");
      answer.append(el("h2", m.selfStatus === "blocked" ? "Blocked — no changes proposed" : "Answer"));
      answer.append(el("pre", m.summary, "answer-text"));
      if (m.blockers.length) answer.append(el("h3", "Blockers"), ...listOrNone(m.blockers));
      answer.append(
        el("p", "This Return proposes no file operations. Nothing in the Stack will change. You can keep the receipt, or save the answer as a new Entry yourself.", "hint"),
      );
      diff.append(answer);
    } else {
      const c = changes[ui.sel];
      const hdr = el("div", undefined, "dhdr");
      const p = el("span", c.path, "p");
      if (c.op === "rename") p.append(` → ${c.to}`);
      const prev = btn("↑ Prev", () => select(ui.sel - 1), "sm"),
        next = btn("↓ Next", () => select(ui.sel + 1), "sm");
      prev.disabled = ui.sel === 0;
      next.disabled = ui.sel >= changes.length - 1;
      prev.setAttribute("aria-label", "Previous change (K)");
      next.setAttribute("aria-label", "Next change (J)");
      hdr.append(opBadge(c), p, el("span", undefined, "spacer"), el("span", `${ui.sel + 1} of ${changes.length}`, "small muted"), prev, next);
      diff.append(hdr);
      if (!c.permitted) {
        const err = el("div", undefined, "err inset");
        err.setAttribute("role", "alert");
        err.append(el("b", "✕ Not permitted by the original Cast"), `The Cast did not allow ${c.op} for ${c.path}. A Return cannot widen its own scope. The whole Return must be rejected or re-dispatched with that permission.`);
        diff.append(err);
      }
      if (c.metadata?.length) diff.append(metadataBox(c.metadata));
      if (c.op === "rename") diff.append(renameView(c.path, c.to, c.before));
      else if (c.op === "create") diff.append(wholeFile(c.after || "", "add"));
      else if (c.op === "delete") diff.append(wholeFile(c.before || "", "del"));
      else {
        const expanded = ui.expanded.get(ui.sel) || new Set();
        diff.append(
          diffTable(c.before || "", c.after || "", {
            expanded,
            onExpand: (i) => {
              expanded.add(i);
              ui.expanded.set(ui.sel, expanded);
              render();
            },
          }),
        );
      }
    }
    // Receipt column
    const side = $("review-receipt");
    side.replaceChildren();
    const checks = el("ul", undefined, "checks");
    for (const c of m.checks) {
      const li = el("li", undefined, c.ok ? "" : "fail");
      const g = el("span", c.ok ? "✓" : "✕", "g");
      g.setAttribute("aria-hidden", "true");
      const t = el("span");
      t.append(el("span", c.ok ? "Passed: " : "Failed: ", "sr"), c.text);
      li.append(g, t);
      checks.append(li);
    }
    side.append(
      section("Carbon checks", [checks, el("p", "Checks confirm scope and integrity. They do not confirm the content is correct.", "hint")]),
      section("Summary", [el("p", m.summary, "rsummary")]),
    );
    if (m.blockers.length) {
      const s = section("Blockers", listOrNone(m.blockers));
      s.setAttribute("role", "alert");
      side.append(s);
    }
    side.append(section("Evidence cited", listOrNone(m.evidence)), section("Unresolved", listOrNone(m.unresolved, "None reported.")));
    side.append(section("Operations performed", listOrNone(m.opsPerformed, "None reported (text-only destination). All changes above are proposals.")));
    if (m.accepted.length) side.append(section("Accepted", listOrNone(m.accepted)));
    if (m.decisions.length) side.append(section("Decisions", listOrNone(m.decisions)));
    if (m.verification.length) side.append(section("Verification", listOrNone(m.verification)));
    // Footer
    const foot = $("review-foot");
    foot.replaceChildren();
    foot.append(
      btn("Reject…", () => reject(), "", "review-reject"),
      btn("Keep pending & close", () => {
        returns.keepPending();
        const seq = r.seq;
        exit();
        notify(`Return for Dispatch ${seq} kept pending. Nothing changed. Open it again from Dispatches.`, "info", [
          { label: "Open review", onClick: () => deps.openReview(r.assignmentId) },
        ]);
      }, "", "review-keep"),
    );
    const reason = el("span", m.reason, "note");
    reason.id = "review-reason";
    foot.append(reason);
    if (m.stale)
      foot.append(
        btn(`↗ Re-dispatch from revision ${current}`, () => {
          try {
            const next = deps.dispatch.redispatch(r.assignmentId);
            exit();
            deps.openDispatch(next.assignmentId);
            notify(`New draft Dispatch ${next.seq} from revision ${current}, copied from Dispatch ${r.seq}. The stale Return stays pending on Dispatch ${r.seq}.`);
          } catch (e) {
            notify(e.message, "error");
          }
        }, "", "review-redispatch"),
      );
    if (m.dirtyPaths.length)
      foot.append(
        btn("Open unsaved Entry", () => {
          const p = m.dirtyPaths[0];
          exit();
          run(() => deps.openFile(p));
          notify(`Save or discard ${p}, then reopen the review from Dispatches.`);
        }, "", "review-open-dirty"),
      );
    if (m.zeroOps) {
      const receipt = btn("Save receipt", () => saveReceipt(), "primary", "review-save-receipt"),
        answer = btn("Save answer as Entry…", () => saveAnswer(), "", "review-save-answer");
      // A failed check means this text is not a trustworthy checkpoint for the Dispatch.
      receipt.disabled = answer.disabled = !m.canSaveReceipt;
      foot.append(receipt, answer);
    } else {
      const accept = btn(`Accept ${changes.length} change${changes.length === 1 ? "" : "s"}…`, () => acceptFlow(), "primary", "review-accept");
      accept.disabled = !m.canAccept;
      foot.append(accept);
    }
  }

  async function acceptFlow() {
    const m = ui.model;
    if (!m || !m.canAccept) return;
    const r = m.dispatch,
      next = state.stack.manifest.revision + 1;
    const ok = await deps.modal(
      `Accept ${m.changes.length} change${m.changes.length === 1 ? "" : "s"} as revision ${next}?`,
      (c) => {
        const ul = el("ul", undefined, "accept-list");
        for (const ch of m.changes) {
          const li = el("li");
          li.append(opBadge(ch), " ", el("code", ch.path));
          if (ch.to) li.append(" → ", el("code", ch.to));
          ul.append(li);
        }
        c.append(
          ul,
          el("p", `Revision ${next - 1} is kept in History. The receipt is saved with the new revision. Carbon re-checks the Stack before writing.`),
          el("p", "Browser storage is not a backup. Export an archive afterwards for a durable copy.", "hint"),
        );
        return () => true;
      },
      `Accept as revision ${next}`,
    );
    if (!ok) return;
    const button = $("review-accept");
    if (button) button.disabled = true;
    await run(async () => {
      try {
        // Without a draft cache the previous revision would exist only in memory: request its
        // archive first, as the legacy Needlecast route does.
        if (!deps.cacheAvailable()) deps.downloadSnapshot("before-return");
        const result = await returns.accept(r.assignmentId);
        for (const [from, to] of result.renames) deps.editor.renameSession(from, to);
        exit();
        notify(`Revision ${result.revision} saved in this browser with receipt. Not yet in an archive.`, "ok", [
          { label: "Export TAR.GZ", onClick: () => deps.exportGzip() },
          {
            label: `New Dispatch from rev ${result.revision}`,
            onClick: () => {
              try {
                deps.openDispatch(deps.dispatch.continueFrom(r.assignmentId).assignmentId);
              } catch (e) {
                notify(e.message, "error");
              }
            },
          },
        ]);
      } catch (e) {
        if (button) button.disabled = !m.canAccept;
        const detail = /^Not saved/.test(e.message)
          ? e.message
          : `Not saved. ${e.message} Revision ${next} was not created and the Stack is unchanged. The Return is still staged.`;
        notify(detail, "error", [
          { label: "Retry", onClick: () => acceptFlow() },
          {
            label: "Download proposed archive",
            onClick: () =>
              run(() => deps.download(returns.proposedArchive(r.assignmentId), `${state.stack.manifest.id}-proposed-r${next}.stack.tar`)),
          },
        ]);
      }
    });
  }

  function reject() {
    const m = ui.model;
    if (!m) return;
    run(async () => {
      const ok = await confirm(
        "Reject this Return?",
        [`The Stack stays at revision ${state.stack.manifest.revision}. The Return stays in the Dispatch history marked rejected. You can import another Return for the same Dispatch.`],
        "Reject Return",
      );
      if (!ok) return;
      await returns.reject(m.dispatch.assignmentId);
      exit();
      notify("Return rejected. Stack unchanged.");
    });
  }

  function saveReceipt() {
    const m = ui.model;
    if (!m) return;
    run(async () => {
      await returns.saveReceipt(m.dispatch.assignmentId);
      exit();
      notify(`Receipt for Dispatch ${m.dispatch.seq} saved. Stack unchanged at revision ${state.stack.manifest.revision}.`, "ok");
    });
  }

  /** Create a note Entry from the Return summary and evidence; the user's own edit. */
  function saveAnswer() {
    const m = ui.model;
    if (!m) return;
    run(async () => {
      const { stack } = state;
      const p = await deps.ask("Save answer as a new Entry", "Path", suggestPath(stack, "note"), (v) => assertNewPath(stack, v));
      if (p === null) return;
      assertNewPath(stack, p);
      deps.workspace?.canOpen(p);
      const title = p.split("/").pop().replace(/\.md$/i, "");
      const body = `${m.summary}\n${m.evidence.length ? `\n## Evidence\n\n${m.evidence.map((e) => `- ${e}`).join("\n")}\n` : ""}${m.unresolved.length ? `\n## Unresolved\n\n${m.unresolved.map((e) => `- ${e}`).join("\n")}\n` : ""}`;
      const source =
        deps.templates.note
          .replace("ent-replace-with-stable-id", "ent-" + crypto.randomUUID())
          .replace(/^title:.*$/m, () => `title: ${JSON.stringify(title)}`)
          .replace(/^# .*$/m, () => `# ${title}`)
          .replace(/\s*$/, "") + `\n\n${body}`;
      const next = stack.change({ writes: new Map([[p, encode(source)]]) });
      // One atomic commit: the checkpoint receipt (checked against the current Stack, before the new
      // Entry moves it past the Cast base), the answer Entry, History and the selected path. If the
      // store refuses it, nothing changes and the Return stays staged for another try.
      const dispatches = returns.receiptDispatches(m.dispatch.assignmentId);
      await deps.replace(next, "Before saving a Return answer as Entry", { dispatches, current: p });
      exit();
      notify(`Answer saved as ${p} and receipt kept for Dispatch ${m.dispatch.seq}.`, "ok");
    });
  }

  document.addEventListener("keydown", (e) => {
    if (!ui.model || $("dialog").open) return;
    if (document.activeElement?.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
    if (e.key === "j") select(ui.sel + 1);
    else if (e.key === "k") select(ui.sel - 1);
  });

  return { open, close: () => exit(), isActive: () => !!ui.model, render };
}
