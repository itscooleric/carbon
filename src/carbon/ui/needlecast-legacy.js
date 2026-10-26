/**
 * Legacy manual Needlecast (envoy.handoff/v0.2): export a handoff packet, register an
 * original packet, and review a returned packet. Behavior is unchanged from Carbon v1.
 * Ids used: #export-handoff, #register-dispatch, #original.
 *
 * Trust: packet text is untrusted; `propose` / `registerDispatch` validate it against the
 * retained base Stack and every rendered string is text.
 */
import { sameStack } from "../../core/stack.js";
import { assert, decode, encode, LIMITS } from "../../core/validate.js";
import {
  dispatch,
  propose,
  registerDispatch,
  diffLines,
} from "../../core/handoff.js";
import { writeTar } from "../../archives/tar.js";
import { $, el } from "./dom.js";

/** @typedef {import("../types.js").Deps} Deps */

/**
 * Header check for a legacy v0.2 handoff packet, used by the Return router to pick this
 * review path over the Cast Kit Return path.
 * @param {string} text
 * @returns {boolean}
 */
export function isLegacyHandoff(text) {
  return /^# Envoy Handoff\n/.test(text);
}

/**
 * Review a returned legacy packet against the retained dispatch and accept it as one new
 * revision, or reject it leaving the Stack unchanged.
 * @param {Deps} deps
 * @param {string} text returned `.handoff.md` text
 * @returns {Promise<void>}
 * @throws {Error} on unsaved drafts, no retained dispatch, or a packet that fails validation
 */
export async function reviewReturn(deps, text) {
  const {
    state,
    modal,
    notify,
    persist,
    replace,
    requireSaved,
    download,
    cacheAvailable,
  } = deps;
  deps.requireStack();
  requireSaved();
  const { stack } = state;
  const candidate = propose(stack, state.trusted, text);
  const ok = await modal(
    "Review Needlecast Return",
    (c) => {
      c.append(
        el(
          "p",
          `${candidate.changes.length} changed Entries. Revision ${stack.manifest.revision} → ${candidate.next.manifest.revision}. Omitted files remain unchanged. A prior revision is retained in History.`,
        ),
      );
      for (const change of candidate.changes) {
        c.append(el("h3", change.path));
        const d = el("div", undefined, "diff");
        const lines = diffLines(change.before, change.after);
        if (!lines) {
          c.append(
            el(
              "p",
              "This change exceeds the compact diff budget. Review the complete original and proposed text below; no changes are hidden.",
            ),
            el("h4", "Original"),
            el("pre", change.before),
            el("h4", "Proposed"),
            el("pre", change.after),
          );
          continue;
        }
        for (const line of lines)
          d.append(
            el(
              "div",
              (line.kind === "removed"
                ? "- "
                : line.kind === "added"
                  ? "+ "
                  : "  ") + line.text,
              line.kind,
            ),
          );
        c.append(d);
      }
      return () => true;
    },
    "Accept changes",
  );
  if (!ok) {
    notify("Return rejected. Stack unchanged.");
    return;
  }
  assert(sameStack(state.stack, candidate.base), "Stack changed during review");
  await persist();
  if (!cacheAvailable())
    download(
      writeTar(state.stack),
      `${state.stack.manifest.id}-before-return-r${state.stack.manifest.revision}.stack.tar`,
    );
  await replace(candidate.next, "Before accepting Needlecast Return");
  notify(
    "Return accepted. Previous revision is available in History. Export the updated Stack.",
  );
}

/**
 * Wire Needlecast export and original-packet registration.
 * @param {Deps} deps
 */
export function mountNeedlecastLegacy(deps) {
  const {
    state,
    run,
    action,
    modal,
    notify,
    persist,
    requireSaved,
    download,
  } = deps;
  action("export-handoff", async () => {
    deps.requireStack();
    requireSaved();
    const { stack, selected } = state;
    const next = dispatch(stack, selected.size ? [...selected] : undefined);
    const ok = await modal(
      "Needlecast dispatch",
      (c) => {
        c.append(
          el(
            "p",
            "Attach the exported Markdown to your AI chat. Ask for Entry body edits only; preserve YAML frontmatter, packet metadata, and every frame exactly.",
          ),
          el(
            "pre",
            `Included:\n${next.included.join("\n")}\n\nOmitted (preserved locally):\n${next.omitted.join("\n") || "(none)"}`,
          ),
        );
        return () => true;
      },
      "Export handoff",
    );
    if (!ok) return;
    state.trusted = next;
    await persist();
    download(
      encode(next.text),
      `${stack.manifest.id}.handoff.md`,
      "text/markdown",
    );
    notify(
      "Dispatch retained locally. Import the returned .handoff.md to review changes.",
    );
  });
  action("register-dispatch", () => $("original").click());
  $("original").onchange = () =>
    run(async () => {
      const f = $("original").files[0];
      $("original").value = "";
      if (!f) return;
      deps.requireStack();
      requireSaved();
      assert(f.size <= 4 * LIMITS.text, "Handoff too large");
      const next = registerDispatch(
        state.stack,
        decode(new Uint8Array(await f.arrayBuffer())),
      );
      const ok = await modal(
        "Register original dispatch?",
        (c) => {
          c.append(
            el(
              "p",
              "The included files exactly match the current Stack. Trust this original packet as the scope for a later Return?",
            ),
            el("pre", next.included.join("\n")),
          );
          return () => true;
        },
        "Register",
      );
      if (ok) {
        state.trusted = next;
        await persist();
        notify(
          "Original dispatch registered. Import a returned packet to review proposals.",
        );
      }
    });
}
