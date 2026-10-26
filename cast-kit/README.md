# Embedded Cast and Return modules

Carbon incorporates these interoperability modules into its single offline HTML build. There is no separate Cast Kit application or development workbench in this distribution.

| Source | Responsibility |
| --- | --- |
| `src/validation.mjs` | Bounded YAML, text, and portable-path validation |
| `src/kit.mjs` | Cast/Return parsing, staging, permission checks, and approved acceptance |
| `src/dispatch.mjs` | Composing portable Dispatch packets and file packages |

`../scripts/build.mjs` embeds the Playbooks in `playbooks/`, the [operating contract](operating-contract-v0.1.md), and [bootstrap instructions](bootstrap.md) into `../src/carbon/castkit-assets.json`. Those text inputs and source modules must remain present for reproducible builds.

The existing `envoy.*` wire-format identifiers are preserved for compatibility; see the [protocol specification](docs/protocol-v0.1.md). Carbon itself does not contact an AI provider. It prepares exports and reviews manually imported Returns.

The synthetic helpers in `tests/fixtures.mjs` and `tests/planning-fixture.mjs` support Carbon's browser acceptance tests. Run the root repository's `npm test`, `npm run build`, and `npm run test:browser` commands to validate this integration.

All code in this directory is covered by the [MIT license](LICENSE).
