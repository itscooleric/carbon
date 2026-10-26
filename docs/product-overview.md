# Carbon product overview

This is the canonical product vocabulary and positioning for Carbon. Versioned format specifications remain authoritative for parsing, permissions, and compatibility.

## Description

**A Markdown-first notebook for notes, revisions, and AI work.**

Write notes locally, organize project files, and carry selected context into another conversation. Review what comes back before accepting changes. Keep a complete copy as ordinary files or a Stack archive.

The application runs offline as a single HTML file. Notes are Markdown, metadata is YAML, and supporting files remain ordinary files. A user can edit notes without involving an AI, or prepare a bounded assignment from selected context and review the returned work.

Use concrete actions and file types when introducing Carbon. Explain the notebook first, then the AI workflow. The established lines **Make AI work portable.** and **Your work moves with you.** remain available as supporting taglines; they do not need to be stacked above the product explanation. Avoid leading with abstract phrases such as “portable, persistent, reviewable AI collaboration.”

## Terms that need qualification

| Wording | Current use |
| --- | --- |
| Markdown-first notebook | Primary description: notes are editable Markdown, with YAML metadata and ordinary supporting files. |
| Local-first | The application runs offline; users retain files through explicit exports. Browser cache has separate limits. |
| Portable AI work | Describes the assignments, context, and results that users carry between conversations and tools. |
| Revision history | Describes numbered Stack revisions and a bounded local History of snapshots. Export older copies to retain them. |
| Source control / Git integration | Do not present as a built-in feature. External Git tools can track exported files; Carbon has no built-in Git operations. `.git` files are rejected in imported Stacks. |
| Portable AI runtime | Do not use as the current product category. Carbon prepares assignments and validates/reviews returned work; it does not execute models or agent jobs. Cast Kit's mock-tested adapter driver is not a shipped model runner. |

An execution feature with documented job, tool, and provider behavior would justify revisiting “runtime.” Built-in repository operations would justify revisiting “source control.” Until then, describe the implemented behavior directly.

## Product and protocol names

- **Carbon** names the notebook application: editing notes, keeping revisions, preparing assignments, and reviewing results.
- **Envoy** names the agent interoperability protocols and compatible AI workers. Compatibility refers to the relevant protocol contract; the name alone does not establish that a provider or model has been validated.
- **Envoy Cast Kit** is the existing protocol toolkit and separate offline Dispatch/staging lab. It supports Carbon interoperability; it is not the notebook application.
- **Needlecast** names the Dispatch/Return workflow for transferring work across conversations and tools.

The source repository remains `itscooleric/envoy`. Existing package names, paths, APIs, framing markers, and identifiers such as `envoy.stack/v0.2`, `envoy.handoff/v0.2`, `envoy.cast/v0.1`, `envoy.return/v0.1`, `envoy.dispatch/v0.1`, and `envoy.operating/v0.1` retain their meanings. Branding does not revise a format.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Stack | A portable workspace directory with `stack.yaml`, Entries, and optional Assets; a full archive is a snapshot of it. |
| Entry | A Markdown document in a Stack. Managed Entries have a stable YAML `id`; an optional `kind` describes their purpose. |
| Asset | A non-Entry file, such as an image, PDF, or audio file. Inclusion in a package does not prove that an AI can inspect it. |
| Mission | An optional work-oriented Entry (`kind: mission`) that describes a continuing objective. |
| Dispatch | Preparation and export of an assignment with selected context and instructions for another conversation or tool. Export does not establish delivery or completion. |
| Cast | Cast Kit's versioned assignment contract: objective, Stack/base identity, context references, deliverables, and allowed operations. |
| Playbook | Optional, user-selected Markdown instructions embedded in a Dispatch in a defined order. Instructions cannot expand the Cast's permissions. |
| Return | Results, evidence, a checkpoint, and/or proposed file changes awaiting validation and human review. A model's completion status is a claim to assess. |
| Handoff | A framed text projection of selected Stack files with explicit scope and omissions. It cannot reconstruct omitted Assets. |
| Acceptance | Explicit human approval after validation and review. An accepted file-change transaction creates one new Stack revision; export alone does not. |

## Feature hierarchy and availability

Availability below describes the integrated `dev` baseline at `4ab41e7798da5c8d183dd60a53ae307e2cfd20d6`, including merged [PR #8](https://github.com/itscooleric/envoy/pull/8).

| Layer | Purpose | Available on this base |
| --- | --- | --- |
| Workspace | Organize project context | Carbon notebook, Entries, Assets, optional Missions, templates, search, and wiki links |
| Portability | Retain and move work | Complete Stack TAR/TAR.GZ, ordinary files, selected text handoffs; user-managed transfers |
| Collaboration | Give another session a bounded assignment | Integrated Dispatch for Casts, selected context, and ordered Playbooks; the separate Cast Kit lab remains available |
| Review and continuity | Inspect changes and preserve accepted results | Staged Return review, validated all-or-nothing acceptance, retained receipts, and the original body-only handoff route |
| Unified workflow | Compose Dispatches and review newer Returns inside the notebook | Merged in PR #8; retained drafts, exported assignments, and staged Returns can recover from available browser state |

The [Carbon user guide](carbon-v1.md) covers notebook and integrated Dispatch/Return use. The [developer guide](developer-guide.md) explains module ownership, the acceptance transaction, and failure handling. The [Cast Kit usage guide](../cast-kit/docs/usage.md) covers its separate lab and the manual fallback.

## Claim boundaries

- **Local-first:** the shipped HTML runs locally without a runtime server or provider account. Browser caches, permissions, and file APIs still have limits.
- **Portable:** full Stack files and selected packets can be carried between tools. They serve different purposes; a selected Dispatch package cannot replace a complete Stack.
- **Persistent:** user-owned files preserve work when retained. Browser-only drafts and History do not become an automatic backup or cross-device sync service.
- **Reviewable:** validation and diffs support human decisions. They do not establish factual accuracy, security certification, or successful real-model execution.

Keep evidence limits visible. The merged integration includes the Carbon CB-1–CB-6 repairs tracked in [#5](https://github.com/itscooleric/envoy/issues/5). Consult [integrated Carbon validation](validation-unified.md) and [Cast Kit evaluation](../cast-kit/docs/evaluation.md) for dated, environment-specific evidence. Real-model trials, broader browser support, and native desktop permission flows remain unverified. Importing an original Cast to recover an outstanding Dispatch on another machine is not implemented; a fresh Dispatch can be exported from the Stack.

## Documentation responsibilities

The [root README](../README.md) introduces the product and the working quick start. This overview owns positioning and vocabulary. Usage guides own operational steps; the [Stack](format-v0.2.md) and [Cast/Return](../cast-kit/docs/protocol-v0.1.md) specifications own technical semantics. The [architecture draft](architecture-v0.2-draft.md) preserves original design rationale and historical naming. A future marketing website belongs in a separate repository; this source repository remains the home of Carbon's implementation and technical documentation.
