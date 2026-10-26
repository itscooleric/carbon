/** Small offline editor adapter. Session history stays separate from persisted drafts. */
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  rectangularSelection,
  highlightSpecialChars,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  standardKeymap,
  redo,
  toggleTabFocusMode,
} from "@codemirror/commands";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, language } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  closeBrackets,
  closeBracketsKeymap,
  autocompletion,
  completionKeymap,
} from "@codemirror/autocomplete";
import { selectNextOccurrence } from "@codemirror/search";
import {
  continueList,
  deleteMarkup,
  toggleTasks,
  indentOrTab,
  outdentOrDedent,
  surround,
  wikiCompletion,
} from "./behaviors.js";
import { isMarkdown } from "../local-files.js";
import { invisibles } from "./invisibles.js";

const colors = HighlightStyle.define([
  { tag: tags.heading, color: "var(--accent)", fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: [tags.link, tags.url], color: "var(--cyan)" },
  { tag: [tags.monospace, tags.processingInstruction], color: "var(--number)" },
  { tag: tags.meta, color: "var(--muted)" },
]);
const normalize = (text) => text.replace(/\r\n?/g, "\n");
/** Markdown commands act only in a Markdown document; plain text is never reformatted. */
const inMarkdown = (state) => state.facet(language) === markdownLanguage;
const markdownOnly = (command) => (target) => inMarkdown(target.state) && command(target);
const bold = markdownOnly(surround("**")),
  task = markdownOnly(toggleTasks);
/**
 * Per-file mode. Markdown documents get the Markdown language (syntax tree for list continuation,
 * tasks, wiki completion and highlighting), the formatting keys and `*_~` surround; any other text
 * file gets none of them, so list, task and wiki behaviors (which need the syntax tree) also stay off.
 */
const markdownMode = [
  markdownLanguage,
  EditorView.contentAttributes.of({ "aria-label": "Markdown editor" }),
  EditorView.inputHandler.of((view, _from, _to, text) => {
    if (
      view.composing ||
      !/^[*_~]$/.test(text) ||
      view.state.selection.ranges.some((r) => r.empty)
    )
      return false;
    return surround(text)(view);
  }),
  keymap.of([
    { key: "Alt-c", run: toggleTasks },
    { key: "Mod-b", run: surround("**") },
    { key: "Mod-i", run: surround("_") },
  ]),
];
const textMode = [EditorView.contentAttributes.of({ "aria-label": "Text editor" })];

export function createEditor({
  parent,
  getContext,
  onChange,
  togglePreview,
  handleImages = () => false,
  lineEnding = () => "lf",
}) {
  const locked = new Compartment(),
    occurrenceKey = new Compartment(),
    mode = new Compartment(),
    invisible = new Compartment();
  let busy = false,
    current = null,
    stackId = null,
    syncing = false,
    occurrenceEnabled = false,
    invisiblesShown = false;
  const sessions = new Map();
  let openPaths = new Set();
  const extensions = [
    EditorView.domEventHandlers({
      paste: handleImages,
      drop: handleImages,
      dragover: handleImages,
    }),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    highlightSpecialChars(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    syntaxHighlighting(colors),
    EditorState.tabSize.of(2),
    locked.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
    EditorView.contentAttributes.of({
      "aria-describedby": "editor-help",
      spellcheck: "false",
      autocapitalize: "off",
    }),
    closeBrackets(),
    autocompletion({
      override: [wikiCompletion(getContext)],
      defaultKeymap: false,
    }),
    occurrenceKey.of([]),
    invisible.of([]),
    // Tab always indents inside the editor, so the documented escape must not depend on whether a
    // keymap (completion, selection simplification) consumed Escape: arm CodeMirror's two-second
    // Tab focus window on every Escape, then let the other handlers run.
    Prec.highest(
      EditorView.domEventHandlers({
        keydown(event, view) {
          if (event.key === "Escape") view.setTabFocusMode(2000);
          return false;
        },
      }),
    ),
    keymap.of([
      {
        key: "Alt-p",
        run: () => {
          togglePreview();
          return true;
        },
      },
      ...completionKeymap,
      { key: "Tab", run: indentOrTab, shift: outdentOrDedent },
      { key: "Ctrl-m", mac: "Shift-Alt-m", run: toggleTabFocusMode },
      { key: "Enter", run: continueList },
      { key: "Backspace", run: deleteMarkup },
      ...closeBracketsKeymap,
      { key: "Mod-Shift-z", run: redo, preventDefault: true },
      ...historyKeymap.filter(
        (binding) => !["Mod-u", "Alt-u"].includes(binding.key),
      ),
      // Keep browser bookmarks/find/location shortcuts intact.
      ...standardKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !syncing && current)
        onChange(update.state.doc.toString());
    }),
  ];
  const modeFor = (path) => (isMarkdown(path) ? markdownMode : textMode);
  // The mode compartment comes first so the Markdown keys take precedence, as they did in one keymap.
  const fresh = (doc, path) => EditorState.create({ doc, extensions: [mode.of(modeFor(path)), extensions] });
  const view = new EditorView({ parent, state: fresh("", null) });
  function setBusy(value) {
    busy = value;
    const readOnly = busy || !current;
    view.dispatch({
      effects: locked.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
    view.contentDOM.setAttribute("aria-readonly", String(readOnly));
  }
  /** Session-local, display only: the line-end glyph follows the committed file's convention. */
  function setInvisibles(enabled) {
    invisiblesShown = enabled;
    view.dispatch({
      effects: invisible.reconfigure(enabled && current ? invisibles(lineEnding(current)) : []),
    });
  }
  function setOccurrenceKey(enabled) {
    occurrenceEnabled = enabled;
    view.dispatch({
      effects: occurrenceKey.reconfigure(
        enabled ? keymap.of([{ key: "Mod-d", run: selectNextOccurrence }]) : [],
      ),
    });
  }
  return {
    view,
    setOpenPaths(paths) {
      openPaths = new Set(paths);
    },
    renameSession(from, to) {
      if (sessions.has(from)) {
        sessions.set(to, sessions.get(from));
        sessions.delete(from);
      }
      if (current === from) current = to;
    },
    setBusy,
    setOccurrenceKey,
    setInvisibles,
    sync(stack, path, source) {
      const id = stack.manifest.id;
      const doc = normalize(source);
      if (current && stackId === id)
        sessions.set(current, {
          state: view.state,
          top: view.scrollDOM.scrollTop,
        });
      if (stackId !== id) sessions.clear();
      for (const key of sessions.keys())
        if (!stack.files.has(key)) sessions.delete(key);
      const same = stackId === id && current === path;
      current = path;
      stackId = id;
      if (!same || view.state.doc.toString() !== doc) {
        const cached = sessions.get(path);
        syncing = true;
        view.setState(
          cached?.state.doc.toString() === doc ? cached.state : fresh(doc, path),
        );
        view.scrollDOM.scrollTop =
          cached?.state.doc.toString() === doc ? cached.top : 0;
        syncing = false;
      }
      // Bound session-only undo memory; saved text and drafts remain in workspace state.
      while (sessions.size > 20) {
        const disposable = [...sessions.keys()].find((p) => !openPaths.has(p));
        if (disposable === undefined) break;
        sessions.delete(disposable);
      }
      // A renamed file keeps its session (undo, selection) but takes the mode of its new name.
      if (mode.get(view.state) !== modeFor(path))
        view.dispatch({ effects: mode.reconfigure(modeFor(path)) });
      setBusy(busy);
      setOccurrenceKey(occurrenceEnabled);
      setInvisibles(invisiblesShown);
    },
    command(command) {
      if (busy || !current || view.composing) return;
      command(view);
      view.focus();
    },
    task,
    next: selectNextOccurrence,
    bold,
    focus: () => view.focus(),
  };
}
