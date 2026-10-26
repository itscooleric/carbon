# Cast Kit v0.1 evaluation

Executed 2026-10-19. These results distinguish fixture semantics, actual local
execution and untested provider behavior. No actual model-provider comparison ran.

## Executed checks

| Check | Result | Evidence boundary |
|---|---|---|
| `npm --prefix cast-kit test` | 78 passed; zero failed/skipped | YAML/framing/paths/scope/checkpoints/loop/composition/build |
| `CARBON_ROOT=<merged-dev> npm --prefix cast-kit run test:carbon` | 9 passed; zero failed/skipped | Actual Carbon Stack/handoff/TAR APIs; pure in-memory acceptance |
| Carbon `node --test tests/core.test.js tests/interop.test.js tests/refinements.test.js` | 44 passed; zero failed/skipped | Relevant existing core/archive/refinement regressions |
| `npm --prefix cast-kit run build`, twice | Identical 183,749-byte HTML | Bundled runtime, script CSP hash test |
| `CAST_BROWSER_PATH=<Chromium> npm --prefix cast-kit run test:browser` | Passed, zero HTTP(S) requests, zero page errors | Actual headless Chromium 153.0.8010.0 on Linux, `file://` |
| `npm ci --offline --ignore-scripts` | Passed | Clean isolated Cast Kit lockfile installation from available cache |
| GNU tar independent read | Passed | Selected Dispatch archive inventory and exact Cast bytes |

Build SHA-256:
`6f2d3043bc0b0af10ed1d7b050ac3bbdd5d15df696f19ecb2c123ae560fbcb2e`.

[Browser evidence](evidence/browser.json), [fixture metrics](evidence/fixture-metrics.json),
and [implementation hashes](evidence/source-hashes.json) are included. The PR records
its exact commit and CI status. Source was materialized from connected GitHub reads;
publication uses a tree based on the exact remote `dev` commit, with new files only.

Carbon PR #2 was unmerged when inspection began: head
`946cad27a3dc9cca66eb566a3d6c2b74197b33e6`, base
`7de338d8836ead00d08c83f929349d9ae2a6747f`. It merged at 16:07:44 ET during this task.
Final compatibility checks above use merged `dev`
`ada6caca54edce1e3829524a2b3ac287e9d8cbd5`. The earlier reference also passed the
bridge checks; current evidence supersedes that baseline. The feature branch is based on the merged `dev` revision. Existing Carbon source/UI files are unchanged.

Initial CI caught a one-byte bundled-license whitespace mismatch after a final
LICENSE cleanup. Regenerating the offline HTML resolved the artifact discrepancy;
the runtime code and fixture outputs were unchanged. The PR links final CI results.

## Codex review repairs (2026-10-20)

Codex reviewed `a591863b0bfe9f120be422cb48b253bcb6fdab19` and reported four findings,
tracked in issue #5 as CK-1 to CK-4. Each now has a regression test:

| Finding | Repair | Regression |
|---|---|---|
| CK-1 (P1) case-colliding Return operations | Combined create/replace/delete/rename endpoints use the portable Carbon collision rules; Cast create/rename targets may not alias existing files or explicit directories | Encode/parse, registration, staging, fake-host and real Carbon acceptance; rejected Returns leave Stack bytes, inventory and revision unchanged |
| CK-2 (P2) `dispatch.yaml` missing from its own inventory | `manifest.files` lists `dispatch.yaml` | Manifest equals package keys and system-tar members, including the published `with-assets` package |
| CK-3 (P2) Asset order from caller Map | Assets numbered from the validated Cast order | Two insertion orders give identical manifests and byte-identical TARs |
| CK-4 (P2) CI only on the feature branch | Workflow runs on `dev`/`main` pushes and PRs (and on demand); bridge tests use the checkout's own Carbon sources | Workflow run on the repaired PR head |

Before the fix, an authorized delete of `entries/findings.md` with a create of
`entries/FINDINGS.md` was accepted by Carbon at revision 5 with a different stable ID.
The new tests fail on the reviewed commit and pass after the repair.

Codex's re-review of `9b1aa1d` found that Cast create/rename targets were checked against
existing paths but not against each other (for example create `archive/report.md` plus a
rename to `Archive/Report.md`, or two renames to one destination). Registration now
indexes each target as it is checked; the three cases are in the registration test.

Local results on the repair head (Node 22.22.0): `npm --prefix cast-kit test` 90 passed;
`test:carbon` 10 passed against both merged `dev` `ada6cac` and the integrated tree;
Carbon `node --test tests/core.test.js tests/interop.test.js tests/refinements.test.js`
44 passed and Carbon `npm test` 49 passed; two builds gave identical 183,823-byte HTML,
SHA-256 `f17158bde2f12652405c2edfdd3f052184c94d40bb3cef25fba4778a66261253`;
regenerated examples, templates and fixture metrics were unchanged apart from the
`with-assets` package; `npm ci --offline --ignore-scripts` passed;
`test:browser` passed on headless Chromium 141.0.7390.37 (`file://`) with zero
HTTP(S) requests and zero page errors. CI runs the browser suite on its own Playwright
Chromium.

## Experiment outcomes

| Experiment | Simulated work | Observed result |
|---|---|---|
| A Research | Inspect fictional Harbor dictionary; propose field findings | Complete changed Entry parsed; source and accepted statement preserved |
| B Registry | New Entity plus related-note update | Both complete files staged; stable IDs and full-Stack collision checks pass |
| C Reporting | New Markdown report from existing Entries | New report accepted in one revision through Carbon bridge |
| D Recovery | First session returns partial findings; fresh session supplies cumulative report | New registration/driver resumes from artifacts; parent checkpoint and previous proposals retained |
| E Restricted chat | Text-only packet with Unicode, code fences and no final body newline | Exact file reconstruction and browser download verified |
| Planning addendum | Plan → research/report → acceptance → new investigation → new-session resume | Revisions 4→5→6; accepted decisions, source IDs, plan ID, comments, pending actions and omitted bytes preserved |

All five fixture Returns validate. This measures protocol completion for pre-authored
results, not successful research by five independent models. The fictional source
contains an injection asking for deletion/exfiltration. Tests show that an attempted
unauthorized deletion is rejected by the host; they do not measure model resistance.

Negative coverage includes stale base revision, same-revision content conflicts,
omitted-Asset changes, duplicate IDs in omitted Entries, missing attachment/frame,
truncation, excessive size/depth, path/case collisions, unsafe YAML, boundary collisions,
unknown formats/fields, ambiguous empty objectives, unsupported manifest/file writes,
unauthorized metadata, cumulative checkpoint loss, timeout, stop, retry exhaustion,
missing capabilities and budget exhaustion. The selected Dispatch TAR is independently
readable and is rejected by Carbon as a complete Stack because it lacks root stack.yaml.

The offline browser exercised all four one-session examples, text Dispatch export,
Playbook composition, malformed-paste rejection, exact report download and two-step
recovery. A 650px light-theme/reduced-motion layout was checked; the session also ran
with a dark preference. Imported content is displayed literally using textContent.

## Overhead and user effort

Measured bootstrap: 258 words / 1,872 UTF-8 bytes. Full contract: 6,015 bytes.
Contract + bootstrap + Cast: 8,748–8,789 bytes across the five fixtures. Original
context: about 2.37 KiB; Return: 1,946–2,713 bytes. The complete Dispatch additionally
includes the receipt template and wrapper headings; selected Playbooks add their
actual text. These costs are material for tiny tasks and small local models.

Using a clearly approximate four-bytes-per-token English-text heuristic, control
text is about 2,187–2,198 tokens before context, Return template and Playbooks.
No provider tokenizer or billed-token measurement was available. The mock loop uses
exact UTF-8 byte units for deterministic budgets; those are not provider tokens.
Reproduce metrics with `node cast-kit/scripts/measure.mjs`.

The scripted lab path uses four actions: select example, load, stage, download.
A real paste workflow adds context/Cast/Return transfer, evidence review and acceptance.
Human effort/time, retry rates and real task quality have not been measured. The
Carbon wizard should reduce this friction; do not claim usability success from an
automated click count.

## Runtime and versioning

- Envoy Cast Kit 0.1.0 draft; Envoy Stack/handoff 0.2 with exact-v1 framing.
- Node.js 24.19.0, Python 3.12.14, GNU tar 1.35; development/test only.
- Chromium 153.0.8010.0, Playwright 1.64.1.
- Bundled yaml 2.9.1; esbuild 0.28.2; dependency documentation dates not stated.
- Cadre reference 0.2.7-draft at `a709395fce56675e55ebd691f854321e41489257`;
  no runtime dependency or Cadre registration.

## Remaining limitations and next decision

No live ChatGPT/Gemini/Claude/local-model/API adapter test; no Firefox, Safari, mobile
or managed enterprise browser acceptance. No privileged filesystem writes, provider
credentials, backend or deployment. Archive import and full Stack persistence stay
with Carbon. Selected binary export works in the composer/TAR fixture; the lab UI
currently exposes text-only context. The lab displays full before/after text; Carbon
integration should reuse its bounded line diff and History.

Semantic evidence preservation, truth and hidden instructions cannot be proven by
framing or YAML validation. The explicit review boundary remains mandatory. A
well-framed but shortened body still requires completeness review. Metadata changes
are limited to authorized existing scalar values, with exact preservation elsewhere.

Recommended next milestone: integrate the five-step Dispatch wizard and separate
Cast Return review route in Carbon, persist original dispatch/acceptance receipts,
and perform small actual provider/user trials with this frozen fixture set. Keep the
prompt workflow while measuring whether a larger runtime would provide useful gains.

## Readability pass (2026-10-20)

Issue #6: dense single-line statements in `src/kit.mjs`, `src/dispatch.mjs` and
`src/validation.mjs` obscured the protocol operations. This pass reformats those three
modules to one statement per line with named intermediate values and splits the largest
functions into internal helpers where that clarifies the sequence of checks:

- `kit.mjs`: `parseCast` → `checkPlaybooks`, `checkMetadataPermissions`, `checkCastIdentity`,
  `checkCastScope`, `checkCastTerms`; `stageReturn` → `checkReturnAgainstCast`,
  `applyOperations`, `checkEntryIds`, `stageWarnings`; `pairs` renamed `renamePairs`;
  frame markers named `framePrefix`, `frameSuffix`, `completionSentinel`.
- `dispatch.mjs`: `composeDispatch` → `checkPackageInputs`, `packageAssets`, `dispatchText`;
  `dispatchTar` → `tarHeader`; the redundant second `parseCast` call now reuses the
  validated copy from `contextFor`.
- `validation.mjs`: no new helpers; combined conditions are named before each `check`.
- `loop.mjs` received JSDoc only (code lines are byte-identical); `workbench.mjs` received
  JSDoc and line breaks only.

Every module now carries `@typedef`s (`Cast`, `ReturnMeta`, `StagedChange`, `StageResult`,
`TrustedHandle`, `HostStack`, `AcceptanceRecord`, `AcceptanceResult`, `HandoffMeta`,
`DispatchContext`, `DispatchManifest`, `ComposeResult`, `Adapter`, `LoopResult`) and every
exported function documents parameters, return value, thrown messages in check order, side
effects and trust assumptions, including what a partial (handoff-only) handle cannot verify
versus a complete (full Stack) handle.

Wire semantics are unchanged: `envoy.cast/v0.1`, `envoy.return/v0.1`, `envoy.handoff/v0.2`
exact-v1 and `envoy.dispatch/v0.1` are parsed and emitted byte-for-byte as before. Exported
names, signatures and arities are identical, every error message text is identical and is
thrown in the same fail-closed order. `tests/readability.snapshot.json` was generated from the
pre-refactor modules by `tests/readability-snapshot.mjs` and pins 12 staging results, 4
context copies, 4 acceptance records (including the exact `Stack.change` arguments), the
research Dispatch text and the with-assets package TAR, and 149 thrown messages;
`tests/readability.test.mjs` replays all of it and also compares the committed examples.
`npm run examples` regenerates `examples/` and `templates/` with no diff.

Counts after the pass: `npm test` 117 pass (90 existing + 27 new), `test:carbon` 10 pass,
`test:browser` 7 scenarios with 0 page errors and 0 network requests (Chromium 141),
`npm run build` reproducible (`dist/cast-kit.html` 184,504 bytes, identical hash on two
consecutive builds). `docs/evidence/source-hashes.json` still describes the pre-pass sources
and was deliberately left unchanged.
