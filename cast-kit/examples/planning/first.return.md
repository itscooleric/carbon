# Envoy Cast Return

```yaml
format: envoy.return/v0.1
assignment_id: cast-planning-research
dispatch_id: dispatch-planning-research
stack_id: stk-harbor-demo
base_revision: 4
checkpoint_id: checkpoint-planning-1
parent_checkpoint: null
status: complete
summary: Prepared proposed deliverables from supplied fictional evidence.
objective: Create a complete report from the supplied Entries.
accepted:
  - "Accepted: dataset is fictional; no real-world coverage has been verified. Source: entries/mission.md."
evidence:
  - "entries/source.md: Field table, fixture 2026-10-01; promised_at and delivered_at are present."
decisions:
  - Retain source notes; label unknown license and population coverage.
completed:
  - Prepared complete proposed Markdown contents.
questions: []
blockers: []
next:
  - User reviews evidence and proposed changes before acceptance.
verification:
  - "SIMULATED fixture receipt: reviewed generated file inventory; no provider run claimed."
errors: []
capabilities:
  - text
operations_performed: []
creates:
  - entries/report.md
replaces:
  - entries/plan.md
deletes: []
renames: []
boundary: harbor-return-boundary-0001
```

<!-- envoy-cast:file boundary="harbor-return-boundary-0001" path="entries%2Freport.md" -->
---
id: ent-harbor-report
kind: report
---
# Harbor field assessment

Accepted: dataset is fictional; no real-world coverage has been verified.

## Finding
The provided fictional source includes both timing fields; the sample description reports 2/3 and 3/3 non-null rows.
Source: entries/source.md, fixture version 2026-10-01.

## Limits
No live source was fetched. Licensing and population coverage are unresolved.

## Decision proposal
Retain as a candidate pending source and license verification.

Literal sample: café / 紫
```text
<!-- an ordinary comment -->
```
<!-- envoy-cast:end boundary="harbor-return-boundary-0001" -->

<!-- envoy-cast:file boundary="harbor-return-boundary-0001" path="entries%2Fplan.md" -->
---
id: ent-plan
kind: plan
status: "active" # retain this comment
---
# Plan
Accepted: dataset is fictional; no real-world coverage has been verified.
Accepted decision: use supplied source only.
Source: entries/source.md.
Pending: field assessment, then license investigation.

Report proposal for review: entries/report.md. Receipt: checkpoint-planning-1.
Pending: verify license evidence.

<!-- envoy-cast:end boundary="harbor-return-boundary-0001" -->

<!-- envoy-cast:complete boundary="harbor-return-boundary-0001" files="2" -->
