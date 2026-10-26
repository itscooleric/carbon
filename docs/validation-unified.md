# Carbon unified Dispatch / Return validation evidence

Observed on 2026-10-20 for the Carbon unified integration (issue #7: CB-1..CB-6 repairs, modular UI, Dispatch / Playbook / Return workflow). This report lists what was executed and what was not. The earlier v1 report is [validation-v1.md](validation-v1.md).

## Results

| Gate | Command | Result |
| --- | --- | --- |
| Carbon unit | `npm test` | **110 passed, 0 failed, 0 skipped** |
| Build | `npm run build` | deterministic; rebuilding left `dist/` and the generated JSON byte-identical to the committed files |
| Carbon browser | `CARBON_BROWSER_PATH=/opt/pw-browsers/chromium npm run test:browser` | **passed** (~45 s): 20 workflow checkpoints, 3 degraded-capability scenarios, 26 refinement categories (including the 10-item Dispatch UI smoke pass) and the integrated `dispatchFlows` pass (18 scenarios passed, 0 skipped) |
| Cast Kit unit | `npm --prefix cast-kit test` | **117 passed, 0 failed** |
| Cast Kit ↔ Carbon sources | `CARBON_ROOT=$PWD npm --prefix cast-kit run test:carbon` | **10 passed, 0 failed** |
| Cast Kit browser | `CAST_BROWSER_PATH=/opt/pw-browsers/chromium npm --prefix cast-kit run test:browser` | **passed**, 7 scenarios, 0 network requests, 0 page errors |

Every Carbon browser pass ran from `file://` in offline browser contexts and recorded **0 HTTP(S) requests and 0 page errors**. Browser report: [`evidence/browser-2026-10-20.json`](evidence/browser-2026-10-20.json) (the `dispatchFlows` key holds the integrated scenarios, their timings and contrast samples).

Tested distributable SHA-256:

```text
3494282ef803aa7c49b9ba62df03b6bf6fd8dfd360c3eaf9b8ef578e8e76954c  dist/carbon.html
```

## Environment

- Chromium (headless) **141.0.7390.37**, Linux x86_64, at `/opt/pw-browsers/chromium` (the pinned Playwright 1.64.1 could not download its own browser here; the `*_BROWSER_PATH` variables point the suites at the installed binary).
- Node.js **22.22.0**, npm 10.9.4; Ubuntu 24.04.5 LTS, Linux 6.18.44.
- Runtime bundle unchanged: yaml 2.9.1, marked 18.1.1, DOMPurify 3.4.17, highlight.js 11.12.0; esbuild 0.28.2.

## Integrated Dispatch / Return scenarios (`tests/dispatch-browser.mjs`)

Each scenario drives the real UI against `dist/carbon.html`: it imports a Stack, composes a Dispatch in the wizard, exports it, extracts the Cast from the exported text with Cast Kit's `parseCast`, builds an `envoy.return/v0.1` Return with `encodeReturn` carrying the exported `assignment_id`, `dispatch_id`, `stack_id`, `objective` and `base_revision`, imports it through **⇩ Import Return…**, and reviews and decides.

| # | Scenario | Result |
| --- | --- | --- |
| 1 | Quick question: Skip to review → consent → Download dispatch.md; text carries the Research Playbook, operating contract, `# Envoy Handoff` context and Return template; `parseCast` accepts it; permissions all false/empty; card *Exported · awaiting Return*; zero-op Return shows all seven checks passing (exact contract texts) and HTML rendered as text; Save receipt → *Checkpoint*, revision unchanged; second zero-op Return → Save answer as Entry creates a note Entry | pass |
| 2 | Report flow on the Cast Kit harbor fixture (TAR with an empty directory): Mission pre-selected, Critical review added and moved so the Cast `playbooks` order equals the visible order, create `entries/report.md` + replace `entries/findings.md`; NEW / EDIT badges with line counts, `+`/`−` gutters; Accept names revision 5; History lists *r4 · Before accepting Return 1*; TAR.GZ export keeps `assets/marker.bin` and `entries/retained.md` bytes, `# Preserve this manifest comment`, `custom: keep-me`, the Mission's comment and the `empty` directory; fresh-context reimport is revision 5 with identical marker bytes | pass |
| 3 | Planning continuity 4 → 5 → 6 with `planningFixture()`: two Dispatches with the fixture objectives and permissions (replace `entries/plan.md` with metadata key `status`; create `entries/report.md`, then `entries/investigation.md`); the fixture Returns re-addressed to the Carbon-exported identities; metadata box shows `status "proposed" → "active"` then `"active" → "blocked"` as permitted; second Return self-reports *blocked* yet is acceptable; exported Stacks equal `expected5` and `expected6` byte-for-byte (including `stack.yaml`); **New Dispatch from rev 6** opens a draft at base 6 with plan, report and investigation in context | pass |
| 4 | Stale base: Entry saved after export → *Stack is now revision 4; Cast base is 3*, Accept disabled, **Re-dispatch** opens Dispatch 2 at rev 4 with the same objective; a Return claiming base 2 → *Return claims base 2; Cast base is 3* | pass |
| 5 | Unauthorized replace of an Entry outside `replace` → permissions check fails, ✕ badge, *Not permitted by the original Cast*, Accept disabled, Stack unchanged | pass |
| 6 | Created Entry reusing omitted `ent-retained` → ids check fails (only that check); Reject → *Return rejected*, revision unchanged | pass |
| 7 | Unsaved draft in an affected Entry → drafts check fails; **Open unsaved Entry**; Discard draft; reopened review passes all checks | pass |
| 8 | Storage failure: `IDBObjectStore.prototype.put` throws during Accept → notice *Not saved … Stack is unchanged … still staged* (single prefix), revision unchanged, review still open, card *Return staged*, Download proposed archive offered; prototype restored → **Retry** → revision 4, which survives a reload | pass |
| 8b | No draft cache (`indexedDB` undefined): Accept first downloads `stk-test-before-return-r3.stack.tar` containing revision 3, then accepts revision 4 | pass |
| 9 | Routing: plain text → inline *Not a Return Carbon understands …*; Cast Return for an unknown assignment → *Original Cast not found for …*; legacy `# Envoy Handoff` pasted into Import Return opens the legacy diff modal and accepts (revision +1); the same via `#files` upload still works | pass |
| 10 | Download selected TAR with an Asset: `envoy-dispatch/dispatch.yaml` has `complete_stack: false`, `assets/0001.bin` equals the Asset, no `stack.yaml`; uploading it is refused (*stack.yaml*), Stack unchanged; text target with an Asset shows the blocker and disables export; a 17 KB Playbook file is refused (*limited to 16 KiB*); **Use a Stack Entry as Playbook** adds `stack: entries/other.md`, embedded in the exported Cast | pass |
| 11 | Reload with one draft, one exported and one staged Dispatch: states kept, the draft reopens with its objective, the staged one reopens with the same checks; Abandon (confirmed) → *Abandoned* | pass |
| 12 | Clipboard (in-page stub): resolving → *Exported*, copied text equals **Download again** bytes; rejecting → *Clipboard unavailable — use Download instead*, card stays *Draft* | pass |
| 13 | Layout and accessibility with real harbor data: drawer and review screenshots in both themes at 1440×900, 1000×700, 800×650; no horizontal page scroll; `#review-accept` and `#review-files` inside the viewport; Tab from the review heading reaches the file list; `j` / `k` move `aria-current`; reduced motion gives `#drawer` `transitionDuration` 0s and no animation; contrast of `.chip`, `.op`, `.udiff td`, `.checks li`, `#review-reason` ≥ 4.5:1 (minimum 6.91:1 dark, 6.45:1 light, 63 samples each) | pass |
| 11b | Reload with damaged cached Dispatch records injected into IndexedDB: an error notice reports 3 skipped records; the Stack (revision 3) and the valid draft Dispatch recover with their objective; 0 page errors | pass |
| 14 | A completion criterion or create path still being typed survives Esc closing the drawer (fixed in the coordinator commit after package E) | pass |

### Resolved during integration

Package E found that `#draft-criteria`, `#draft-create` and rename targets (saved on `change`) lost a value still being typed when Esc closed the drawer. The coordinator fixed `close()` in `src/carbon/ui/dispatch-wizard.js` to blur the focused drawer field before clearing the open record; scenario 14 is the regression.

Codex review of `2697334` reported three P2 findings, fixed in the following commit with unit regressions that fail on `2697334`:

- A zero-operation Return that failed identity, base or scope checks could still be saved as a checkpoint (dropping the retained base). `saveReceipt` now re-evaluates the Return and requires every check to pass; the review disables **Save receipt** and **Save answer as Entry…** otherwise, and the answer Entry is created only after the receipt is stored.
- Complete-scope TAR export produced the selected `envoy.dispatch/v0.1` package instead of the promised Stack archive. It now downloads the actual complete `<stack-id>-r<revision>.stack.tar` of the Dispatch base (empty directories included) plus `dispatch.md`.
- Files / attachments export flattened `assets/0001.bin` to `0001.bin`, contradicting the emitted `dispatch.yaml`. It now downloads `dispatch.md` plus each Asset under the file name the Cast lists, emits no loose manifest, and refuses two Assets with the same file name (use the TAR).
- (Re-review of `49e5bfe`) Complete scope still allowed the Text and Files targets, which exported only `dispatch.md`. The controller now reports a blocker and refuses any non-TAR export for complete scope, and the wizard disables those targets.
- (Re-review of `59c0060`) The pending Dispatch panel still offered **Copy again** for complete-scope records, which the controller refuses; the same mismatch affected **Copy dispatch.md** on the Files target with Assets. The controller now exposes `exportActions()` as the single list of supported exports, `write()` enforces it, and both the export step and the pending panel render only those actions.
- (Re-review of `22317c2`) A Files draft with two Assets of the same file name was still offered **Download files**, which `write()` refused. One shared collision check now feeds the step-4 blocker, `exportActions()` and `write()`; an exhaustive invariant test (every scope × target × Asset selection × action) asserts that every offered action exports and every other one is refused.
- (Re-review of `a8f472d`) `restore()` accepted cached Dispatch records verbatim, so one malformed record made the first render throw and left Carbon unusable. Each record is now validated (`validDispatch`, including re-validating a retained base as a Stack); malformed or duplicate records are skipped with an error notice while the Stack, History and valid Dispatches recover. Covered by a unit test and browser scenario 11b, which writes damaged records into IndexedDB and reloads.
- (Re-review of `cffee95`) The restore validator accepted any string as a cached Cast, handoff, Return template or staged Return. It now requires them to parse with this build's Cast Kit (`registerHandoff`, `readHandoff`, `parseReturn`) and to agree with the record's assignment, Stack, base revision and dispatch IDs, so a truncated or incompatible record is skipped with the notice instead of failing later when used.


## Evidence screenshots

Taken by the `dispatchFlows` pass with real fixture data:

- [Dispatch drawer, Review & export, dark 1440×900](evidence/dispatch-drawer-dark-1440x900.png)
- [Dispatch drawer, light 1000×700](evidence/dispatch-drawer-light-1000x700.png)
- [Dispatch drawer, dark 800×650](evidence/dispatch-drawer-dark-800x650.png)
- [Return review with diff and checks, dark 1440×900](evidence/return-review-dark-1440x900.png)
- [Return review, light 1440×900](evidence/return-review-light-1440x900.png)
- [Return review, light 800×650](evidence/return-review-light-800x650.png)

All twelve size/theme combinations are written to `test-results/carbon-flow-*.png` on every run and uploaded by CI as the `carbon-browser-evidence` artifact.

## Executed versus unverified

Executed: everything in the tables above, in headless Chromium on Linux, offline `file://`.

Not verified:

- **No provider trials.** No Dispatch was sent to a real AI; every Return was generated by Cast Kit from fixtures. Whether a given model follows the operating contract and returns complete framing is not established here.
- **No screen reader**, no manual keyboard-only session; accessibility evidence is the automated focus, `aria-current`, reduced-motion and sampled-contrast checks above.
- **No Windows, macOS, Firefox, WebKit/Safari or Edge** runs; no managed enterprise policy; no real clipboard permission prompt (`file://` clipboard was stubbed in-page); no native directory picker grants.
- Synthetic link workload timings in the report are observations from this machine, not performance gates.
