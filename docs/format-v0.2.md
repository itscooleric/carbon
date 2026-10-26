# Envoy Stack format — v0.2 draft

The normative intent is detailed in [the architecture document](architecture-v0.2-draft.md). This shorter contract is subject to revision until G1 implementation and interoperability tests.

## Stack
- A Stack is a logical directory with required `stack.yaml` at its root.
- Required YAML fields: `format: envoy.stack/v0.2`, stable `id`, nonnegative integer `revision`.
- `entrypoint`, `title`, `handling` and other fields are optional. Preserve unknown fields and YAML comments on edits.
- Entries may be any Markdown; **managed Entries** use YAML frontmatter containing a stable `id`. `kind` is optional.
- Assets are arbitrary non-Entry files; directories are user-defined.

## Full archive
- `.stack.tar` and `.stack.tar.gz` contain exactly one Stack root directory.
- Write interoperable POSIX ustar; add PAX support for long/Unicode paths. Ensure deterministic output.
- Reject traversal, links, unsafe member types, duplicate normalized paths, extraction collisions, corrupt headers and excessive resources.

## Selected-text handoff
- `.handoff.md` is a readable projection of text files with declared `format: envoy.handoff/v0.2`, `stack_id`, `base_revision`, `scope`, `included_files`, `omitted_files` and collision-free `boundary`.
- Explicitly frame every file path/body and preserve its bytes or disclose normalization. Paths must be validated.
- A partial handoff must **never** be blindly imported as a replacement for a complete Stack.

## Mutations
AI-produced Returns are proposed edits, not direct writes. Validate identity, revision, path scope, conflicts and preservation; display a diff and require approval. Increment revision once for an accepted mutation.

See [manual handoff guide](manual-needlecast.md).


## Carbon v1 implementation profile — 2026-10-19

These clarifications resolve ambiguities in the draft while retaining `envoy.stack/v0.2` and `envoy.handoff/v0.2`. They are proposed contract changes in the Carbon implementation PR, not a declaration that the draft is frozen.

### Paths, YAML and revisions

- Paths use UTF-8 NFC and `/`, with no absolute paths, drive prefixes, backslashes, traversal/dot/empty components, controls/bidirectional overrides, Windows reserved names, trailing dots/spaces, or `.git` component. Components are compared case-insensitively for collisions. Paths are rejected rather than silently renamed. Carbon keeps explicit and implied directories; empty directories survive archive round trips.
- IDs are ASCII `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`; revision is a nonnegative JavaScript safe integer. No per-file manifest inventory is introduced.
- YAML 1.2 mappings support scalar/string keys, sequences and nested mappings. Duplicate keys, complex keys, aliases, anchors, explicit tags, merge keys and excess resource use are rejected. This deliberately narrows the draft's unspecified alias allowance to zero.
- A leading `---` line without a closing `---` line is ordinary Markdown, preserving thematic-break documents. A closed leading block is YAML frontmatter and must validate; invalid closed blocks are rejected. Existing managed Entries still cannot lose their stable ID by removing a closing fence.
- Ordinary Markdown is preserved without invented frontmatter. Managed Entry IDs cannot change through edits or Returns. A revision is a committed transaction; unsaved editor drafts are separate.
- Unchanged files remain byte-identical. Body-only edits preserve raw frontmatter. Uniform CRLF is restored after textarea editing; mixed body line endings normalize to LF on edit. Manifest scalar changes patch exact source ranges. Removing the optional entrypoint on local deletion retains surrounding block-YAML comments; a flow-style mapping may be reserialized with comments preserved and whitespace normalized.
- Exports do not increment revision. Local edits and accepted Returns increment it once. History restoration creates a new revision. Carbon history/cache are outside the portable Stack; users can export earlier full snapshots separately.

### Archive interoperability profile

The exporter uses stable lexicographic member order, root `<stack-id>.stack/`, normalized owner/group IDs and zero mtime, regular-file mode 0644 and directory mode 0755. It writes POSIX ustar plus local PAX `path` records for non-ASCII/long paths. Standard reader support includes ustar prefixes and PAX `path`, `size`, `mtime`, `atime`, `ctime`, `uid`, `gid`, `uname`, and `gname`. Global metadata records are accepted only without global `path`/`size`. Unknown PAX keys and GNU extensions are rejected.

PAX header names and overridden ustar placeholders are not materialized. Standard `././@PaxHeader` names and ASCII placeholder substitutions from Python/GNU TAR are accepted; traversal, absolute/drive/backslash forms remain forbidden. The effective PAX path receives the complete portable-path checks. Exactly one logical Stack root is required; it need not have an explicit directory header. Import strips that root. Export chooses the stable root above, so an original archive root name is not preserved.

The export root is `<stack-id>.stack/`, or `envoy-<stack-id>.stack/` when the ID is a Windows reserved device name; readers strip the root, so the Stack ID is unaffected.

Two zero TAR end blocks and zero-only trailing padding are mandatory. Corrupt headers, member padding, unsupported types, duplicate/colliding paths, truncated bodies and resource-limit breaches fail before workspace replacement. Gzip uses native browser streams with bounded output and expansion ratio. See [limits](carbon-v1.md#resource-and-security-limits).

### Exact handoff framing

The earlier sample did not distinguish a file's terminal newline from the delimiter newline. Carbon adds `framing: exact-v1` and `dispatch_id` to the existing YAML metadata. It requires the heading `# Envoy Handoff`, a blank line, a fenced `yaml` metadata block, a blank line, then frames in `included_files` order:

```text
## File: <encodeURIComponent(path)>
<!-- envoy:begin boundary="<boundary>" path="<encodeURIComponent(path)>" -->
<exact UTF-8 body><one framing LF>
<!-- envoy:end boundary="<boundary>" -->
<one blank line>
```

There is exactly one LF after the begin marker, and one framing LF immediately before the end marker. The body can contain CRLF, multiple final newlines, or no final newline; the parser removes only the framing LF. Each end marker is followed by two LF bytes. Paths in the heading and marker use canonical JavaScript `encodeURIComponent` encoding. Missing, duplicate, reordered, mismatched or extra frames and unexpected trailing content are rejected.

A random boundary is chosen absent from every included body. The metadata and manifest remain unchanged in a Return. `included_files` contains the root manifest and selected Markdown Entries; `omitted_files` lists every other file. A `full-text` packet has no omitted files; otherwise scope is `selected-text`. Directories are not file inventory entries.

The local dispatch retains the full base Stack and selected scope. Acceptance requires the current Stack to equal that base byte-for-byte, the declared identity/revision/dispatch/scope to match, and unchanged manifest bytes. Model-provided hashes or approval text carry no authority. The user reviews a diff and accepts or rejects. Omissions never cause deletion.

V1 Returns can only update the bodies of existing selected Markdown Entries. Entry frontmatter must remain byte-for-byte identical, including comments and whitespace; adding or removing frontmatter is rejected. This enforces the bootstrap's body-only contract. Local notebook edits may change metadata while retaining the stable ID. Additions, moves, deletions and manifest edits use explicit notebook operations. Only a matching complete Stack plus an explicitly registered original dispatch can transfer this review state to another session. A partial handoff alone is never treated as a complete Stack.

Legacy draft packets lacking this framing are rejected with a regeneration message. Keeping the draft format version and naming the framing extension avoids pretending those ambiguous examples were already a frozen machine contract.
