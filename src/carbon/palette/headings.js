/** First document-level H1, with offsets in the original (possibly CRLF) source. */
import { markdownLanguage } from "@codemirror/lang-markdown";

export function firstHeading(source) {
  for (let node = markdownLanguage.parser.parse(source).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "ATXHeading1" && node.name !== "SetextHeading1") continue;
    // Lezer includes the CR in an ATX heading. Keep the original line ending.
    const to = source[node.to - 1] === "\r" ? node.to - 1 : node.to;
    const raw = source.slice(node.from, to);
    const text = node.name === "ATXHeading1"
      ? raw.replace(/^#[ \t]*/, "").replace(/[ \t]+#+[ \t]*$/, "").trim()
      : source.slice(node.from, node.lastChild.from).trim().replace(/\s+/g, " ");
    return { from: node.from, to, text };
  }
  return null;
}
