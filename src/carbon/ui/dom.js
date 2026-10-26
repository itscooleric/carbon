/** Small DOM helpers shared by every Carbon view module. No state lives here. */

/**
 * Look up an element by id.
 * @param {string} id
 * @returns {HTMLElement|null}
 */
export const $ = (id) => document.getElementById(id);

/**
 * Create an element with optional text content and class name. Text is set with
 * `textContent`, so untrusted strings are rendered literally.
 * @param {string} tag
 * @param {string} [text]
 * @param {string} [cls]
 * @returns {HTMLElement}
 */
export const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
