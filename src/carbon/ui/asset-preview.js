import { inspectAsset, canHighlight, ASSET_PREVIEW_LIMIT } from "../asset-data.js";
import { highlightHtml } from "../highlight.js";
import { LIMITS } from "../../core/validate.js";
import { el } from "./dom.js";

const LABELS = {
  python: "Python", javascript: "JavaScript", bash: "Shell", yaml: "YAML", json: "JSON",
  typescript: "TypeScript", xml: "HTML/XML", css: "CSS", ini: "INI/TOML", sql: "SQL",
};

/** Text re-rendered while it is edited is highlighted only up to this size, so typing stays responsive. */
export const LIVE_HIGHLIGHT_LIMIT = 32 * 1024;

/**
 * Read-only source with a line-number gutter. Highlighting is skipped above 256 KiB (of bytes, not
 * UTF-16 units), or above `LIVE_HIGHLIGHT_LIMIT` for text that is re-rendered while it is edited.
 */
function codePreview(container, path, data, download, editing, live) {
  // Lone-CR files would otherwise show as one line: CSS does not break lines at CR.
  const source = data.source.replace(/\r\n?/g, "\n");
  const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0) || 1;
  const limit = live ? LIVE_HIGHLIGHT_LIMIT : ASSET_PREVIEW_LIMIT;
  const highlight = canHighlight(data) && data.size <= limit;
  const notes = [
    LABELS[data.language] ?? "Plain text",
    `${lines} ${lines === 1 ? "line" : "lines"}`,
    editing ? "preview of the text in the Editor" : "read-only source",
  ];
  if (data.language && !highlight) notes.push(`highlighting skipped above ${limit / 1024} KiB${live ? " while editing" : ""}`);
  container.append(el("p", notes.join(" · ") + ".", "hint"));
  if (data.truncated) {
    const note = el("p", `Truncated: showing the first ${LIMITS.text / 1024 ** 2} MiB of ${(data.size / 1024 ** 2).toFixed(1)} MiB.`, "hint truncated");
    if (download) {
      const button = el("button", "Download full file");
      button.type = "button";
      button.onclick = download;
      note.append(" ", button);
    }
    container.append(note);
  }
  const region = el("div", undefined, "asset-preview code-preview");
  region.tabIndex = 0;
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", `${path.split("/").pop()} source`);
  const gutter = el("pre", Array.from({ length: lines }, (_, i) => i + 1).join("\n"), "code-gutter");
  gutter.setAttribute("aria-hidden", "true");
  const body = el("pre", undefined, "code-body"),
    code = el("code");
  const html = highlight ? highlightHtml(source, data.language, window) : null;
  if (html === null) code.textContent = source;
  else code.innerHTML = html;
  body.append(code);
  region.append(gutter, body);
  container.append(region);
}

/**
 * @param {HTMLElement} container
 * @param {string} path
 * @param {Uint8Array} bytes
 * @param {{download?: () => void, editing?: boolean, live?: boolean}} [options] `download` is offered when the
 *   preview is truncated; `editing` labels the view as a preview of the file open in the Editor rather than
 *   read-only source (and implies `live`); `live` marks text re-rendered while it is edited (lower highlighting cap)
 */
export function assetPreview(container, path, bytes, { download, editing = false, live = editing } = {}) {
  const data = inspectAsset(path, bytes);
  if (!data) return;
  if (data.error) {
    container.append(el("p", editing && bytes.length > ASSET_PREVIEW_LIMIT ? "Preview limited to 256 KiB; the Editor shows the whole file." : data.error));
    return;
  }
  if (data.type === "code") return codePreview(container, path, data, download, editing, live);
  const region = el("div", undefined, "asset-preview");
  region.tabIndex = 0;
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", `${data.type.toUpperCase()} preview`);
  if (data.type === "json" || data.type === "text") {
    container.append(
      el(
        "p",
        data.type === "json"
          ? `Valid JSON · ${editing ? "preview of the text in the Editor" : "read-only source"} (number precision and duplicate keys preserved).`
          : `Plain text · ${editing ? "preview of the text in the Editor" : "read-only source"}.`,
        "hint",
      ),
    );
    region.append(el("pre", data.source.replace(/\r\n?/g, "\n")));
  } else {
    container.append(
      el(
        "p",
        `${data.totalRows} rows · ${editing ? "CSV preview of the text in the Editor" : "read-only CSV"}. First row is shown as data. ${data.truncated ? "Showing at most 200 rows and 50 columns." : ""}`,
        "hint",
      ),
    );
    const table = el("table"),
      body = el("tbody");
    table.append(el("caption", path), body);
    for (const [n, cells] of data.rows.entries()) {
      const tr = el("tr"),
        number = el("th", String(n + 1));
      number.scope = "row";
      tr.append(number, ...cells.map((cell) => el("td", cell)));
      body.append(tr);
    }
    region.append(table);
  }
  container.append(region);
}
