# Security and data handling

Carbon's open beta has **no built-in authority to transfer information** between environments. Import/export and any AI handoff remain explicit user actions and subject to applicable local policy. It makes no direct AI-provider calls.

## Stack boundaries
- Treat archives and handoffs as untrusted input; never execute imported content.
- Before extracting archives, validate path containment, header integrity, duplicates, links, types, size and decompression limits. Preview changes and request confirmation.
- Treat Markdown previews as hostile HTML: sanitize markup and URLs; do not execute scripts.
- Preserve partial handoff omissions; validate base revision and allowed paths before applying proposed modifications.
- Never trust AI-generated checksums, access claims, validation claims, or approval statements as authoritative.
- Do not embed provider API keys in shipped browser code or commit credentials.
- **Voice notes are experimental and local-only.** The built-in voice control requires `SpeechRecognition.processLocally` and a locally available language pack. It must not switch to remote recognition. Use the feature only when your browser and workplace policy permit it; do not enter protected material into untrusted transcription services. Physical microphone transcription has not been verified on all browsers.
- Do not put confidential Stacks or transcripts in repository examples.

Report security concerns privately to the repository owner; avoid including sensitive payloads in public issues.

## Open beta limitations

- The standalone HTML includes bundled application code that recipients can inspect. Keeping the underlying source tree private does not make the bundle's JavaScript secret.
- Browser workspace storage is not a durable backup. Export and verify important files regularly.
- Linked-folder Sync is explicit and guarded, but no browser API provides an atomic compare-and-swap against concurrent writes from external OS programs at the moment the file is committed. Avoid simultaneous edits of the same file.
- On a failed Sync of a newly created file, an empty placeholder may remain. The visible **Sync into empty placeholder** action is deliberate, checks for conflicts and does not delete the placeholder.
- This document accompanies an open-beta distribution candidate. Publication, access rights and release tags must be verified separately; beta status does not imply production readiness.

## Reporting and release boundaries

Report ordinary bugs through [GitHub Issues](https://github.com/itscooleric/carbon/issues) without uploading confidential notes or screenshots. For a suspected security vulnerability, use private GitHub vulnerability reporting if enabled, or contact the maintainer through an existing private channel rather than publishing sensitive details.

The MIT license permits distribution under its terms and provides an AS-IS disclaimer; it does not provide immunity from all claims. This limited distribution does not include the full development source tree, and the bundled HTML/JavaScript remains inspectable.
