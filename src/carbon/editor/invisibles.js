/**
 * "Show invisibles": view decorations that mark spaces, tabs, unusual spaces, trailing whitespace
 * and line ends in the visible part of the document. Decorations are display only: they are never
 * part of the document, so saved bytes, undo, copies, exports and search are unchanged. The
 * line-end glyph names the committed file's convention (passed in), never one inferred from the
 * LF-normalized draft. CodeMirror's `highlightSpecialChars` (always on) shows only some zero-width
 * and bidirectional controls as placeholders; while this is on, the rest of the invisible
 * characters the inspector flags (ZWNJ/ZWJ, word joiner, LRE/RLE/PDF, FSI, tag characters, fillers)
 * get placeholders too. Those are replacing view decorations, so the document is unchanged.
 */
import {
  Decoration,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  highlightSpecialChars,
  highlightWhitespace,
  highlightTrailingWhitespace,
} from "@codemirror/view";
import { lineEndMarker, UNSHOWN_INVISIBLES } from "../text-inspect.js";

class LineEnd extends WidgetType {
  constructor(glyph, title) {
    super();
    this.glyph = glyph;
    this.title = title;
  }
  eq(other) {
    return other.glyph === this.glyph && other.title === this.title; // "none" and "lf" share ␊; the title differs
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-eol";
    span.textContent = this.glyph;
    span.title = this.title;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  ignoreEvent() {
    return true;
  }
}
const oddSpaces = new MatchDecorator({
  regexp: /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/gu,
  decoration: (m) => Decoration.mark({
    class: "cm-oddSpace",
    attributes: { title: `Unusual space U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}` },
  }),
});
/**
 * The extension set for one file.
 * @param {"none"|"lf"|"crlf"|"cr"|"mixed"} eol the committed file's line-ending convention
 */
export function invisibles(eol) {
  const [glyph, title] = lineEndMarker(eol);
  const widget = Decoration.widget({ widget: new LineEnd(glyph, title), side: 1 });
  const lineEnds = (view) => {
    const marks = [];
    const last = view.state.doc.length;
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to; ) {
        const line = view.state.doc.lineAt(pos);
        if (line.to < last) marks.push(widget.range(line.to)); // every line but the last ends in a break
        pos = line.to + 1;
      }
    }
    return Decoration.set(marks, true);
  };
  return [
    highlightSpecialChars({ addSpecialChars: UNSHOWN_INVISIBLES }),
    highlightWhitespace(),
    highlightTrailingWhitespace(),
    ViewPlugin.define((view) => ({
      decorations: oddSpaces.createDeco(view),
      update(u) {
        this.decorations = oddSpaces.updateDeco(u, this.decorations);
      },
    }), { decorations: (v) => v.decorations }),
    ViewPlugin.define((view) => ({
      decorations: lineEnds(view),
      update(u) {
        if (u.docChanged || u.viewportChanged) this.decorations = lineEnds(u.view);
      },
    }), { decorations: (v) => v.decorations }),
  ];
}
