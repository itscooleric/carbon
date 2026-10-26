/** Palette-only CodeMirror effects; the editor adapter and its session ownership stay intact. */
import { StateEffect, Transaction } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin } from "@codemirror/view";

export const flashEffect = StateEffect.define();
// View-local decorations disappear on Entry/state switches, rather than entering cached history.
const flashPlugin = ViewPlugin.fromClass(
  class {
    decorations = Decoration.none;
    update(update) {
      if (update.docChanged) this.decorations = Decoration.none;
      for (const tr of update.transactions)
        for (const effect of tr.effects)
          if (effect.is(flashEffect)) {
            this.decorations = effect.value
              ? Decoration.set([
                  Decoration.mark({ class: "cm-palette-hit" }).range(
                    effect.value.from,
                    effect.value.to,
                  ),
                ])
              : Decoration.none;
          }
    }
  },
  { decorations: (value) => value.decorations },
);
export function createNavigator(getView) {
  let timer;
  const clear = () => {
    clearTimeout(timer);
    const view = getView();
    if (view.plugin(flashPlugin))
      view.dispatch({
        effects: flashEffect.of(null),
        annotations: Transaction.addToHistory.of(false),
      });
  };
  return {
    clear,
    reveal(source, { from, to }) {
      clear();
      const view = getView();
      if (
        view.state.doc.toString() !== source ||
        from < 0 ||
        to <= from ||
        to > source.length
      )
        throw Error("This Entry changed. Search again to locate the passage.");
      const effects = [
        flashEffect.of({ from, to }),
        EditorView.scrollIntoView(from, { y: "center" }),
      ];
      if (!view.plugin(flashPlugin))
        view.dispatch({
          effects: StateEffect.appendConfig.of(flashPlugin),
          annotations: Transaction.addToHistory.of(false),
        });
      view.dispatch({
        selection: { anchor: from },
        effects,
        annotations: Transaction.addToHistory.of(false),
      });
      timer = setTimeout(clear, 5000);
    },
  };
}
