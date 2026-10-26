# Envoy Cast Kit v0.1

Portable assignments, selected Markdown Playbooks and reviewable complete-file
Returns for fresh AI conversations. Draft protocol and working offline prototype.
Carbon integrates this toolkit in its Dispatch/Return UI and preserves the original v0.2 Return route.

This toolkit belongs to the [Carbon source repository](../README.md). **Carbon** is
the Markdown-first notebook; **Envoy** names the interoperability protocols and
compatible AI workers. See the [product overview](../docs/product-overview.md)
for vocabulary. The notebook's [Dispatch and Return guide](../docs/carbon-v1.md#dispatch-an-assignment)
covers the integrated workflow; the lab below remains a separate development tool.

Start with [the single Markdown usage guide](docs/usage.md). Open
[`dist/cast-kit.html`](dist/cast-kit.html) locally for the Dispatch/staging lab;
no server, account, Node, Python, CDN or network is required at runtime.

| Artifact | Purpose |
|---|---|
| [Operating contract](operating-contract-v0.1.md) / [bootstrap](bootstrap.md) | Explicit authority, lifecycle, evidence and recovery |
| [Protocol](docs/protocol-v0.1.md) / [templates](templates/) | YAML Cast, receipt, planning/research/report Entries |
| [Dispatch workflow](docs/dispatch-workflow.md) / [Playbooks](playbooks/) | Wizard specification, ordered portable instructions, capability-specific exports |
| [Research](docs/research.md) | Source comparison, versions, limitations and runtime decision |
| [Examples](examples/) | A–E fixtures, multi-dispatch planning and selected binary package |
| [Carbon integration](docs/carbon-integration.md) | Bridge, integrated host, and original milestone history |
| [Evaluation](docs/evaluation.md) | Executed evidence, overhead and untested provider behavior |

The default interaction is prompt-driven with local validation and human acceptance.
`src/loop.mjs` is a bounded mock-tested driver. It makes no provider calls and never
accepts or writes Stack files. `src/dispatch.mjs` composes portable text/file packages
and selected TARs. `src/kit.mjs` parses and stages Returns; `acceptInCarbon` delegates
an explicitly approved in-memory transaction to a validated complete Carbon Stack.

## Development

Node 22+ is development-only. GNU tar is used by an independent archive test.

```sh
npm --prefix cast-kit ci
npm --prefix cast-kit run examples
npm --prefix cast-kit test
npm --prefix cast-kit run build
npm --prefix cast-kit exec playwright install chromium
npm --prefix cast-kit run test:browser
```

For an existing browser: `CAST_BROWSER_PATH=/absolute/path/chromium`.
For the optional bridge suite: `CARBON_ROOT=/absolute/path/to/carbon npm --prefix cast-kit run test:carbon`.
CI runs that suite against the Carbon sources in the same checkout (a PR merged with its
current `dev`/`main` base, or the pushed `dev`/`main` commit) and records that commit in
the job summary; evaluation records the revisions used for local evidence. No fixture result is
a claim that ChatGPT, Claude, Gemini or a local inference engine was independently tested.

Runtime dependency: bundled `yaml` 2.9.1 (ISC). Build: esbuild 0.28.2 (MIT).
Browser tests: Playwright 1.64.1 (Apache-2.0). Documentation dates not stated in
package metadata. Project source is MIT; notices are included in the offline HTML.
