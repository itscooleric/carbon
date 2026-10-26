# Envoy Handoff

```yaml
format: envoy.handoff/v0.2
framing: exact-v1
dispatch_id: dispatch-ee6d15cc-ebc9-45d1-b112-14dda9e72a3b
stack_id: stk-supplier-lead-times-001
base_revision: 3
scope: selected-text
included_files:
  - entries/mission.md
  - entries/research/delivery-schema.md
  - stack.yaml
omitted_files:
  - assets/example-marker.bin
boundary: envoy-fe06f5a7-a4df-4c30-b315-182db40422b2
```

## File: entries%2Fmission.md
<!-- envoy:begin boundary="envoy-fe06f5a7-a4df-4c30-b315-182db40422b2" path="entries%2Fmission.md" -->
---
id: ent-mission-001
kind: mission
title: Supplier lead-time investigation
status: active
---
# Supplier lead-time investigation

## Objective
Find approved data sources with expected and actual delivery timestamps.

## State
- Public example; no candidate source has been validated.

## Next action
- Inspect documentation for candidate source schemas.

<!-- envoy:end boundary="envoy-fe06f5a7-a4df-4c30-b315-182db40422b2" -->

## File: entries%2Fresearch%2Fdelivery-schema.md
<!-- envoy:begin boundary="envoy-fe06f5a7-a4df-4c30-b315-182db40422b2" path="entries%2Fresearch%2Fdelivery-schema.md" -->
---
id: ent-research-001
kind: research
title: Delivery date field inquiry
status: investigating
---
# Delivery date field inquiry

Question: Do candidate sources contain promised and actual delivery timestamps?

No source has yet been verified for this example.

<!-- envoy:end boundary="envoy-fe06f5a7-a4df-4c30-b315-182db40422b2" -->

## File: stack.yaml
<!-- envoy:begin boundary="envoy-fe06f5a7-a4df-4c30-b315-182db40422b2" path="stack.yaml" -->
# Portable Envoy Stack manifest
format: envoy.stack/v0.2
id: stk-supplier-lead-times-001
revision: 3
title: Supplier lead-time investigation
entrypoint: entries/mission.md
handling: public-example  # Replace with your approved handling label.

<!-- envoy:end boundary="envoy-fe06f5a7-a4df-4c30-b315-182db40422b2" -->

