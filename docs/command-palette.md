# Carbon unified command palette

This is a separate, post-release increment stacked on editor ergonomics PR #11 at `2f02a6b0d91beff10e1d64fc7c33f390e96610f7`. Its draft PR targets `feat/carbon-editor-ergonomics` until #11 merges; then retarget to `dev` and verify the resulting tree. It does not change the editor adapter/ergonomics modules, release promotion PR #10, or the product name.

## Using the palette

Open **Search / commands** in the header, or press **Ctrl/Cmd+Shift+P**. The palette searches only the active Stack. It opens as a native modal dialog with a labeled search input and visible Close button. Escape returns focus to the invoking control without changing the editor selection, draft or scroll position. Ordinary Tab navigation stays inside the modal until it closes; arrow keys move through visible results. Enter activates a result or expands a document's excerpts. Left/Right collapse/expand a focused document heading. Pressing the launcher shortcut again focuses the query.

Results appear in this order:

1. **Commands** — Go to Entry, Toggle Preview and registered template commands.
2. **Entries** — titles, filenames, full paths and committed stable IDs. Exact matches rank ahead of prefixes, then substrings. Titles use current draft metadata when valid, otherwise committed metadata; the first document-level Markdown H1 is the fallback (excluding code, HTML blocks and quoted headings).
3. **Entities** — labels/targets from existing committed wiki links, resolved with Carbon's current resolver in the referring Entry's context. Labels resolving to multiple destinations and unresolved/ambiguous targets are omitted. An explicit Entry path remains searchable. There is no new entity database or YAML alias interpretation.
4. **Content** — one group per matching Markdown document, with an exact occurrence count. Expand it for highlighted excerpts; selecting an excerpt navigates to that occurrence.

Search is a literal, case-insensitive substring/phrase match, up to 256 UTF-16 code units. Punctuation and boundary whitespace in nonempty queries are literal, not regular-expression syntax. All-whitespace queries are treated as empty. It is not fuzzy search or a token-query language. Full text includes frontmatter, Markdown and code, using unsaved drafts in place of saved text. Assets are outside this increment. An empty query lists commands and Entries; an unmatched query gives a clear empty state.

**Go to Entry** temporarily filters the open palette to Entry metadata; **Search all types** returns to unified results. Reopening the palette starts in unified mode. **Toggle Preview** uses the existing preview action. Navigation preserves sidebar filter text, selected Dispatch context, folder disclosure state and scroll position; an overlay or Dispatch drawer closes when needed to reveal the destination.

## Exact navigation and editor ownership

Search offsets refer to the same LF-normalized source CodeMirror displays (without a byte-order mark), including for saved CRLF or BOM-prefixed Entries and Unicode text. Before navigating an excerpt, Carbon verifies the Stack and source still match the search snapshot. A stale result asks for a fresh search instead of navigating to an incorrect offset.

The destination opens through Carbon's existing Entry navigation and editor session cache. If only Preview is visible, excerpt navigation switches to Editor. A separate palette bridge uses CodeMirror's public selection, scroll and view-decoration APIs. The passage is underlined and highlighted for five seconds; editing or switching Entry also clears the decoration. Highlights are view-local and cannot survive in cached Entry history. They never insert markup, save a draft, or create a Stack revision.

Canceling the palette leaves editor state untouched. Choosing a passage intentionally moves the caret to its start. Existing per-Entry undo/redo, draft persistence and the editor's 20-session history-cache limit remain in force. No editor/viewer tabs or browser URL/history routes are introduced.

## Reusable template commands

Template commands are data registrations handled outside search logic. With no Stack configuration, **Open Today's Log** uses the existing `builtin:note` template and opens or creates `entries/logbook/{{date}}.md`. The date is the browser's local calendar date at activation, formatted `YYYY-MM-DD`. Repeated activation opens the existing Entry and preserves any unsaved draft; it never overwrites that Entry or creates another revision.

An optional `templates/commands.yaml` in the Stack replaces these defaults. An empty `commands: []` disables template commands. For example:

```yaml
commands:
  - id: today-log
    label: Open Today's Log
    template: templates/log.md
    path: entries/logbook/{{date}}.md
    title: Log {{date}}
  - id: annual-plan
    label: Open Annual Plan
    template: builtin:research
    path: entries/plans/{{year}}.md
    title: Plan {{year}}
```

Each registration needs a unique lowercase `id`, `label`, `template`, target `path` and `title`. Up to 50 registrations are supported. Each result visibly includes its template ID and target path, so repeated labels (including labels shared with built-in commands) remain distinguishable. `template` names an existing Stack Markdown Entry or `builtin:<kind>` from Carbon's bundled templates. An unsaved template draft is used if present; invalid template metadata fails visibly. Stack configuration is committed YAML, using the existing bounded, safe YAML parser. It cannot load scripts, network resources or functions.

Paths/titles accept `{{date}}`, `{{year}}`, `{{month}}` and `{{day}}`. Template bodies also accept `{{title}}`. Unknown variables fail visibly. The first document-level H1 becomes the registered title; code/HTML examples are preserved. New output gets a new stable Entry ID and title while retaining other template metadata and comments. Creation uses the existing path/collision and Stack validators, then an atomic IndexedDB-first commit with one History snapshot. Other drafts and selected context remain untouched. Failed persistence leaves the Stack and current Entry unchanged. An existing target is opened directly even if its original template is no longer present.

Configuration errors disable template registrations for that opening and appear in the palette status; Entry/content search and core commands remain available. These files are optional ordinary Stack assets, with no format migration.

## Bounds and accessibility

The index is a temporary snapshot built on each opening and discarded on the next opening. Query work yields to the browser in batches; a newer query or closing the palette invalidates older results. The existing limits remain 1 MiB per Markdown Entry and 32 MiB total Stack files. Occurrence counting scans the complete Entry, retaining only a small page of offsets. Dense-match scans yield after every 2,048 matches. Groups render 40 documents/results at a time, with Show more; excerpts initially show five occurrences and add 20 at a time. All occurrences remain reachable.

Entity labels are bounded to 5,000 distinct names. Later references to retained names still participate in ambiguity detection. When the limit is reached the UI says so; Entry and full-text searches remain complete. A cold shared resolver index yields per bounded Entry and per 256 backlink targets; cancellation never publishes a partial index. Large-Stack indexing still does bounded synchronous work per Entry; physical low-memory Android performance at the maximum Stack size remains unverified.

All untrusted labels and excerpts use text nodes; highlights use inert `mark` elements. Existing theme variables provide contrast, focus outlines and an underline cue independent of color. Touch controls are at least 44px tall, the search input uses 16px text, and the dialog fits a dynamic mobile viewport. No animation, fonts, runtime network access, dependency changes or CSP relaxation are added.

## Verification and remaining acceptance

Focused unit tests cover ranking, entities/ambiguity, draft metadata, literal Unicode/CRLF offsets, dense counts, pagination/cancellation, reusable templates, unsafe YAML/paths and collisions. Offline browser regressions cover desktop and Android-style touch viewports, actual shortcuts and controls, keyboard/Escape behavior, grouped excerpts, exact navigation, temporary highlights, undo/redo, saved draft recovery, stale-offset rejection and failed/successful/repeated template commits. The complete Carbon regression suite also runs.

**Physical Android Chrome acceptance is not claimed.** Verify the launcher and Close controls with the software keyboard visible; Gboard/Samsung composition and autocorrect; selection handles; screen rotation and keyboard show/hide; external-keyboard shortcuts; screen-reader focus/announcements; and representative large Stacks on the real device. Firefox/Safari and OS-reserved shortcut behavior also remain manual acceptance; the visible launcher is always available.

Primary API references: [CodeMirror decorations](https://codemirror.net/examples/decoration/), [CodeMirror reference](https://codemirror.net/docs/ref/), and [W3C native modal-dialog guidance](https://www.w3.org/WAI/WCAG22/Techniques/html/H102).
