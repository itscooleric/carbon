# Carbon interoperability and next milestone

> **2026-10-20 update.** The milestone below is implemented in Carbon itself (issue #7): Carbon's
> Dispatch wizard composes Casts with `composeDispatch`, retains the original Cast and full base
> Stack, and its **Import Return** route stages `envoy.return/v0.1` with `registerStack` /
> `stageReturn` and accepts with `acceptInCarbon` as one atomic revision; the v0.2 route is kept.
> See `docs/carbon-v1.md` (Dispatch / Import and review a Return) and `docs/developer-guide.md`.
> The text below is the original 2026-10-19 analysis, kept for history; the manual procedure in
> `usage.md` remains the fallback for hosts other than Carbon.

Inspected Carbon PR #2 at `946cad27a3dc9cca66eb566a3d6c2b74197b33e6` on
2026-10-19. It was open/unmerged; `dev` was
`7de338d8836ead00d08c83f929349d9ae2a6747f`. PR #2 subsequently merged at 2026-10-19 16:07:44 ET. Before publication the bridge
was retested against merged `dev` at
`ada6caca54edce1e3829524a2b3ac287e9d8cbd5`; the feature commit uses that base.
No Carbon source, UI, build or existing handoff file is modified by this feature.

Carbon v1's `dispatch` retains a full base Stack, selected inventory and dispatch ID.
Its exact-v1 parser requires all selected frames and an unchanged manifest. `propose`
checks exact full base equality, identity and scope, then calls `Stack.change` for
existing selected Entry bodies, preserving raw frontmatter. It cannot accept new report/Entity files through that
Return route. Unknown staged envelope headers fail before mutation.

Cast Kit provides a pure `acceptInCarbon` bridge taking a validated complete Carbon
Stack, registered original handoff/Cast and a Return. It revalidates at acceptance,
requires explicit approval, delegates to `Stack.change`, and returns the old Stack,
new Stack, proposed receipt and host-generated acceptance metadata (including accepted revision). It does not write a folder, update IndexedDB/History, or
replace Carbon's UI. The host must retain History and durably store the receipt.
A checkpoint-only Return has no Stack mutation; store the receipt separately.

## Small integration milestone

1. Add **Create Cast** beside Needlecast export: objective, optional Mission,
   completion criteria, context/Asset selection, ordered Playbook preview, deliverable
   choices and exact create/replace/delete/rename/metadata permissions. Default
   to replace selected Entries only; all actual tools/transmission permissions off.
2. Save original Cast + dispatch + full base in the existing dispatch state. Export
   Cast, contract, Return template and copyable bootstrap. Show omitted Assets.
3. Add a distinct **Stage Cast Return** file/paste route, with explicit format errors.
   Keep the old v0.2 route unchanged.
4. Call `registerStack` / `stageReturn`, show create/replace/delete/rename diff plus
   evidence, unresolved work and unverified status. Check all IDs against the full
   Stack, including omitted Entries. Never render imported HTML or execute links.
5. On accept, recheck unsaved drafts and exact current base, then use `acceptInCarbon`.
   Save History, new revision and receipt atomically in browser state where possible.
   Request full archive export; verify reimport and unchanged omitted bytes.
6. Update or create a Mission receipt reference explicitly. Issue a fresh Cast at the
   new revision. Reload/resume must work without original chat or browser cache.

## Acceptance gates

- Both v0.2 and v0.1 routes round-trip without reinterpretation.
- Same-revision byte conflicts and newer revisions reject without mutation.
- Omitted Assets/Entries, YAML comments, unknown metadata and empty directories survive.
- New Entry ID collision with an omitted Entry rejects.
- Explicit deletion/rename affects only allowed paths, with entrypoint handling by Carbon.
- Review cancel, lost browser storage, missing original packet and double acceptance
  do not silently apply or erase anything.
- Browser tests use network blocking and realistic copy/paste/download flows.

The integration suite runs in CI against the Carbon sources of the same checkout: a PR
merged with its current `dev`/`main` base, or the pushed `dev`/`main` commit. It is no
longer pinned to a historical revision. Locally, point `CARBON_ROOT` at any Carbon
checkout. Current UI work is independent.

See [Dispatch wizard specification](dispatch-workflow.md) for UI steps, Playbook
composition, selected archive handling and capability-specific exports.
