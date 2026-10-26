# Cast and staged Return v0.1

Draft identifiers: `envoy.cast/v0.1`, `envoy.return/v0.1`,
`envoy.operating/v0.1`. These are separate from Stack/handoff v0.2.

## Design decision

A Cast is a YAML sidecar to an existing selected Needlecast packet or full Stack.
It is an assignment, not a new Entry kind. Its Stack ID/revision and dispatch ID are
necessary references; title, manifest contents and omission inventory remain in the
Stack/Needlecast context. A Cast can be archived as an ordinary Asset, but contains
no privileged hooks. No fixed role or task-type enumeration is required.

The Return is a staged-output envelope with YAML receipt metadata and exact raw
Markdown frames. It proposes create/replace/delete/rename transactions. It never
claims to be a complete Stack. This enables reports and new Entities without
changing the meaning of an existing v0.2 Return.

## Cast schema

All fields below are required. Unknown keys and versions fail closed.

| Field | Meaning |
|---|---|
| format / contract / return_format | Exact version identifiers above |
| assignment_id / dispatch_id | Stable assignment and original dispatch identifiers |
| stack_id / base_revision | Original Stack ID and nonnegative safe integer revision |
| mission | Accessible Mission path or null |
| objective | One nonempty objective; custom tasks allowed |
| read | Exact included paths, including `stack.yaml`; no globbing |
| replace / create / delete | Separate exact Markdown path allowlists |
| rename | List of `[from, to]` pairs, both Markdown paths |
| playbooks | Ordered `{name, source, content}` documents, complete Markdown embedded |
| metadata | Optional permissions as required list: `{path, keys}` for existing scalar fields |
| assets | Exact selected non-Entry paths; actual attachments required |
| required_files | Exact create/replace paths that a complete Return must supply; empty for answers |
| outputs / completion | Human-readable deliverables and nonempty completion criteria |
| constraints | Nonempty-string list; may be empty |
| permissions | `network`, `execute`, `write_files` booleans; `transmit_to` destination strings |

Replacement/deletion/rename sources must be readable. New targets must not already
exist in the original full inventory. The host separately approves data selection
and transmission; YAML is not a credential. Changing a Cast requires a deliberate
user-authorized redispatch. It cannot be supplied by the returning model as authority.

## Receipt schema

Return identity fields repeat the Cast references. Required `checkpoint_id` and
nullable `parent_checkpoint` track proposed continuity. Required `status` is
`complete`, `partial`, `blocked`, `failed` or `cancelled`. `summary` and `objective`
are nonempty strings. The objective must match the Cast exactly.

Required lists of strings: `accepted`, `evidence`, `decisions`, `completed`,
`questions`, `blockers`, `next`, `verification`, `errors`, `capabilities`, and
`operations_performed`. Empty lists are legitimate. Evidence strings should name
source, locator, observation date where relevant, claim and confidence/limitation.
`complete` requires some verification and empty questions/blockers/errors. This is
structural consistency, not independent verification of the claim.

`creates`, `replaces`, `deletes` are path lists. `renames` is a list of pairs.
A path cannot participate in multiple operations in one Return. Renames preserve
file bytes and stable IDs. No combined rename-and-edit in v0.1; use a later Cast.
New files must have a stable frontmatter ID; replacements preserve exact raw
frontmatter except explicitly authorized existing scalar fields in `metadata`.
Stable IDs, unknown keys and comments remain protected. Arbitrary new binaries,
manifest edits, new/nested metadata keys and metadata reformatting are unsupported.

## Exact framing

A packet starts with `# Envoy Cast Return`, two LF bytes, a fenced `yaml` metadata
block and a blank line. `boundary` is 16–100 ASCII letters, digits or hyphens, absent
from every body. File frames follow in `creates` order then `replaces` order:

```text
<!-- envoy-cast:file boundary="BOUNDARY" path="ENCODED_PATH" -->
BODY<one framing LF>
<!-- envoy-cast:end boundary="BOUNDARY" -->
<one blank line>
```

Use canonical JavaScript `encodeURIComponent(path)` for the marker path. The body
starts after the begin marker's LF; exactly one framing LF before the end marker
is removed. CRLF in bodies, no terminal newline and multiple terminal newlines are
preserved. Headers/markers must use LF. No normalization, automatic repair, extra
frames, prose, outer fences or trailing content are accepted.

The final required line is:

```text
<!-- envoy-cast:complete boundary="BOUNDARY" files="N" -->
```

It has one final LF. N is the number of created/replaced files. A missing end frame,
missing file, reordered/duplicate frame, missing footer or trailing text fails.
This detects structural truncation. It cannot detect a model that emits a shortened
body and a syntactically correct footer, or intentionally omits an unlisted promised
output. Deliverable/completion review is mandatory; checksums invented by a model
would not fix that limitation.

## Trust and limits

The trusted dispatch retains the user-authorized Cast and original selected bytes.
The full host additionally retains every base file byte and directory. Acceptance
compares the full current Stack to this snapshot, even if its revision number was
not changed. Partial workbench validation cannot check omitted IDs/bytes and never
accepts a full Stack. Registering an original packet in another host is explicit;
never bootstrap trust from a returned packet alone.

The parser uses YAML 1.2 with duplicate keys, aliases, anchors, tags, merge keys,
complex keys and prototype-related keys rejected. Limits: 4 MiB packet, 1 MiB per
text file, 64 KiB metadata, 2,000 inventory entries, 100 operation endpoints, 24 YAML
levels/10,000 nodes, 32 path levels/1,024 UTF-8 path bytes. Portable path validation
rejects absolute/drive/UNC/traversal/control/bidi/reserved names, Unicode normalization
ambiguity, case and file/directory collisions. Full-host directory and Stack resource
checks remain Carbon's responsibility.

Unsupported major/minor identifiers and unknown required semantics are rejected.
Old Carbon expects `# Envoy Handoff` and `envoy.handoff/v0.2`; it rejects a Cast Return
at the header. Never relabel this envelope as v0.2 to force import. A Cast Return
saved as an ordinary note is only source data, not an accepted transaction.
