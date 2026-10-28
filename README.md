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
- **Keep references visible.** Use the file explorer, search, wiki links, and independent Viewer tabs while editing.
- **Keep your work portable.** Review earlier revisions, restore changes, and export ordinary files or complete TAR/TAR.GZ archives.
- **Link local folders.** On supported desktop Chromium browsers, inspect external changes and explicitly sync individual files back to their source folder.
- **Experiment with AI handoffs.** Package selected context for an AI assistant, inspect proposed changes, and decide what to accept. This optional workflow currently uses manual transfers and is still being evaluated with real models.

## Get started

1. Download [`dist/carbon.html`](dist/carbon.html) using GitHub's **Download raw file** action.
2. Open `carbon.html` in a desktop Chromium-based browser.
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

In a linked folder, **Save** changes Carbon's browser copy. **Refresh from folder** shows external changes without replacing your work. **Sync file to folder** is a separate, explicit operation that checks the source and writes one file after confirmation.

## Beta notes

Carbon is experimental software. Please keep backups of anything important.

- **Browser storage is not a backup.** Export your work regularly. Clearing browser data or changing browser origins can make stored work unavailable.
- **Linked-folder syncing is experimental.** Avoid editing the same source file in another application during Sync. Some concurrent filesystem changes cannot be detected atomically.
- **Browser support varies.** Native linked folders require a supported desktop browser. Mobile and other browser workflows are still undergoing compatibility testing.
- **No automatic cloud sync.** Workspaces are local to their browser storage. Opening Carbon on another device does not automatically transfer your notes.
- **AI handoffs are experimental.** Carbon does not run an AI model or connect directly to an AI provider, and real-model interoperability is not yet established.

See the [user guide](docs/carbon-v1.md), [workspace and persistence guide](docs/virtual-workspace.md), and [linked-folder guide](docs/linked-folders.md) for more details.

## Distribution and verification

This repository's private beta preview contains the standalone Carbon HTML application and its license notices. Source, build scripts and developer tests are maintained separately while the implementation undergoes owner review.

- Download and open `dist/carbon.html` locally; no installation, network access or account is required.
- The published HTML embeds its application JavaScript and styles; distributing this file still makes that bundled code inspectable.
- See `dist/THIRD-PARTY-LICENSES.txt` for embedded dependency notices.

This is a staging preview, not a published release. It has not yet incorporated the latest pending development changes. Keep backups and verify the final reviewed build before wider use.

## Feedback

Found a bug or have an idea? [Open an issue](https://github.com/itscooleric/carbon/issues).

When reporting a problem, include your browser, operating system, the action you were attempting, and whether any data was affected. Do not include private notes or credentials.

## License

MIT. See [LICENSE](LICENSE).
