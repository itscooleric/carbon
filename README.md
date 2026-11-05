# Carbon

```text
   ██████╗ █████╗ ██████╗ ██████╗  ██████╗ ███╗   ██╗
  ██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔═══██╗████╗  ██║
  ██║     ███████║██████╔╝██████╔╝██║   ██║██╔██╗ ██║
  ██║     ██╔══██║██╔══██╗██╔══██╗██║   ██║██║╚██╗██║
  ╚██████╗██║  ██║██║  ██║██████╔╝╚██████╔╝██║ ╚████║
   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝ ╚═╝  ╚═══╝

  markdown-first notebook                 PRIVATE BETA
  ------------------------------------------------------

             +--------------------------------+
             |             CARBON             |
             |  Scratch  Notes  Files         |
             |  History  Editor  Viewer       |
             +----------------+---------------+
                              |
                      saved in browser
                              |
                  +-----------+-----------+
                  |                       |
                  v                       v
            Export files              Sync file
             .md / .tar             linked folder

  ------------------------------------------------------
  one HTML file  ·  works offline  ·  no account needed
```

**A notebook for your notes, files, and ideas.**

Carbon is a lightweight, Markdown-first workspace that runs entirely in your browser. Write notes, organize files, inspect references, keep revisions, and export your work in portable formats.

No server, account, or AI subscription is required. Download one HTML file and start writing.

## Features

- **Write freely.** Edit Markdown and ordinary text files, including `.txt`, `.json`, `.yaml`, and other supported UTF-8 files. Preserve line endings and byte-order marks.
- **Work in independent spaces.** Start immediately in Scratch, or open files and folders as separate workspaces with their own notes, drafts, and history.
- **Keep references visible.** Use the file explorer, search, wiki links, independent Viewer tabs, and Find/Replace (including regex, match-case and whole-word options) while editing.
- **Keep your work portable.** Review earlier revisions, restore changes, and export ordinary files or complete TAR/TAR.GZ archives.
- **Link local folders.** On supported desktop Chromium browsers, inspect external changes and explicitly sync individual files back to their source folder. After a failed new-file Sync leaves an empty placeholder, Carbon offers an explicit **Sync into empty placeholder** action with conflict checks; it does not silently delete the file.
- **Experiment with AI handoffs.** Package selected context for an AI assistant, download a Dispatch as TAR/TAR.GZ (including re-download), inspect proposed changes, and decide what to accept. Plan/Report Returns omit unchanged entries by default; you can explicitly require every replaceable entry. Invalid Returns offer a repair prompt. This manual-transfer workflow is still being evaluated with real models.
- **Try local-only voice notes (experimental).** On supported desktop browsers (Chrome/Edge 139+), install the browser's on-device language pack on demand, dictate, review the transcript, then explicitly insert it into the current Markdown note. Unsupported browsers report why. Carbon never silently switches to cloud transcription.

## Get started

1. Download [`dist/carbon.html`](dist/carbon.html) using GitHub's **Download raw file** action.
2. Open `carbon.html` in a desktop Chromium-based browser (Chrome or Edge is recommended for experimental on-device voice).
3. Carbon opens in **Scratch**, with a note ready for you to edit.
4. Write something and press **Ctrl+S** (or **Cmd+S**) to save it in Carbon's browser workspace.
5. Use **Download file** or **Export files** to keep a copy outside your browser.

That's it. No installation or build process is needed to use the downloaded application.

### Working with folders

Carbon offers two distinct workflows:

| Mode | Behavior |
|---|---|
| **Import folder as local copy** | Read files into an independent workspace. The original folder stays unchanged. |
| **Open folder (linked)** | Keep a browser working copy connected to a local folder, where supported. |

In a linked folder, **Save** changes Carbon's browser copy. **Refresh from folder** shows external changes without replacing your work. **Sync file to folder** is a separate, explicit operation that checks the source and writes one file after confirmation. If an attempted Sync of a *new* file leaves an empty placeholder, **Sync into empty placeholder** requires another explicit click and verifies it is still empty before writing; when it has changed, Carbon refuses and preserves both copies. External programs can still race at the final filesystem commit, so do not edit the same file simultaneously in another program.

## Beta notes

Carbon is experimental software. Please keep backups of anything important.

- **Browser storage is not a backup.** Export your work regularly. Clearing browser data or changing browser origins can make stored work unavailable.
- **Linked-folder syncing is experimental.** Avoid editing the same source file in another application during Sync. Some concurrent filesystem changes cannot be detected atomically.
- **Browser support varies.** Native linked folders require a supported desktop browser. Mobile and other browser workflows are still undergoing compatibility testing.
- **No automatic cloud sync.** Workspaces are local to their browser storage. Opening Carbon on another device does not automatically transfer your notes.
- **AI handoffs are experimental.** Carbon does not run an AI model or connect directly to an AI provider, and real-model interoperability is not yet established.
- **Voice is experimental and local-only.** Browser support depends on the on-device Web Speech API and locally available language packs. Desktop Chrome/Edge 139+ is the documented primary target; Firefox 160 support was still beta at this build's review. Real physical microphone recognition has not been verified for this build, and phone in-app voice is not currently supported. You can use your phone's keyboard dictation instead.

Internal maintainers can consult the more detailed guides in the private [Envoy development repository](https://github.com/itscooleric/envoy/tree/main/docs). Those development documents are intentionally not part of this distribution-only preview.

## Distribution and verification

This repository's **private** beta preview contains the standalone Carbon HTML application and its license notices. The source tree, build scripts, test suites, and development history remain in the separate private Envoy repository.

- Download and open `dist/carbon.html` locally; no installation, network access or account is required.
- The published HTML embeds its application JavaScript and styles; distributing this file still makes that bundled code inspectable.
- See `dist/THIRD-PARTY-LICENSES.txt` for embedded dependency notices.

**Build provenance:** `dist/carbon.html` is a private preview of reviewed Carbon vNext (`93a33e5`) plus the **block-before-C favicon** from [Envoy PR #54](https://github.com/itscooleric/envoy/pull/54). Exact Git blob SHA: `69d464ad369996107390838907d0fdafa42df3e2`. The reviewed base passed Carbon and Cast Kit CI; this favicon follow-up has passed unit, build and reproducibility checks, with browser CI still in progress at the time of staging. Download the HTML to test its tab/shortcut icon. This is for owner testing, **not** an announcement, visibility change or public release. Keep backups and test in a disposable workspace before relying on it.

## Feedback

Found a bug or have an idea? [Open an issue](https://github.com/itscooleric/carbon/issues).

When reporting a problem, include your browser, operating system, the action you were attempting, and whether any data was affected. Do not include private notes or credentials.

## License

MIT. See [LICENSE](LICENSE).
