/**
 * The single shared `<dialog id="dialog">`. Ids used: #dialog, #dialog-content,
 * #dialog-title (assigned to the heading), #dialog-error, #dialog-accept, #dialog-cancel.
 */
import { assert } from "../../core/validate.js";
import { $, el } from "./dom.js";

/**
 * Open the shared modal dialog. `build(content)` fills the dialog and may return a
 * reader; the reader runs on Accept and its return value resolves the promise. A reader
 * that throws keeps the dialog open and shows the message in #dialog-error.
 * Cancel, Escape and (when `accept` is null) Close resolve `null`.
 * @template T
 * @param {string} title
 * @param {(content: HTMLElement) => ((() => T)|void)} build
 * @param {string|null} [accept="Accept"] accept button label; null hides it
 * @returns {Promise<T|true|null>}
 * @throws {Error} when another dialog is already open
 */
export function modal(title, build, accept = "Accept") {
  assert(!$("dialog").open, "Close the current dialog first");
  const content = $("dialog-content");
  content.replaceChildren(el("h2", title));
  content.firstElementChild.id = "dialog-title";
  $("dialog-error").textContent = "";
  const read = build(content) || (() => true);
  $("dialog-accept").textContent = accept;
  $("dialog-accept").hidden = !accept;
  $("dialog-cancel").textContent = accept ? "Cancel" : "Close";
  $("dialog").showModal();
  return new Promise((resolve) => {
    const finish = (value) => {
      $("dialog").close();
      $("dialog-accept").onclick = null;
      $("dialog-cancel").onclick = null;
      $("dialog").oncancel = null;
      resolve(value);
    };
    $("dialog-accept").onclick = () => {
      try {
        finish(read());
      } catch (e) {
        $("dialog-error").textContent = e.message;
      }
    };
    $("dialog-cancel").onclick = () => finish(null);
    $("dialog").oncancel = (e) => {
      e.preventDefault();
      finish(null);
    };
  });
}

/**
 * Prompt for one line of text. `validate` may throw to keep the dialog open, and its
 * return value is the resolved value.
 * @template T
 * @param {string} title
 * @param {string} label
 * @param {string} [value=""] initial input value
 * @param {(value: string) => T} [validate]
 * @returns {Promise<T|null>} null when cancelled
 */
export async function ask(title, label, value = "", validate = (value) => value) {
  return modal(
    title,
    (c) => {
      const l = el("label", label),
        input = el("input");
      input.value = value;
      l.append(input);
      c.append(l);
      setTimeout(() => input.focus(), 0);
      return () => validate(input.value);
    },
    "Continue",
  );
}

/**
 * Yes/no confirmation built on `modal`: each line becomes a paragraph rendered as text.
 * @param {string} title
 * @param {string[]} lines
 * @param {string} [acceptLabel="Accept"]
 * @returns {Promise<boolean>} true when accepted
 */
export async function confirm(title, lines, acceptLabel = "Accept") {
  const ok = await modal(
    title,
    (c) => {
      for (const line of lines) c.append(el("p", line));
      return () => true;
    },
    acceptLabel,
  );
  return ok === true;
}
