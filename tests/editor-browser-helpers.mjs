/** Test-only bridge through CodeMirror's public API; never included in the app build. */
import { bundle } from "../scripts/build.mjs";
const bridge = await bundle({
  stdin: {
    contents:
      'import {EditorView} from "@codemirror/view"; globalThis.carbonTestView = () => EditorView.findFromDOM(document.querySelector("#editor .cm-editor")); globalThis.carbonTestSelect = ranges => { const view = carbonTestView(), Selection = view.state.selection.constructor; view.dispatch({selection: Selection.create(ranges.map(([a,b]) => Selection.range(a,b ?? a)))}); };',
    resolveDir: process.cwd(),
    loader: "js",
  },
});
export async function editorView(page) {
  if (
    !(await page.evaluate(
      () => typeof globalThis.carbonTestView === "function",
    ))
  )
    await page.evaluate(bridge);
}
export async function editorText(page) {
  await editorView(page);
  return page.evaluate(() => carbonTestView().state.doc.toString());
}
export async function fillEditor(page, text) {
  await editorView(page);
  await page.locator("#editor .cm-content").fill(text);
  try {
    await page.waitForFunction(
      (expected) => carbonTestView().state.doc.toString() === expected,
      text.replace(/\r\n?/g, "\n"),
      { timeout: 5000 },
    );
  } catch (error) {
    throw Error(
      `Editor fill expected ${JSON.stringify(text)}; actual ${JSON.stringify(await editorText(page))}`,
      { cause: error },
    );
  }
}
