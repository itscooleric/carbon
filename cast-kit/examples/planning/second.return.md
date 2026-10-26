# Envoy Cast Return

```yaml
format: envoy.return/v0.1
assignment_id: cast-planning-license
dispatch_id: dispatch-planning-license
stack_id: stk-harbor-demo
base_revision: 5
checkpoint_id: checkpoint-planning-2
parent_checkpoint: null
status: blocked
summary: Source terms missing; proposed investigation note and plan checkpoint are complete.
objective: Investigate license evidence in the accepted report and source.
accepted:
  - "Accepted: dataset is fictional; no real-world coverage has been verified. Source: entries/mission.md."
evidence:
  - "entries/source.md: Field table, fixture 2026-10-01; promised_at and delivered_at are present."
decisions:
  - Retain source notes; label unknown license and population coverage.
completed:
  - Prepared complete proposed Markdown contents.
questions: []
blockers:
  - Publisher terms not supplied.
next:
  - Obtain publisher terms via an approved source.
verification:
  - "SIMULATED fixture receipt: reviewed generated file inventory; no provider run claimed."
errors: []
capabilities:
  - text
operations_performed: []
creates:
  - entries/investigation.md
replaces:
  - entries/plan.md
deletes: []
renames: []
boundary: harbor-return-boundary-0001
```

<!-- envoy-cast:file boundary="harbor-return-boundary-0001" path="entries%2Finvestigation.md" -->
---
id: ent-license-investigation
kind: investigation
---
# License evidence
The supplied source does not establish a license.
Evidence: entries/source.md and accepted entries/report.md.
Pending: obtain publisher terms through an approved source.

<!-- envoy-cast:end boundary="harbor-return-boundary-0001" -->

<!-- envoy-cast:file boundary="harbor-return-boundary-0001" path="entries%2Fplan.md" -->
---
id: ent-plan
kind: plan
status: "blocked" # retain this comment
---
# Plan
Accepted: dataset is fictional; no real-world coverage has been verified.
Accepted decision: use supplied source only.
Source: entries/source.md.
Pending: field assessment, then license investigation.

Report proposal for review: entries/report.md. Receipt: checkpoint-planning-1.
Pending: verify license evidence.

Pending: obtain publisher terms; do not infer acquisition permission. Receipt: checkpoint-planning-2.

<!-- envoy-cast:end boundary="harbor-return-boundary-0001" -->

<!-- envoy-cast:complete boundary="harbor-return-boundary-0001" files="2" -->
