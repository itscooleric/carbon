# Dispatch wizard and Playbooks v0.1

Draft, 2026-10-19. Dispatch prepares an assignment for transfer through Needlecast.
Stack holds persistent files and knowledge; Mission is an optional continuing
objective; Cast bounds one assignment; Return carries results and proposals.
Playbooks are optional Markdown documents, not a mandatory new agent role or runtime.

## Minimal wizard

Use five short steps with Back/Next and a final review. Keep protocol details in an
expandable inspection view. A one-off answer can use no Mission and no editable paths.

| Step | User-facing choices | Core result |
|---|---|---|
| Assignment | Task/question, optional Mission, completion criteria | Objective, Mission path or null, criteria |
| Context | Relevant Entries and optional Assets; included/omitted preview | Exact read list, selected Asset paths, original Needlecast packet |
| Playbooks | Select built-in, Stack or imported Markdown; preview; move up/down | Ordered complete instruction contents |
| Deliverables | Answer, update plan/notes, new report/Entry, structured findings | Output descriptions and exact create/replace permissions |
| Export | Target capabilities; review handling/selection; copy or download | Cast, bootstrap, contract, context, Return template; optional selected archive |

Advanced controls expose metadata fields, deletion and rename proposals. All default
to off. Suggest unique output names, but show exact resolved paths before dispatch.
Conversational answers use receipt `summary` and evidence lists with empty operations;
large answers should be complete report Entries. “Structured findings” can be a
Markdown table; a provider-specific JSON schema is optional transport.

The user approves selected instruction documents and data transfer separately from
accepting returned changes. Export is a local download/copy action; no automatic
provider call or upload is implemented. A destination's ability to accept files does
not establish authority to send them.

## Playbook convention

A Playbook is UTF-8 Markdown with optional YAML frontmatter, for example `title` and
`version`. No mandatory ID, kind, folder, provider syntax, executable hook or plugin
manifest. Users can import or edit the whole document. Existing Stack documents are
source data until explicitly selected as Playbooks for this Cast.

`Cast.playbooks` is an ordered list of `{name, source, content}`. Name is unique within
the Cast, source is a provenance label (not a URL to fetch), and content contains the
complete selected Markdown, including frontmatter. The list order is the user's
visible composition order and must survive export/import unchanged. Built-in
Playbooks are copied into the Cast at dispatch time; later local edits cannot change
an already dispatched assignment. Limits: eight Playbooks, 16 KiB each, total Cast
metadata still limited to 64 KiB. This bounded choice favors small context windows.

Authority order: host requirements and user assignment; operating safety contract
and Cast scope; selected Playbooks; source data. A Playbook can guide method and
presentation but cannot grant new paths, tools or transmission permissions. Process
Playbooks in listed order. Later presentation preferences may refine earlier ones;
material conflicts in task, evidence rules or permissions require clarification.
Ordering does not make semantic conflicts mechanically decidable. Do not follow
unselected instructions or nested “include” references automatically.

Starter Playbooks: Research, Planning, Investigation, Report generation, Critical
review and Entity reconciliation. They are composable, optional examples.

## Packaging by actual capability

| Environment | Export | Limitations and fallback |
|---|---|---|
| Pasted text only | One `dispatch.md` with full contract, Cast/Playbooks, selected text and Return template | Binary selection must be removed or capability changed; complete files must fit |
| Attachments/downloads | Same text packet or individual package files; selected Asset attachments | Confirm files can actually be inspected and returned; otherwise paste text |
| Tool-enabled | Selected package or full Stack plus Cast | Tools stay separately authorized; retain a portable Return/checkpoint |
| Small local model | Smaller selection, one/few short Playbooks, smaller deliverables | Reduce assignment rather than truncate files or accepted context |
| TAR-capable AI | Selected `.dispatch.tar`, or separately labeled complete `.stack.tar` | Verify extraction/read capability; these packages are not interchangeable |

The selected archive has root `envoy-dispatch/` and `dispatch.yaml` declaring
`format: envoy.dispatch/v0.1`, `complete_stack: false`, assignment references,
Playbook order, included package file names, Asset mappings and omitted paths.
`files` lists every package file, including `dispatch.yaml` itself, and exactly
matches the archive members under `envoy-dispatch/`.
There is **no root stack.yaml**. The original manifest is text inside the selected
Needlecast packet. Asset bytes live at generated package paths (`assets/0001.bin`,
…), numbered in the validated Cast `assets` order and mapped to original
Stack paths in `dispatch.yaml`; the Markdown handoff still correctly lists them as
omitted from its text projection. The package is an export wrapper, not another
persistent domain object. Its README explicitly forbids replacing a full Stack.

The prototype composes package files and deterministic ustar, with bounded generated
ASCII archive paths. It does not import arbitrary Dispatch archives. Carbon must
route `dispatch.yaml` packages to assignment inspection, never Stack replacement.
Unknown wrapper versions fail closed. The original full Stack remains the only
source for omitted bytes. A model returning a complete Stack still needs transaction
reconciliation against the exact original before any acceptance.

## New reports, plan updates and metadata

Create allowlists identify exact new `.md` paths. Returns include complete content
and new unique IDs. Replacements retain the existing ID and default to identical
raw frontmatter. `Cast.metadata` can authorize specified **existing scalar** fields
at specified replacement paths; for example `status` or `title`. The supplied helper
patches only the scalar source span, preserving comments and unknown metadata.
The prototype uses JSON scalar spelling (quoted strings) for permitted value edits.
Adding/removing fields, nested metadata changes, reformatting other frontmatter,
changing `id`, and manifest edits remain unsupported. Plan body edits need no
metadata permission. Deletions and renames have separate exact allowlists.

A Return cannot expand these lists. The host validates against its saved Cast,
checks the current full Stack byte-for-byte, previews every change and records one
revision after user acceptance. Evidence and completion remain review obligations.

## Planning continuity example

1. Create a plan Entry with accepted context, alternatives and pending research.
2. Dispatch Research + Planning Playbooks, selected source notes and the plan. Permit
   one report path and plan replacement; optionally allow `status` change.
3. Receive a complete report and updated plan with source references and unknowns.
4. Review, accept, save receipt and export revision 5. Preserve revision 4 and Assets.
5. Create a new Cast at revision 5, selecting the accepted report and plan, for a
   narrower investigation. A blocked Return can still contain useful proposed notes.
6. After review/acceptance at revision 6, supply a fresh Cast/context and selected
   Playbooks to an unrelated chat. Accepted decisions, source IDs and pending license
   evidence remain in the files. No old conversation is required.

This is exercised by `tests/carbon.integration.mjs`; provider behavior is simulated.
The Carbon wizard itself is a separate UI milestone described in
[carbon-integration.md](carbon-integration.md).
