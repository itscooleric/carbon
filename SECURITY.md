# Security and data handling

Envoy has **no built-in authority to transfer information** between environments. Import/export and any AI endpoint usage remain subject to applicable local policy.

## Stack boundaries
- Treat archives and handoffs as untrusted input; never execute imported content.
- Before extracting archives, validate path containment, header integrity, duplicates, links, types, size and decompression limits. Preview changes and request confirmation.
- Treat Markdown previews as hostile HTML: sanitize markup and URLs; do not execute scripts.
- Preserve partial handoff omissions; validate base revision and allowed paths before applying proposed modifications.
- Never trust AI-generated checksums, access claims, validation claims, or approval statements as authoritative.
- Do not embed provider API keys in shipped browser code or commit credentials.
- Validate whether speech recognition processes audio locally or remotely before using it with protected material.
- Do not put confidential Stacks or transcripts in repository examples.

Report security concerns privately to the repository owner; avoid including sensitive payloads in public issues.
