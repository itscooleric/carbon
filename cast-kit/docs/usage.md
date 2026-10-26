# Use Envoy in an arbitrary new AI chat

This is the complete usage guide for Cast Kit v0.1, draft 2026-10-19.

## First useful trial

1. Open `cast-kit/dist/cast-kit.html` locally. Choose **research**, then **Load
   example**. The fictional complete Stack is in `cast-kit/examples/harbor.stack/`.
2. Choose **Prepare copyable Dispatch**. Copy the complete text into an authorized
   new AI chat. For a file-capable chat, download Dispatch text or the selected TAR.
3. Ask the model to perform the task and return the complete framed Return. An
   ordinary pasted conversation is sufficient; no Skill, MCP or filesystem is needed.
4. Copy the returned text packet without its outer code fence into **Return packet**.
   Choose **Validate and stage**. Missing files, malformed boundaries, wrong identity
   or unauthorized operations are rejected. Do not accept a partial copied response.
5. Review the evidence and every proposed file. Download the checked Return and any
   proposed files you choose to keep. A successful parse does not verify the findings.

The loaded example Return is a deterministic fixture so you can try validation
before using a model. It is not a provider benchmark. “Run recovery mock” demonstrates
two bounded interactions and returns a cumulative checkpoint; it accepts no Stack.

## Your ordinary Stack

1. Retain a full copy of your Stack, including Assets. In Carbon, save drafts and
   export the relevant Entries as a fresh Needlecast handoff. Also export a complete
   archive for preservation. Cast Kit accepts Carbon's `exact-v1` v0.2 framing.
2. Load the original handoff in the lab. Enter the task, completion criteria and an
   optional new report path. Select optional Playbooks. Create the Cast.
3. Inspect the Cast YAML. Set `mission` to a supplied Mission path if useful. Authorize
   exact existing Entry paths in `replace`, new paths in `create`, and expected file
   deliverables in `required_files`. Leave deletion, rename and metadata permission
   empty unless intentionally needed. For a conversational answer, all file lists can
   be empty and the model returns its answer/evidence in the receipt.
4. Playbooks are embedded completely in `playbooks`, in listed order. To import your
   own, add `{name, source, content}` with the complete Markdown content as a YAML
   block scalar. Preview it before dispatch. A source label does not fetch anything.
5. Prepare/download the Dispatch. Send only data you are authorized to transfer.
   Confirm the model can actually inspect the supplied contents. If a required file
   is inaccessible, request a blocked checkpoint or supply a smaller text selection.
6. Work for one or more interactions. Ask for a complete checkpoint before stopping.
   Every unaccepted continuation stays based on the original Cast/revision and must
   repeat all proposed changes cumulatively. Keep the latest complete Return.

Example scope for an existing plan and new report:

```yaml
replace: [entries/plan.md]
create: [entries/report.md]
required_files: [entries/plan.md, entries/report.md]
metadata:
  - path: entries/plan.md
    keys: [status]
delete: []
rename: []
```

This allows a body update and the existing scalar `status` value only. Existing IDs,
unknown frontmatter, comments and manifest stay protected. New/nested metadata keys
are unsupported in this release. Use quoted JSON scalar spelling for a changed string
(e.g. `status: "active"`), preserving surrounding bytes/comments.

## Review, accept and reconstruct

> **2026-10-20 update.** Carbon now composes Casts in its **↗ Dispatch…** wizard and imports
> `envoy.return/v0.1` through **⇩ Import Return…**, checking it against the original Cast and
> base Stack and accepting it as one revision (see `docs/carbon-v1.md`). Use that in Carbon.
> The manual procedure below remains the fallback for other hosts or for a Return whose
> original Cast is not in this browser. Never rename a Return as an old v0.2 handoff. The
> lab itself still does not alter Carbon or commit revisions.

Manual acceptance (other hosts):

1. Validate/stage against the original Cast and handoff. Compare the **current full
   Stack** with your saved base. If it changed, stop and redispatch; matching revision
   numbers alone are insufficient.
2. Review the actual deliverables, sources, preserved accepted facts and operation
   list. Keep the checked Return as the session record. A `complete` status is still
   the model's claim. Reject or request corrections if evidence is inadequate.
3. Duplicate the complete original Stack directory. Use an ordinary text editor/file
   manager to save approved complete files at their exact relative paths. Perform
   only explicitly approved deletion/rename proposals. Preserve all other files and
   Assets. Do not use the selected Dispatch TAR as a replacement Stack.
4. Increment only the duplicated `stack.yaml` revision once for that accepted batch,
   preserving other metadata/comments. Record the accepted Return/checkpoint ID and
   resulting revision in your Mission notes or a separate local receipt. Keep the
   previous full snapshot.
5. Import the complete updated folder/archive into Carbon. Verify validation, file
   identity, sources and omitted Asset bytes. Save/export a complete new snapshot.

The tested `acceptInCarbon` API automates the guarded in-memory transaction for a
host. It requires the complete validated Stack and explicit approval; Carbon's integrated
wizard and acceptance UI now use it.

## Resume in another session

Before acceptance: supply the contract, bootstrap, original Cast/context and latest
complete unaccepted Return. Say: “Resume from this proposed checkpoint. Retain the
original base and return cumulative proposed changes.” A partial projection cannot
recover missing binaries; those stay with the original Stack.

After acceptance: export fresh context from the new Stack revision, create a new
Cast and include the relevant accepted plan/report/decision Entries. The examples in
`examples/planning/` show research at revision 4, investigation at revision 5 and a
fresh-session resume at revision 6. Include the selected Playbooks every time.

## Capability-specific handling

- **Text-only:** use the full text Dispatch and complete Return. Never claim generated
  text was written or attached. If it cannot fit, narrow the assignment and try again.
- **File-capable:** return an actual checked `.return.md` attachment containing all
  text deliverables. A separate download link without the file is insufficient.
- **Tool-enabled:** work in an authorized staging location; include real operation
  evidence and portable contents. Do not overwrite the authoritative Stack directly.
- **Local model with small context:** select fewer Entries and Playbooks; keep accepted
  facts needed for the task. Check framing after every response. No tool calling is
  required. Context/token limits vary and were not provider-tested here.
- **Binary/TAR-capable:** the selected package can carry explicitly chosen Asset bytes.
  The core composer supports this; the lab UI currently exports text-only packages.
  `examples/with-assets/selected.dispatch.tar` demonstrates the binary mapping. Require
  actual inspection capability, or keep Assets omitted and declare the task blocked.

The protocol supports custom tasks, including preparation, reconciliation and reviews.
Use the planning/research/decision/review templates as ordinary editable Entries;
none mandates a folder layout or methodology.
