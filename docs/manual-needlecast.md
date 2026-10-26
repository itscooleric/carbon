# Manual Needlecast — initial workflow

This requires only an approved AI chat with text/file attachment support and an ordinary text editor.

1. Create a folder containing `stack.yaml` and one or more Markdown Entries, or begin from the sanitized [example](../examples/supplier-lead-times.stack/).
2. Select Entries needed for the question and build a `.handoff.md` packet with an inventory of included and omitted files. Use Carbon’s Needlecast export to generate validated framing and retain the trusted base. The bundled sample uses the current implementation profile.
3. Attach the packet to the authorized AI service and paste [bootstrap.md](../prompts/bootstrap.md). Specify the requested work.
4. Request an answer, a change summary, complete changed Entry text with relative paths, and the original base revision.
5. Check new evidence and decisions against source materials. Compare each proposed Entry with your saved files; inspect any deletions.
6. Save approved changes to your **working copy**. Update `stack.yaml` revision after acceptance. Preserve a prior snapshot.
7. Generate a fresh packet for the next session. Never assume a previous chat persists elsewhere.

**Carbon v1:** Import the returned `.handoff.md` to validate its scope and base state and review the diff before acceptance. Keep every frame and its metadata, including unchanged files. Returns update existing selected Entries only. See [the complete guide](carbon-v1.md#manual-needlecast).

