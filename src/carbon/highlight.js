/**
 * The one highlight.js instance: Markdown code fences and the read-only code Viewer share the
 * same bundled grammars. Highlighted output is escaped by highlight.js and is still passed
 * through DOMPurify (only `span.class`) before it reaches the DOM.
 */
import createDOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import yaml from "highlight.js/lib/languages/yaml";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import ini from "highlight.js/lib/languages/ini";
import sql from "highlight.js/lib/languages/sql";

for (const [name, grammar] of Object.entries({
  javascript, python, yaml, json, bash, typescript, xml, css, ini, sql,
}))
  hljs.registerLanguage(name, grammar);

export { hljs };
export const hasLanguage = (language) => typeof language === "string" && Boolean(hljs.getLanguage(language));
/** Highlight untrusted source to escaped HTML; an unknown grammar or a failure gives null. */
export function highlightSource(source, language) {
  if (!hasLanguage(language)) return null;
  try {
    return hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
/** Highlighted HTML restricted to `<span class>`; null means "render as plain text". */
export function highlightHtml(source, language, window) {
  const html = highlightSource(source, language);
  if (html === null) return null;
  return createDOMPurify(window).sanitize(html, {
    ALLOWED_TAGS: ["span"],
    ALLOWED_ATTR: ["class"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
