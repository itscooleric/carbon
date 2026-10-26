# Cross-model operating contract research

Info current as of 2026-10-19 16:10 ET. Research snapshot; implementation decisions
below are our inferences, not claims of demonstrated cross-provider reliability.

## Recommendation and criteria

Use an explicit bootstrap + versioned Markdown contract + YAML Cast + complete-file
Return. Keep the prompt-driven human review loop as the baseline. A small local
validator adds concrete value by rejecting malformed and unauthorized proposals;
a larger agent framework does not solve missing attachments, evidence quality or
transfer authority. The bounded driver is a mock-tested extension, not a required
execution engine.

Priority order: interoperability across basic chat; durable reconstructable state;
explicit authority and data preservation; small runtime and prompt overhead;
convenience. Falsifiable assumption: notebook-scale assignments can return complete
files within ordinary context limits. Verify with actual required providers before
claiming reliability. Reduce scope when limits are exceeded.

## Mechanism comparison

| Mechanism | Useful capability | Limitation | Decision |
|---|---|---|---|
| Plain bootstrap | Works as pasted user text | Compliance is probabilistic; no enforcement | Required baseline |
| Markdown contract | Readable, versioned, inspectable authority/lifecycle | Must actually be supplied and read | Required, small |
| AGENTS.md convention | Discoverable instructions for compatible coding agents | Ordinary chats need not discover it; no required schema | Optional pointer; never the only bootstrap |
| System/developer instructions | Host can place trusted rules above source content | Roles and configuration differ by provider/interface | Optional adapter placement; same contract text |
| YAML Cast/receipt | Human-editable assignment, status and provenance | YAML ambiguity/aliases need strict validation | YAML 1.2 subset with safe parser |
| Complete files | Easy human reconstruction; exact reviewable bytes | More output tokens than patches; structural truncation detection is incomplete | Required for changed text; smaller assignments |
| Structured output | Constrains API response shape | Schema subsets, refusals, incomplete output, semantic errors | Optional JSON-to-envelope adapter |
| Function/tool calls | Host can stage operations under exact permissions | Tool request is not execution or proof of success | Future approved adapters; same validator |
| MCP | Standard connection to external tools/data | Requires a participating host/server and authorization | Optional transport, no baseline dependency |
| A2A | Tasks, messages and artifacts between agent services | Service discovery/transport/auth overhead; no ordinary-chat support | Optional future service wrapper |
| Markdown Playbooks | User-selectable reusable methods, portable as content | Conflicts and prompt injection remain semantic risks | Explicit selection, ordered embedding, bounded scope |
| Manual human loop | Works without filesystem or APIs | Copy/save/review effort; no automatic factual verification | First-release operating model |

## Five environments

| Environment | Baseline route | Validation and persistence | Tested here |
|---|---|---|---|
| File attachment/download chat | Cast/context/contract files or selected Dispatch archive | Check actual attachment contents; review Return locally | Deterministic fixture only |
| Paste-only chat | Complete `dispatch.md`; copy Return text | Framing/paths/revisions locally checked; user retains original | Offline reconstruction fixture and browser workbench |
| Filesystem/execution agent | Authorized selected files or complete Stack | Stage outputs, report actual tool evidence; portable receipt required | In-memory Carbon bridge, not privileged disk writes |
| Local model without reliable tools | Same pasted workflow; smaller context | No tool-calling assumption; output may require retries | Mock adapter only; no local model inference |
| Structured-output API | Provider schema produces transport data; adapter creates envelope | Validate semantic scope/base after provider shape checks | No live API adapter/provider run |

## Primary source findings

**1. Repository contracts.** Envoy `dev` at
[`7de338d`](https://github.com/itscooleric/envoy/tree/7de338d8836ead00d08c83f929349d9ae2a6747f),
format v0.2 draft; Carbon PR #2 at
[`946cad2`](https://github.com/itscooleric/envoy/pull/2), docs 2026-10-19.
PR #2 merged during implementation; final integration was rechecked on `dev` at
`ada6caca54edce1e3829524a2b3ac287e9d8cbd5`. The exact-v1 profile retains full original bytes and selected scope; Returns update
existing selected Entries only. The independent v0.1 staged envelope is deliberately
additive. The bridge delegates accepted mutations to Carbon's existing Stack checks.

**2. Portable instructions and data syntax.** [AGENTS.md](https://agents.md/),
version/date not stated, documents a Markdown convention with no required fields.
It is useful for participating coding hosts, not evidence of universal discovery.
[YAML](https://yaml.org/spec/1.2.2/), version 1.2.2, revision 2021-10-01, is the
human-authored data format. We reject aliases/tags and duplicate keys rather than
accepting arbitrary YAML behavior. Bundled `yaml` 2.9.1 provides parsing; package
documentation date not stated. Playbooks reuse ordinary Markdown rather than define
an installable plugin or agent identity.

**3. Structured output APIs.** [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
version/date not stated, distinguishes schema-constrained outputs from JSON mode and
requires handling refusals/incomplete responses. [Claude Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
version/date not stated, documents JSON output and strict tool input validation;
refusals/token limits and supported schema constraints still need handling.
[Gemini Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output),
API version not pinned, doc updated 2026-10-13, supports a JSON Schema subset and
explicitly requires application validation of values. Therefore provider formatting
cannot replace Envoy's local authority, base and evidence checks. No model versions
were exercised and no API compatibility is claimed from these documents alone.

**4. Inter-service protocols.** [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28),
revision 2026-07-28, describes tool/data integration. The `/latest` URL resolved to
this revision, despite a contradictory older-version banner; we pin the actual
retrieved revision. [A2A specification](https://a2a-protocol.org/latest/specification/),
displayed protocol 1.0.0; the [1.0.1 route](https://a2a-protocol.org/v1.0.1/specification/)
also displays 1.0.0 in its overview. The [release announcement](https://a2a-protocol.org/dev/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/)
is dated 2026-03-12. We use tasks/artifacts as design references, not assume a 1.0.1
wire implementation. Neither protocol removes the need for a portable file receipt
when the receiving interface has no participating service.

**5. Cadre reference.** [Operating model](https://github.com/itscooleric/cadre/blob/a709395fce56675e55ebd691f854321e41489257/docs/operating-model.md)
and [bootstraps](https://github.com/itscooleric/cadre/blob/a709395fce56675e55ebd691f854321e41489257/templates/role-bootstraps.md),
`CADRE_VERSION=0.2.7-draft`, Git revision `a709395fce56675e55ebd691f854321e41489257`,
source documents dated 2026-10-07; inspected 2026-10-19. We retain external durable
state, replaceable bounded sessions, explicit authority, evidence reconciliation,
checkpoints and compact handoffs. GitHub wrappers, role hierarchy, role IDs, permanent
identities and claims/notification infrastructure are unnecessary for this single-user
portable workflow. Envoy depends on none of them and makes no Cadre modifications.

## Runtime decision and limitations

The prompt loop can perform useful work in basic chat; it cannot guarantee compliance.
The staging validator enforces structural and scope properties. The optional driver
adds finite calls, deadline, per-call timeout, reserved token budget, retries and stop,
while retaining the last valid unaccepted Return. It never accepts changes or invokes
privileged tools. A model's `complete` status ends iteration but remains reported.

The mock adapter counts UTF-8 bytes as deterministic budget units, explicitly not
provider token measurements. A production adapter needs a correct tokenizer/count
operation, enforced output cap, usage reporting and cancellation. An AbortSignal
cannot force a noncooperative remote service to stop billing or executing. Adapter
code is trusted host code, not a sandbox for arbitrary imported programs.

No separate model providers were available as inference tools. API docs, an available
coding assistant and a web search tool do not constitute a comparative experiment.
Provider instruction following, factual quality, injection resistance and actual chat
attachment support remain untested. Host rejection of an injected deletion is tested;
that is not proof that a model resisted the injected instruction.

What would change this design:

- Actual provider runs repeatedly fail complete-file framing despite small assignments:
  prefer supported structured output adapters or a simpler constrained transport.
- Representative users spend more effort copying/reviewing packets than doing the task:
  prioritize Carbon's wizard/receipt UI and measure it before adding autonomous tools.
