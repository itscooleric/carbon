# Text files: editing any bounded UTF-8 text

Implementation: `src/carbon/local-files.js` (rules), `src/carbon/editor/view.js` (per-file mode), `src/carbon/ui/editor.js` (Save, preview).

## What opens in the Editor

| Workspace | Editable files |
| --- | --- |
| Scratch, local copies, linked folders | **Any file whose bytes are text**: at most 1 MiB (`LIMITS.text`), no NUL byte anywhere, strict UTF-8 (a BOM is fine). The name does not matter: `.txt`, `.json`, `.yaml`, `.csv`, source files, `README`, `.env.example` and Markdown all qualify. |
| Envoy Stack | Markdown Entries (`.md`) only, as before. Assets keep their bytes and open read-only. |

Everything else stays **read-only**. Opening such a file shows the Asset dialog with the reason (larger than the 1 MiB text editing limit, contains NUL bytes, not valid UTF-8) and **Download Asset** for the exact bytes. The Viewer keeps showing text-like files it can inspect (for example the first 1 MiB of a larger log).

In an ordinary workspace the Assets list no longer repeats editable text files (they are documents in the tree). Remaining text-like files that are too large to edit are tagged `TXT`, binaries `BIN`.

## Markdown is decided by the name

Editing and interpretation are separate. Only a path ending in `.md` is a Markdown document, and only Markdown documents get:

- frontmatter parsing (a YAML file that starts with `---` is plain content),
- the Markdown preview and Viewer rendering,
- wiki links: indexing, `[[` completion, resolution and backlinks (a `[[README]]` never targets a plain text file),
- the Markdown editor mode: syntax highlighting, list continuation, Tab list moves, `*` `_` `~` surround, **Bold** (Ctrl/Cmd+B), **Toggle task** (Alt+C),
- **Insert image**; and, in Stacks, Needlecast selection and Dispatch context (unchanged).

Any other text file opens in the **Text editor** (that is its accessible name): no formatting commands, Enter just starts a new line, paste and drop insert text (image insertion is for Markdown), and the preview pane says "Not a Markdown file, so nothing is rendered" above an inert text view (text nodes, or highlight.js spans sanitized to `span.class` for known languages). While a file is being edited, that preview and a Viewer tab showing its draft highlight only up to 32 KiB so typing stays responsive. HTML, SVG and scripts are shown as text and never run. Palette content search keeps its Markdown scope for now (RFC D10).

Renaming moves a file between modes: `todo.txt` → `todo.md` opens in the Markdown editor with its undo history intact. In an ordinary workspace **Rename** and **New file** accept any safe path (the usual rules still refuse traversal, device names such as `CON.txt`, `.git`, and case-insensitive collisions). A new `.md` file starts from the chosen template without frontmatter; any other new file starts empty. New-file suggestions go to the workspace root unless it already has an Entries directory. Stacks still require `.md` for new and renamed Entries.

## Line endings and BOM

The Editor always shows LF text without a byte-order mark. When a draft becomes bytes, Carbon re-applies the committed file's conventions, measured from its bytes:

| Committed file | Saved bytes |
| --- | --- |
| LF, CRLF or lone CR throughout, with or without a BOM | The same convention and BOM: byte-identical except for your edit |
| No line break at all | Lines you add use LF |
| **Mixed** line endings | **Refused.** Opening the file shows a one-time notice naming the mix (for example "2 CRLF, 1 LF"). Save opens **Mixed line endings**: nothing is saved and the draft is kept; **Download original file** gives the exact bytes; **Save with LF line endings** rewrites every line break as LF this once (a BOM is kept). It is never the default. |

A leading U+FEFF is treated as the byte-order mark: the Editor never shows it, and whether the saved file has one follows the committed file. Save always rebuilds the draft against the file as committed at that moment, so a draft kept across **Take folder version** in a linked folder takes the taken file's BOM and line endings (and is refused if the file now mixes them). Undoing every edit leaves no draft, also in a mixed-ending file.

The previous version stays recoverable in History (every workspace); in a linked folder, a Sync also keeps the previous disk version in `.carbon-history/` when local history is on. In a Stack, an unchanged frontmatter keeps its exact bytes as before; a BOM and lone-CR endings are now kept too, and a mixed-ending Entry follows the same refusal.

**Take folder version** in a linked folder refuses to adopt folder bytes the Editor cannot open while the file has a draft, so the draft never loses its tab. Without a draft it adopts the folder's exact bytes as a new revision (the previous one stays in History), also for a `.md` file: an unreadable file then stays read-only with its reason and Download, like any other. Only Editor saves are held to the text rules; the folder's file, total-size and path limits still apply.

The same guard covers every path that turns a draft into saved bytes: Save / Ctrl+S and saving an Entry from the Dispatch Context step. A draft over 1 MiB or containing NUL is refused with "Text limit or NUL violation"; the draft is kept.

## Inspecting text

Three read-only actions in the **Document** menu (and the palette) make the hidden properties of a file visible on request; ordinary editing stays as quiet as before. Implementation: `src/carbon/text-inspect.js` (pure), `src/carbon/editor/invisibles.js` (view decorations), `src/carbon/ui/editor.js` (dialogs). No new package.

- **Text details…** shows the open file's committed byte length and the 1 MiB editing limit, where those bytes live (Scratch, a local copy or a linked folder's copy in this browser, or a Stack revision; a linked folder's bytes are Carbon's copy, which reaches the folder only through Sync file to folder…), whether a UTF-8 BOM is present, its line-ending convention with the number of line breaks (LF, CRLF or lone CR throughout; mixed with the counts; none), and whether an unsaved draft exists and how many bytes it would save as. That size comes from Save's own rebuild of the draft against the committed bytes as they are now (so a draft kept across Take folder version takes the taken file's BOM and line endings), and a draft Save would refuse (over the limit or containing NUL) is reported as such. The counts of tabs, unusual spaces (NBSP and friends), zero-width characters, bidirectional controls, other controls, Unicode line/paragraph separators, noncharacters, tag characters (U+E0000–E007F, invisible and able to carry hidden ASCII text), other invisible format and filler characters (such as U+2062 INVISIBLE TIMES or U+3164 HANGUL FILLER), lone surrogates and lines ending in whitespace are measured on the text the Editor shows (the draft, else the committed text); a warning names the invisible or direction-changing ones. The committed bytes are always reported apart from the draft, and a browser-stored file is never described as being on disk.
- **Show invisibles** (off by default, session-local) marks spaces `·`, tabs `→`, unusual spaces `⍽`, trailing whitespace (dashed outline) and line ends. The line-end glyph is the **committed file's** convention, not something read from the LF-normalized draft: `␊` for LF (and for a file without line breaks, which will get LF), `␍␊` for CRLF, `␍` for lone CR and `¶` for a mixed file, each with a tooltip saying so. Markers are CodeMirror view decorations outside the document: they are never saved, copied, exported, searched or part of undo, and only the visible lines are decorated, so a 1 MiB file stays responsive. CodeMirror always shows a placeholder for some invisible characters (ZWSP, LRM/RLM, LRO/RLO, LRI/RLI/PDI, ALM, soft hyphen, BOM and C0/C1 controls), but not for ZWNJ/ZWJ, the word joiner, LRE/RLE/PDF, FSI, tag characters or the other flagged invisibles; Show invisibles adds a placeholder (with the code point in its tooltip) for those as well. The placeholders are display only too. While the option is on, emoji built with ZWJ show their parts and a placeholder; with it off they render normally.
- **Inspect characters…** lists the Unicode code points at the cursor (the next character, or the previous one at the end) or in the selection, by code point rather than UTF-16 unit (an emoji is one row). Each row gives `U+XXXX`, the character when printable, a name for well-known whitespace, control and format characters, and a note; zero-width, bidirectional, control, separator, tag, other invisible and noncharacter code points (noncharacters are valid code points reserved for internal use, not intended for open interchange) and lone surrogates carry a ⚠ warning. A tag character's note also gives the ASCII character it stands for, so hidden tag text can be read. Variation selectors (such as U+FE0F in emoji) are not flagged. Carbon bundles no Unicode name database, so other characters show `(no name data bundled)` rather than an invented name. Long selections list the first 64 code points and state the total.

**Find / Replace** (regex, case, replace one/all) is deferred to a separate increment: the already-installed `@codemirror/search` panel measured 15-19 KB of additional bundled JavaScript, more than the offline-build budget left after this slice.

## Linked folders

In a linked folder Save keeps the text file in Carbon's copy with its conventions, exactly like a local copy, and writes nothing to the folder; **Sync file to folder…** later writes the saved bytes as they are ([linked-folders.md](linked-folders.md)). A mixed-ending file reaches the folder only after the explicit **Save with LF line endings** and a Sync. Creating, renaming and deleting files are ordinary virtual changes there.

## Limitations

- Only UTF-8 is supported. UTF-16, Latin-1 and other encodings are read-only.
- Mixed line endings can be edited but are saved only as LF. Exact preservation of independently mixed line endings after editing is not implemented.
- The Editor indents with spaces; files that need tab characters (for example a Makefile) can be edited, but Tab inserts spaces.
- Palette content search covers Markdown only; file names of every type are matched by the tree filter.
- Physical-device, Firefox and Safari behaviour is not covered by the automated suite; the inspection dialogs and markers were exercised in Chromium at a 390×844 touch viewport only.
- Find / Replace with regular expressions is not part of this slice (see Inspecting text).

## Tests

`tests/text-files.test.js` (rules, round trips for LF/CRLF/CR with and without BOM, mixed refusal, Stack frontmatter, naming, linked Save and Sync) and `tests/text-files-browser.mjs` (real `file://` page: every text type, inert previews, no Markdown commands in plain text, byte-exact saves, mixed refusal and explicit LF, read-only reasons and downloads, failed save keeps the draft across reload, new file and rename across modes, Scratch, strict Stack). `tests/linked-browser.mjs` adds the linked plain-text case (byte-exact Save in Carbon, then Sync through consent and backup; a mixed file reaches the folder only after the explicit LF choice). `tests/text-inspect.test.js` and `tests/text-inspect-browser.mjs` cover the inspector: code points by code point with targeted flags, bounded listing, committed-versus-draft details for BOM and every line-ending convention and unreadable bytes, display-only markers (document, draft, revision, copy and exact export unchanged), per-file line-end glyphs, the palette entries and a phone-sized viewport.
