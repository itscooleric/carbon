/**
 * Envoy Cast Kit v0.1: pure staging, no network or filesystem operations.
 *
 * This module parses the versioned wire formats (`envoy.cast/v0.1`, `envoy.return/v0.1`,
 * and Carbon's `envoy.handoff/v0.2` exact-v1 framing), registers a trusted dispatch
 * snapshot from user-supplied originals, stages a model's proposed changes for human
 * review, and (only with a complete host Stack and explicit approval) hands an accepted
 * transaction to Carbon. Every input except the host's own Stack object is untrusted.
 * All validators fail closed and throw `Error`s whose messages are contract text.
 *
 * Trust model in one paragraph: a Cast is authority only because the *user* registered it
 * together with the original handoff packet it references. A Return can never widen a
 * Cast, re-register itself, or be accepted without a full Stack. A partial (handoff-only)
 * handle can stage and review proposals but cannot verify omitted bytes or omitted Entry
 * IDs; a complete handle (full Stack) can.
 *
 * @typedef {Object} CastPlaybook
 * @property {string} name  Unique within the Cast; the user's visible label.
 * @property {string} source  Provenance label (e.g. `builtin:research`), never a URL to fetch.
 * @property {string} content  Complete Markdown, 1–16,000 bytes, optional frontmatter.
 *
 * @typedef {Object} CastMetadataPermission
 * @property {string} path  A Markdown path that is also in `Cast.replace`.
 * @property {string[]} keys  Existing top-level scalar frontmatter keys that may change; never `id`.
 *
 * @typedef {Object} CastPermissions
 * @property {boolean} network
 * @property {boolean} execute
 * @property {boolean} write_files
 * @property {string[]} transmit_to  Destination labels the user authorized; may be empty.
 *
 * @typedef {Object} Cast
 * User-authorized assignment (`envoy.cast/v0.1`). All fields are required; unknown keys and
 * other versions fail closed. YAML is not a credential: the host separately approves data
 * selection and transmission.
 * @property {'envoy.cast/v0.1'} format
 * @property {'envoy.operating/v0.1'} contract
 * @property {string} assignment_id  Stable assignment ID.
 * @property {string} dispatch_id  Original Carbon dispatch ID (`dispatch-…`).
 * @property {string} stack_id  Original Stack ID.
 * @property {number} base_revision  Nonnegative safe integer Stack revision.
 * @property {string|null} mission  Accessible Mission path (must be in `read`) or null.
 * @property {string} objective  One nonempty objective; the Return must repeat it exactly.
 * @property {string[]} read  Exact included paths, including `stack.yaml`; no globbing.
 * @property {string[]} replace  Markdown paths that may be replaced; each must be readable.
 * @property {string[]} create  Markdown paths that may be created; must be vacant in the original inventory.
 * @property {string[]} delete  Markdown paths that may be deleted; each must be readable.
 * @property {[string, string][]} rename  `[from, to]` Markdown pairs; `from` readable, `to` vacant.
 * @property {string[]} outputs  Human-readable deliverable descriptions.
 * @property {string[]} constraints  Nonempty strings; the list may be empty.
 * @property {CastPermissions} permissions
 * @property {string[]} completion  Nonempty completion criteria (at least one).
 * @property {'envoy.return/v0.1'} return_format
 * @property {CastPlaybook[]} playbooks  Ordered, at most eight, unique names.
 * @property {CastMetadataPermission[]} metadata  Scalar frontmatter edits allowed per replace path; unique paths.
 * @property {string[]} assets  Exact selected non-Entry paths; actual bytes must be attached at dispatch.
 * @property {string[]} required_files  Create/replace paths a `complete` Return must supply; empty for answers.
 *
 * @typedef {Object} ReturnMeta
 * Receipt metadata of a staged Return (`envoy.return/v0.1`). Identity fields repeat the
 * Cast references; the model cannot change them to retarget a Return.
 * @property {'envoy.return/v0.1'} format
 * @property {string} assignment_id
 * @property {string} dispatch_id
 * @property {string} stack_id
 * @property {number} base_revision
 * @property {string} checkpoint_id  This Return's ID.
 * @property {string|null} parent_checkpoint  Previous checkpoint in a cumulative session, or null.
 * @property {'complete'|'partial'|'blocked'|'failed'|'cancelled'} status
 * @property {string} summary  Nonempty.
 * @property {string} objective  Must equal the Cast objective.
 * @property {string[]} accepted  Accepted facts the model preserved.
 * @property {string[]} evidence  Source, locator, date, claim, confidence/limitation.
 * @property {string[]} decisions
 * @property {string[]} completed
 * @property {string[]} questions  Must be empty when `status` is `complete`.
 * @property {string[]} blockers  Must be empty when `status` is `complete`.
 * @property {string[]} next
 * @property {string[]} verification  Nonempty when `status` is `complete`; still a claim, not proof.
 * @property {string[]} errors  Must be empty when `status` is `complete`.
 * @property {string[]} capabilities  Capabilities the model claims it had.
 * @property {string[]} operations_performed  Side effects the model claims; review obligation.
 * @property {string[]} creates  Markdown paths with full bodies framed in `creates` order.
 * @property {string[]} replaces  Markdown paths with full bodies framed after creates.
 * @property {string[]} deletes
 * @property {[string, string][]} renames  Byte-preserving `[from, to]` pairs.
 * @property {string} boundary  16–100 ASCII letters/digits/hyphens absent from every body.
 *
 * @typedef {Object} StagedChange
 * One reviewable operation in base-inventory order: deletes, then renames, then creates and
 * replaces in Return frame order.
 * @property {'delete'|'rename'|'create'|'replace'} op
 * @property {string} path  Source path (for rename: the `from` path).
 * @property {string} [to]  Rename destination; present only for `rename`.
 * @property {string|null} before  Decoded base text, or null for `create`.
 * @property {string|null} after  Proposed text, null for `delete`, identical to `before` for `rename`.
 *
 * @typedef {Object} StageResult
 * Review data produced by {@link stageReturn}. Nothing here has been written or accepted.
 * @property {ReturnMeta} meta  A deep copy of the validated receipt.
 * @property {StagedChange[]} changes
 * @property {Map<string, string>} files  Proposed full bodies keyed by path (creates + replaces).
 * @property {string[]} warnings  Review obligations the kit cannot discharge; longer for partial handles.
 *
 * @typedef {Readonly<{assignment_id: string, stack_id: string, base_revision: number, complete: boolean}>} TrustedHandle
 * Frozen key into this module's private snapshot store. `complete` is true only for a
 * handle from {@link registerStack}, which retains every base byte and directory. The
 * handle carries no bytes itself; a foreign object with the same fields is "Unknown
 * trusted dispatch".
 *
 * @typedef {Object} HostStack
 * The host's (Carbon's) in-memory Stack as this module reads it. Trusted host code; the
 * kit still re-verifies it byte-for-byte against its snapshot before acceptance.
 * @property {Map<string, Uint8Array>} files  Every file, including `stack.yaml` and binaries.
 * @property {{id: string, revision: number}} manifest  Parsed `stack.yaml` identity.
 * @property {Iterable<string>} directories  Every directory path, including empty ones.
 * @property {(transaction: {writes: Map<string, Uint8Array>, deletes: string[], moves: [string, string][]}) => HostStack} [change]
 *   Carbon's atomic transaction; required only by {@link acceptInCarbon}.
 *
 * @typedef {Object} AcceptanceRecord
 * Receipt the host persists next to the accepted Return.
 * @property {string} assignment_id
 * @property {string} checkpoint_id
 * @property {string} stack_id
 * @property {number} base_revision  Revision the Return was staged against.
 * @property {number} accepted_revision  Revision Carbon produced.
 *
 * @typedef {Object} AcceptanceResult
 * @property {HostStack} next  The Stack Carbon returned from `change()`.
 * @property {string} receipt  The exact Return source that was accepted.
 * @property {HostStack} previous  The Stack that was passed in, untouched.
 * @property {AcceptanceRecord} acceptance
 *
 * @typedef {Object} HandoffMeta
 * Carbon `envoy.handoff/v0.2` exact-v1 metadata as read by {@link readHandoff}.
 * @property {'envoy.handoff/v0.2'} format
 * @property {'exact-v1'} framing
 * @property {string} dispatch_id
 * @property {string} stack_id
 * @property {number} base_revision
 * @property {'selected-text'|'full-text'} scope
 * @property {string[]} included_files  Always contains `stack.yaml`; otherwise Markdown only.
 * @property {string[]} omitted_files  Empty when scope is `full-text`.
 * @property {string} boundary
 *
 * @typedef {Object} HandoffResult
 * @property {HandoffMeta} meta
 * @property {Map<string, Uint8Array>} files  Included file bytes in packet order.
 * @property {{format: string, id: string, revision: number, [key: string]: unknown}} manifest  Parsed `stack.yaml`.
 *
 * @typedef {Object} DispatchContext
 * Adapter-safe copy returned by {@link contextFor}; mutating it never affects the handle.
 * @property {Cast} cast
 * @property {Record<string, string>} files  Decoded text of every `Cast.read` path.
 * @property {string[]} omitted  Paths in the original inventory that were not included.
 */
import {
  check, boundedText, id, revision, yaml, dump, keys, strings, path, paths, vacant, entry,
  encode, decode, equal, sameList, LIMITS, patchScalarFrontmatter
} from './validation.mjs';

export { LIMITS, encode, decode, dump };

/** Exact key set of a v0.1 Cast; any other key is an unsupported extension. */
const CAST_KEYS = [
  'format', 'contract', 'assignment_id', 'dispatch_id', 'stack_id', 'base_revision',
  'mission', 'objective', 'read', 'replace', 'create', 'delete', 'rename', 'outputs',
  'constraints', 'permissions', 'completion', 'return_format', 'playbooks', 'metadata',
  'assets', 'required_files'
];
/** Exact key set of a v0.1 Return receipt. */
const RETURN_KEYS = [
  'format', 'assignment_id', 'dispatch_id', 'stack_id', 'base_revision', 'checkpoint_id',
  'parent_checkpoint', 'status', 'summary', 'objective', 'accepted', 'evidence', 'decisions',
  'completed', 'questions', 'blockers', 'next', 'verification', 'errors', 'capabilities',
  'operations_performed', 'creates', 'replaces', 'deletes', 'renames', 'boundary'
];
/** Receipt fields that are lists of nonblank strings. */
const ARRAY_FIELDS = [
  'accepted', 'evidence', 'decisions', 'completed', 'questions', 'blockers', 'next',
  'verification', 'errors', 'capabilities', 'operations_performed'
];
const RETURN_STATUSES = ['complete', 'partial', 'blocked', 'failed', 'cancelled'];
const CAST_IDENTITY_FIELDS = ['assignment_id', 'dispatch_id', 'stack_id'];
const RETURN_IDENTITY_FIELDS = ['assignment_id', 'dispatch_id', 'stack_id', 'checkpoint_id'];
const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FORBIDDEN_METADATA_KEYS = ['id', '__proto__', 'constructor', 'prototype'];
const BOUNDARY_PATTERN = /^[A-Za-z0-9-]{16,100}$/;
const DISPATCH_ID_PATTERN = /^dispatch-[a-z0-9-]{1,80}$/;
const MARKDOWN_PATH = /\.md$/i;

/**
 * Private snapshot store: TrustedHandle → {cast, selected, allPaths, directories, base}.
 * Handles are the only way in; the Map is weak so abandoned handles release their bytes.
 * @type {WeakMap<TrustedHandle, {cast: Cast, selected: Map<string, Uint8Array>, allPaths: string[], directories: string[], base: Map<string, Uint8Array>|null}>}
 */
const snapshots = new WeakMap();

/**
 * Require a portable Markdown Entry path that is not the manifest.
 * @param {unknown} p
 * @throws {Error} path() errors | 'Only Markdown Entry proposals supported'
 */
function markdown(p) {
  path(p);
  check(MARKDOWN_PATH.test(p) && p !== 'stack.yaml', 'Only Markdown Entry proposals supported');
}

/**
 * Require a bounded list of `[from, to]` Markdown rename pairs with distinct endpoints.
 * @param {unknown} list
 * @throws {Error} 'Invalid rename list' | 'Rename requires from/to' | markdown() errors | 'Rename must change path'
 */
function renamePairs(list) {
  check(Array.isArray(list) && list.length <= LIMITS.operations, 'Invalid rename list');
  for (const pair of list) {
    check(Array.isArray(pair) && pair.length === 2, 'Rename requires from/to');
    pair.forEach(markdown);
    check(pair[0] !== pair[1], 'Rename must change path');
  }
}

/**
 * Validate `Cast.playbooks`: at most eight, each `{name, source, content}` with nonblank
 * bounded Markdown content that parses as an Entry, and unique names.
 * @param {Cast} c
 */
function checkPlaybooks(c) {
  check(Array.isArray(c.playbooks) && c.playbooks.length <= 8, 'At most eight Playbooks');
  for (const playbook of c.playbooks) {
    keys(playbook, ['name', 'source', 'content']);
    strings([playbook.name, playbook.source]);
    boundedText(playbook.content, 16000);
    check(playbook.content.trim(), 'Empty Playbook');
    entry(playbook.content);
  }
  const names = new Set(c.playbooks.map(p => p.name));
  check(names.size === c.playbooks.length, 'Duplicate Playbook name');
}

/**
 * Validate `Cast.metadata` shape: bounded list of `{path, keys}` where each key is a
 * plain identifier that is not `id` or a prototype name, keys are unique, paths are unique.
 * Scope (path must be in `replace`) is checked later, after `replace` itself is validated.
 * @param {Cast} c
 */
function checkMetadataPermissions(c) {
  check(Array.isArray(c.metadata) && c.metadata.length <= LIMITS.operations, 'Invalid metadata permission');
  for (const permission of c.metadata) {
    keys(permission, ['path', 'keys']);
    markdown(permission.path);
    strings(permission.keys);
    const keyList = permission.keys;
    const validKeys = keyList.length
      && new Set(keyList).size === keyList.length
      && keyList.every(k => METADATA_KEY_PATTERN.test(k) && !FORBIDDEN_METADATA_KEYS.includes(k));
    check(validKeys, 'Invalid metadata key permission');
  }
  const metadataPaths = new Set(c.metadata.map(m => m.path));
  check(metadataPaths.size === c.metadata.length, 'Duplicate metadata path');
}

/**
 * Validate the Cast's version identifiers, IDs, revision and objective.
 * @param {Cast} c
 */
function checkCastIdentity(c) {
  const supported = c.format === 'envoy.cast/v0.1'
    && c.contract === 'envoy.operating/v0.1'
    && c.return_format === 'envoy.return/v0.1';
  check(supported, 'Unsupported Cast version');
  CAST_IDENTITY_FIELDS.forEach(k => id(c[k]));
  revision(c.base_revision);
  boundedText(c.objective, LIMITS.yaml);
  check(c.objective.trim(), 'Objective required');
}

/**
 * Validate the Cast's path allowlists and their cross-references: `read` may hold any
 * portable path; `replace`/`create`/`delete`/`rename` hold Markdown paths; required
 * deliverables and metadata permissions must be inside the write scope.
 * @param {Cast} c
 */
function checkCastScope(c) {
  for (const list of ['read', 'replace', 'create', 'delete']) {
    paths(c[list]);
    if (list !== 'read') c[list].forEach(markdown);
  }
  renamePairs(c.rename);
  paths(c.required_files);
  const inWriteScope = p => c.create.includes(p) || c.replace.includes(p);
  check(c.required_files.every(inWriteScope), 'Required deliverable must be in create/replace scope');
  check(c.metadata.every(m => c.replace.includes(m.path)), 'Metadata permission requires replacement scope');
}

/**
 * Validate the Cast's human-readable lists, mission reference, permissions block and the
 * rule that every mutation source is readable.
 * @param {Cast} c
 */
function checkCastTerms(c) {
  for (const list of ['outputs', 'constraints', 'completion']) strings(c[list]);
  check(c.completion.length > 0, 'Completion criteria required');
  if (c.mission !== null) check(c.read.includes(path(c.mission)), 'Mission must be an accessible file');
  keys(c.permissions, ['network', 'execute', 'write_files', 'transmit_to']);
  for (const flag of ['network', 'execute', 'write_files']) {
    check(typeof c.permissions[flag] === 'boolean', 'Permission must be boolean');
  }
  strings(c.permissions.transmit_to);
  const mutationSources = [...c.replace, ...c.delete, ...c.rename.map(pair => pair[0])];
  for (const p of mutationSources) check(c.read.includes(p), 'Mutation source must be readable');
}

/**
 * Read a versioned YAML assignment; unknown fields fail closed.
 *
 * Validation order (the first failure is thrown): YAML shape and exact key set → `assets`
 * are portable non-Entry paths → Playbooks → metadata permission shape → version identifiers,
 * IDs, revision, objective → path allowlists, renames, required files, metadata scope →
 * outputs/constraints/completion, mission, permissions, readable mutation sources.
 *
 * Trust: the source is untrusted text. A valid Cast is still only an *assignment* until the
 * user registers it with its original handoff ({@link registerHandoff}); parsing grants no
 * authority by itself.
 * @param {string} source  Cast YAML.
 * @returns {Cast} Plain validated data (a fresh object; safe to mutate).
 * @throws {Error} Any validation.mjs error, or one of: 'Assets must be non-Entry paths',
 *   'At most eight Playbooks', 'Empty Playbook', 'Duplicate Playbook name',
 *   'Invalid metadata permission', 'Invalid metadata key permission', 'Duplicate metadata path',
 *   'Unsupported Cast version', 'Objective required', 'Only Markdown Entry proposals supported',
 *   'Invalid rename list', 'Rename requires from/to', 'Rename must change path',
 *   'Required deliverable must be in create/replace scope',
 *   'Metadata permission requires replacement scope', 'Completion criteria required',
 *   'Mission must be an accessible file', 'Permission must be boolean',
 *   'Mutation source must be readable'.
 */
export function parseCast(source) {
  const c = yaml(source);
  keys(c, CAST_KEYS);
  paths(c.assets);
  const nonEntry = p => p !== 'stack.yaml' && !MARKDOWN_PATH.test(p);
  check(c.assets.every(nonEntry), 'Assets must be non-Entry paths');
  checkPlaybooks(c);
  checkMetadataPermissions(c);
  checkCastIdentity(c);
  checkCastScope(c);
  checkCastTerms(c);
  return c;
}

/**
 * Validate a parsed Return receipt independently of any Cast (structure, status
 * consistency, operation lists, boundary). Shared by {@link encodeReturn} and
 * {@link parseReturn}. Cast authorization happens later in {@link stageReturn}.
 * @param {ReturnMeta} m
 * @throws {Error} validation.mjs errors or: 'Unsupported Return version',
 *   'Checkpoint cannot parent itself', 'Invalid completion status', 'Summary/objective required',
 *   'Complete requires verification and no unresolved items', 'Only Markdown Entry proposals supported',
 *   rename errors, 'Operation limit', 'Path collision: <path>', 'Invalid boundary'.
 */
function checkReturn(m) {
  keys(m, RETURN_KEYS);
  check(m.format === 'envoy.return/v0.1', 'Unsupported Return version');
  RETURN_IDENTITY_FIELDS.forEach(k => id(m[k]));
  revision(m.base_revision);
  if (m.parent_checkpoint !== null) id(m.parent_checkpoint);
  check(m.parent_checkpoint !== m.checkpoint_id, 'Checkpoint cannot parent itself');
  check(RETURN_STATUSES.includes(m.status), 'Invalid completion status');
  for (const field of ['summary', 'objective']) {
    boundedText(m[field], LIMITS.yaml);
    check(m[field].trim(), 'Summary/objective required');
  }
  ARRAY_FIELDS.forEach(k => strings(m[k]));
  if (m.status === 'complete') {
    const resolved = !m.blockers.length && !m.errors.length && !m.questions.length && m.verification.length > 0;
    check(resolved, 'Complete requires verification and no unresolved items');
  }
  for (const list of ['creates', 'replaces', 'deletes']) {
    paths(m[list]);
    m[list].forEach(markdown);
  }
  renamePairs(m.renames);
  const touches = [...m.creates, ...m.replaces, ...m.deletes, ...m.renames.flat()];
  check(touches.length <= LIMITS.operations, 'Operation limit');
  // One operation per portable path: a case variant cannot pair a delete with a fresh create.
  paths(touches);
  check(typeof m.boundary === 'string' && BOUNDARY_PATTERN.test(m.boundary), 'Invalid boundary');
}

/** Opening marker of one Return file frame; the body starts after its LF. */
const framePrefix = (boundary, p) => `<!-- envoy-cast:file boundary="${boundary}" path="${encodeURIComponent(p)}" -->\n`;
/** Closing marker of one Return file frame, preceded by exactly one framing LF. */
const frameSuffix = boundary => `\n<!-- envoy-cast:end boundary="${boundary}" -->\n\n`;
/** Required final line of a Return packet. */
const completionSentinel = (boundary, count) => `<!-- envoy-cast:complete boundary="${boundary}" files="${count}" -->\n`;
const RETURN_HEADER = /^# Envoy Cast Return\n\n```yaml\n([\s\S]*?)\n```\n\n/;
const HANDOFF_HEADER = /^# Envoy Handoff\n\n```yaml\n([\s\S]*?)\n```\n\n/;

/**
 * Complete files with exact newline framing and a required final count sentinel.
 *
 * Frames are emitted in `creates` order then `replaces` order. Bodies are written verbatim
 * (CRLF, missing or multiple trailing newlines preserved); each must be within
 * `LIMITS.text` and must not contain the boundary.
 *
 * Trust: `meta` is validated with the same rules as a parsed Return, so a host cannot
 * accidentally emit an invalid packet; `files` keys must equal creates + replaces exactly.
 * Pure; no side effects.
 * @param {ReturnMeta} meta
 * @param {Map<string, string>} files  Full body per created/replaced path.
 * @returns {string} The packet text, at most `LIMITS.packet`.
 * @throws {Error} checkReturn() errors | 'File inventory mismatch' | 'Boundary collision' | boundedText errors
 */
export function encodeReturn(meta, files) {
  checkReturn(meta);
  const order = [...meta.creates, ...meta.replaces];
  check(sameList(files.keys(), order), 'File inventory mismatch');
  let packet = '# Envoy Cast Return\n\n```yaml\n' + dump(meta) + '```\n\n';
  for (const p of order) {
    const body = files.get(p);
    boundedText(body);
    check(!body.includes(meta.boundary), 'Boundary collision');
    packet += framePrefix(meta.boundary, p) + body + frameSuffix(meta.boundary);
  }
  packet += completionSentinel(meta.boundary, order.length);
  boundedText(packet, LIMITS.packet);
  return packet;
}

/**
 * Strict parser: never repairs truncated, reordered, extra or duplicate frames.
 *
 * Parsing order: packet size → header and YAML receipt ({@link checkReturn}) → one frame per
 * path in creates-then-replaces order, each located by exact marker text → the completion
 * sentinel must be the entire remaining text.
 *
 * Trust: `source` is model output. A syntactically valid packet proves only structural
 * completeness; it does not prove the bodies are complete or truthful. Pure.
 * @param {string} source
 * @returns {{meta: ReturnMeta, files: Map<string, string>}} Receipt and bodies in frame order.
 * @throws {Error} boundedText errors | 'Invalid Cast Return header' | checkReturn() errors |
 *   'Missing/reordered file frame: <path>' | 'Truncated file frame' | 'Boundary collision' |
 *   'Missing completion sentinel or trailing content'
 */
export function parseReturn(source) {
  boundedText(source, LIMITS.packet);
  const header = RETURN_HEADER.exec(source);
  check(header, 'Invalid Cast Return header');
  const meta = yaml(header[1]);
  checkReturn(meta);
  const files = new Map();
  const order = [...meta.creates, ...meta.replaces];
  const suffix = frameSuffix(meta.boundary);
  let offset = header[0].length;
  for (const p of order) {
    const prefix = framePrefix(meta.boundary, p);
    check(source.startsWith(prefix, offset), 'Missing/reordered file frame: ' + p);
    offset += prefix.length;
    const end = source.indexOf(suffix, offset);
    check(end >= offset, 'Truncated file frame');
    const body = source.slice(offset, end);
    boundedText(body);
    check(!body.includes(meta.boundary), 'Boundary collision');
    files.set(p, body);
    offset = end + suffix.length;
  }
  const trailer = source.slice(offset);
  check(trailer === completionSentinel(meta.boundary, order.length), 'Missing completion sentinel or trailing content');
  return { meta, files };
}

/**
 * Read existing Carbon exact-v1 framing without changing its v0.2 semantics.
 *
 * Accepts only `envoy.handoff/v0.2` with `framing: exact-v1`, a `dispatch-…` dispatch ID,
 * an inventory whose included files are `stack.yaml` plus Markdown, and frames in
 * `included_files` order with nothing after the last one. The embedded `stack.yaml` must
 * agree with the packet's Stack ID and revision.
 *
 * Trust: the packet is untrusted text, but the *user* chooses which packet to register, so
 * its provenance is the user's responsibility ({@link registerHandoff}). Pure.
 * @param {string} source
 * @returns {HandoffResult}
 * @throws {Error} 'Expected Carbon exact-v1 handoff' | 'Unsupported handoff version/framing' |
 *   'Invalid dispatch ID' | 'Invalid handoff boundary' | 'Invalid handoff scope' |
 *   'Invalid handoff inventory' | 'Missing handoff frame' | 'Truncated handoff' |
 *   'Handoff boundary collision' | 'Unexpected handoff content' | 'Handoff/manifest mismatch' |
 *   validation.mjs errors
 */
export function readHandoff(source) {
  boundedText(source, LIMITS.packet);
  const header = HANDOFF_HEADER.exec(source);
  check(header, 'Expected Carbon exact-v1 handoff');
  const m = yaml(header[1]);
  keys(m, ['format', 'framing', 'dispatch_id', 'stack_id', 'base_revision', 'scope', 'included_files', 'omitted_files', 'boundary']);
  check(m.format === 'envoy.handoff/v0.2' && m.framing === 'exact-v1', 'Unsupported handoff version/framing');
  id(m.stack_id);
  revision(m.base_revision);
  check(DISPATCH_ID_PATTERN.test(m.dispatch_id), 'Invalid dispatch ID');
  check(typeof m.boundary === 'string' && BOUNDARY_PATTERN.test(m.boundary), 'Invalid handoff boundary');
  strings(m.included_files);
  strings(m.omitted_files);
  paths([...m.included_files, ...m.omitted_files]);
  const scopeConsistent = ['selected-text', 'full-text'].includes(m.scope)
    && (m.scope !== 'full-text' || !m.omitted_files.length);
  check(scopeConsistent, 'Invalid handoff scope');
  const textInventory = m.included_files.includes('stack.yaml')
    && m.included_files.every(p => p === 'stack.yaml' || MARKDOWN_PATH.test(p));
  check(textInventory, 'Invalid handoff inventory');
  const files = new Map();
  let offset = header[0].length;
  for (const p of m.included_files) {
    const encodedPath = encodeURIComponent(p);
    const pre = `## File: ${encodedPath}\n<!-- envoy:begin boundary="${m.boundary}" path="${encodedPath}" -->\n`;
    const post = `\n<!-- envoy:end boundary="${m.boundary}" -->\n\n`;
    check(source.startsWith(pre, offset), 'Missing handoff frame');
    offset += pre.length;
    const end = source.indexOf(post, offset);
    check(end >= offset, 'Truncated handoff');
    const body = source.slice(offset, end);
    boundedText(body);
    check(!body.includes(m.boundary), 'Handoff boundary collision');
    files.set(p, encode(body));
    offset = end + post.length;
  }
  check(offset === source.length, 'Unexpected handoff content');
  const manifest = yaml(decode(files.get('stack.yaml')));
  const manifestMatches = manifest.format === 'envoy.stack/v0.2'
    && manifest.id === m.stack_id
    && manifest.revision === m.base_revision;
  check(manifestMatches, 'Handoff/manifest mismatch');
  return { meta: m, files, manifest };
}

/**
 * Snapshot a validated Cast with its source bytes and mint a {@link TrustedHandle}.
 *
 * Checks that every `Cast.read` path (including `stack.yaml`) is present in `files`, that
 * every create/rename target is vacant in the full inventory (case-insensitively, against
 * files and directories), and that every selected Markdown input parses as an Entry.
 * Copies the selected bytes (and, for a complete handle, every base byte) so later caller
 * mutations cannot alter the snapshot.
 * @param {Cast} c  Already validated.
 * @param {Map<string, Uint8Array>} files  Selected or full file bytes.
 * @param {string[]} allPaths  Full original inventory (included + omitted).
 * @param {Iterable<string>} [directories=[]]  Known directories (complete handles only).
 * @param {boolean} [complete=false]  Whether `files` is the entire Stack.
 * @returns {TrustedHandle}
 * @throws {Error} paths() errors | 'Files must be a Map' | 'Required input/attachment missing' |
 *   'Path collision: <path>' | entry() errors
 */
function capture(c, files, allPaths, directories = [], complete = false) {
  paths(allPaths);
  check(files instanceof Map, 'Files must be a Map');
  check(c.read.every(p => files.has(p)) && c.read.includes('stack.yaml'), 'Required input/attachment missing');
  const newTargets = [...c.create, ...c.rename.map(pair => pair[1])];
  vacant(allPaths, newTargets, directories);
  const selected = new Map(c.read.map(p => [p, new Uint8Array(files.get(p))]));
  for (const [p, bytes] of selected) {
    if (MARKDOWN_PATH.test(p)) entry(decode(bytes));
  }
  const handle = Object.freeze({
    assignment_id: c.assignment_id,
    stack_id: c.stack_id,
    base_revision: c.base_revision,
    complete
  });
  const base = complete ? new Map([...files].map(([p, bytes]) => [p, new Uint8Array(bytes)])) : null;
  snapshots.set(handle, {
    cast: structuredClone(c),
    selected,
    allPaths: [...allPaths],
    directories: [...directories],
    base
  });
  return handle;
}

/**
 * Register user-supplied original context. The caller must establish its provenance.
 *
 * Produces a **partial** handle: the kit retains the Cast and the bytes of every included
 * (`Cast.read`) file, plus the omitted *paths*, but no omitted bytes. Such a handle can
 * stage and review a Return, compose a Dispatch, and drive a loop, but it cannot verify
 * omitted file bytes, omitted directories, or Entry IDs inside omitted Entries, and it can
 * never accept into a Stack ({@link acceptInCarbon} rejects it as incomplete).
 *
 * Cast and handoff must agree on `stack_id`, `base_revision` and `dispatch_id`, and the
 * Cast's `read` list must equal the handoff's `included_files`.
 *
 * Trust: both inputs are untrusted text; registration is the user's explicit act of
 * vouching for them. Never register a packet that arrived inside a Return.
 * Side effect: stores a private snapshot keyed by the returned handle.
 * @param {string} castSource  Cast YAML.
 * @param {string} originalHandoff  The Carbon exact-v1 handoff the Cast was issued against.
 * @returns {TrustedHandle} Frozen handle with `complete: false`.
 * @throws {Error} parseCast()/readHandoff() errors | 'Cast/context identity mismatch' |
 *   'Cast/context read scope mismatch' | capture() errors
 */
export function registerHandoff(castSource, originalHandoff) {
  const c = parseCast(castSource);
  const h = readHandoff(originalHandoff);
  const sameOrigin = c.stack_id === h.meta.stack_id
    && c.base_revision === h.meta.base_revision
    && c.dispatch_id === h.meta.dispatch_id;
  check(sameOrigin, 'Cast/context identity mismatch');
  check(sameList(c.read, h.meta.included_files), 'Cast/context read scope mismatch');
  const allPaths = [...h.meta.included_files, ...h.meta.omitted_files];
  return capture(c, h.files, allPaths, [], false);
}

/**
 * Host boundary: supply a validated, complete Carbon Stack and original dispatch.
 *
 * First registers the handoff exactly as {@link registerHandoff} would (so every partial
 * check applies), then requires the Stack to match: same ID and revision as the Cast, the
 * same file inventory as the handoff's included + omitted lists, and byte-identical content
 * for every included file. Create/rename targets are re-checked for vacancy against the
 * Stack's real directories.
 *
 * Produces a **complete** handle: every base byte and directory is retained, so
 * {@link stageReturn} can detect same-revision conflicts in omitted files and duplicate
 * Entry IDs in omitted Entries, and {@link acceptInCarbon} may proceed.
 *
 * Trust: `stack` is the host's own object; the Cast and handoff remain untrusted text.
 * Side effect: stores two snapshots (the intermediate partial one is unreachable afterwards).
 * @param {HostStack} stack
 * @param {string} castSource
 * @param {string} originalHandoff
 * @returns {TrustedHandle} Frozen handle with `complete: true`.
 * @throws {Error} registerHandoff() errors | 'Stack identity or stale revision' |
 *   'Full Stack inventory differs' | 'Conflicting local file: <path>' | capture() errors
 */
export function registerStack(stack, castSource, originalHandoff) {
  const partial = registerHandoff(castSource, originalHandoff);
  const s = snapshots.get(partial);
  const c = s.cast;
  const sameIdentity = stack.manifest.id === c.stack_id && stack.manifest.revision === c.base_revision;
  check(sameIdentity, 'Stack identity or stale revision');
  check(sameList(stack.files.keys(), s.allPaths), 'Full Stack inventory differs');
  for (const [p, bytes] of s.selected) check(equal(bytes, stack.files.get(p)), 'Conflicting local file: ' + p);
  return capture(c, stack.files, s.allPaths, stack.directories, true);
}

/**
 * Return an adapter-safe copy of selected inputs; never expose omitted bytes.
 *
 * Every call returns fresh copies (deep-cloned Cast, newly decoded strings), so adapters
 * and prompts can mutate the result freely without touching the snapshot. Pure.
 * @param {TrustedHandle} handle
 * @returns {DispatchContext}
 * @throws {Error} 'Unknown trusted dispatch' | decode() errors
 */
export function contextFor(handle) {
  const s = snapshots.get(handle);
  check(s, 'Unknown trusted dispatch');
  const files = Object.fromEntries([...s.selected].map(([p, bytes]) => [p, decode(bytes)]));
  const omitted = s.allPaths.filter(p => !s.selected.has(p));
  return { cast: structuredClone(s.cast), files, omitted };
}

/**
 * Require the host's current Stack to equal a complete snapshot byte-for-byte: same ID and
 * revision, same file inventory, same directory set, same bytes in every file. A partial
 * snapshot (`base === null`) always fails, which is how partial handles are refused at
 * acceptance.
 * @param {HostStack} stack
 * @param {{cast: Cast, base: Map<string, Uint8Array>|null, directories: string[]}} s
 * @throws {Error} 'Stale or incomplete base' | 'Conflicting local file: <path>'
 */
function currentMatches(stack, s) {
  const sameShape = s.base
    && stack.manifest.id === s.cast.stack_id
    && stack.manifest.revision === s.cast.base_revision
    && sameList(stack.files.keys(), s.base.keys())
    && sameList(stack.directories, s.directories);
  check(sameShape, 'Stale or incomplete base');
  for (const [p, bytes] of s.base) check(equal(bytes, stack.files.get(p)), 'Conflicting local file: ' + p);
}

/**
 * Metadata edits are confined to authorized existing scalar values and exact source spans.
 *
 * If the raw frontmatter is unchanged nothing else is checked. Otherwise both documents
 * must have frontmatter, `allowed` must be nonempty, the `id` must be unchanged, and
 * re-applying each allowed scalar change with {@link patchScalarFrontmatter} onto the old
 * span must reproduce the new span exactly. Narrow source-span patching preserves comments,
 * unknown keys, field order and whitespace, so any other difference is rejected.
 * @param {string} before  Base Entry text.
 * @param {string} after  Proposed Entry text.
 * @param {string[]} allowed  Keys from the matching `Cast.metadata` permission, or `[]`.
 * @throws {Error} entry() errors | 'Replacement must preserve exact frontmatter' |
 *   'Stable Entry ID cannot change' | 'Only existing scalar metadata changes supported' |
 *   'Unauthorized metadata or formatting change'
 */
function validateMetadata(before, after, allowed) {
  const old = entry(before);
  const next = entry(after);
  if (old.frontmatter === next.frontmatter) return;
  check(allowed.length && old.frontmatter && next.frontmatter, 'Replacement must preserve exact frontmatter');
  check(old.data.id === next.data.id, 'Stable Entry ID cannot change');
  const scalar = v => ['string', 'number', 'boolean'].includes(typeof v);
  let candidate = old.frontmatter;
  for (const key of allowed) {
    const a = old.data[key];
    const b = next.data[key];
    const existingScalars = Object.hasOwn(old.data, key) && Object.hasOwn(next.data, key) && scalar(a) && scalar(b);
    check(existingScalars, 'Only existing scalar metadata changes supported');
    if (a !== b) candidate = patchScalarFrontmatter(candidate, key, b);
  }
  check(candidate === next.frontmatter, 'Unauthorized metadata or formatting change');
}

/**
 * Authorize a parsed Return against the registered Cast: identity and base revision,
 * exact objective, every operation inside its allowlist, and (for `complete`) every
 * required deliverable supplied.
 * @param {ReturnMeta} m
 * @param {Cast} c
 * @param {Map<string, string>} files
 * @throws {Error} 'Return identity or stale base: <field>' | 'Objective differs from assignment' |
 *   'Unauthorized creates' | 'Unauthorized replaces' | 'Unauthorized deletes' | 'Unauthorized rename' |
 *   'Complete Return is missing required deliverable'
 */
function checkReturnAgainstCast(m, c, files) {
  for (const field of ['assignment_id', 'dispatch_id', 'stack_id', 'base_revision']) {
    check(m[field] === c[field], 'Return identity or stale base: ' + field);
  }
  check(m.objective === c.objective, 'Objective differs from assignment');
  for (const [returnList, castList] of [['creates', 'create'], ['replaces', 'replace'], ['deletes', 'delete']]) {
    check(m[returnList].every(p => c[castList].includes(p)), 'Unauthorized ' + returnList);
  }
  const authorizedRename = pair => c.rename.some(allowed => allowed[0] === pair[0] && allowed[1] === pair[1]);
  check(m.renames.every(authorizedRename), 'Unauthorized rename');
  if (m.status === 'complete') {
    check(c.required_files.every(p => files.has(p)), 'Complete Return is missing required deliverable');
  }
}

/**
 * Apply the Return's operations to a working copy of the selected bytes and inventory,
 * producing the reviewable change list. Order: deletes, renames, then framed files.
 * Each create must be vacant and each replace must exist; new Entries need an `id`;
 * replacements go through {@link validateMetadata}. Finally the resulting inventory is
 * re-checked for path collisions.
 * @param {{cast: Cast, selected: Map<string, Uint8Array>, allPaths: string[]}} s
 * @param {ReturnMeta} m
 * @param {Map<string, string>} files
 * @returns {StagedChange[]}
 * @throws {Error} 'Missing deletion source' | 'Invalid rename' | 'Create/replace existence mismatch' |
 *   entry() errors | 'New managed Entry requires an ID' | validateMetadata() errors |
 *   'Path collision: <path>'
 */
function applyOperations(s, m, files) {
  const c = s.cast;
  const result = new Map(s.selected);
  const inventory = new Set(s.allPaths);
  const changes = [];
  for (const p of m.deletes) {
    check(result.has(p), 'Missing deletion source');
    changes.push({ op: 'delete', path: p, before: decode(result.get(p)), after: null });
    result.delete(p);
    inventory.delete(p);
  }
  for (const [from, to] of m.renames) {
    check(result.has(from) && !inventory.has(to), 'Invalid rename');
    const bytes = result.get(from);
    changes.push({ op: 'rename', path: from, to, before: decode(bytes), after: decode(bytes) });
    result.delete(from);
    result.set(to, bytes);
    inventory.delete(from);
    inventory.add(to);
  }
  for (const [p, body] of files) {
    const exists = inventory.has(p);
    check(m.creates.includes(p) ? !exists : result.has(p), 'Create/replace existence mismatch');
    const proposed = entry(body);
    if (!exists) check(proposed.data.id, 'New managed Entry requires an ID');
    if (exists) {
      const allowedKeys = c.metadata.find(permission => permission.path === p)?.keys || [];
      validateMetadata(decode(result.get(p)), body, allowedKeys);
    }
    changes.push({
      op: exists ? 'replace' : 'create',
      path: p,
      before: exists ? decode(result.get(p)) : null,
      after: body
    });
    result.set(p, encode(body));
    inventory.add(p);
  }
  paths([...inventory]);
  return changes;
}

/**
 * Require unique Entry IDs across the post-change inventory. With a complete snapshot the
 * scan covers every base file (so an omitted Entry's ID is protected); with a partial
 * snapshot only the selected files can be scanned.
 * @param {{selected: Map<string, Uint8Array>, base: Map<string, Uint8Array>|null}} s
 * @param {ReturnMeta} m
 * @param {Map<string, string>} files
 * @throws {Error} entry() errors | 'Duplicate Entry ID'
 */
function checkEntryIds(s, m, files) {
  const inspect = new Map(s.base || s.selected);
  for (const p of m.deletes) inspect.delete(p);
  for (const [from, to] of m.renames) {
    inspect.set(to, inspect.get(from));
    inspect.delete(from);
  }
  for (const [p, body] of files) inspect.set(p, encode(body));
  const ids = new Set();
  for (const [p, bytes] of inspect) {
    if (!MARKDOWN_PATH.test(p)) continue;
    const { data } = entry(decode(bytes));
    if (!data.id) continue;
    check(!ids.has(data.id), 'Duplicate Entry ID');
    ids.add(data.id);
  }
}

/**
 * Review obligations the kit cannot discharge for this snapshot.
 * @param {{base: Map<string, Uint8Array>|null}} s
 * @returns {string[]}
 */
function stageWarnings(s) {
  if (s.base) return ['Evidence, completion and preservation claims require human review.'];
  return [
    'Partial context: omitted bytes and IDs cannot be verified here. Retain the complete original Stack.',
    'Evidence and completion claims require human review.'
  ];
}

/**
 * Validate a proposal and return review data. This never writes or accepts files.
 *
 * Order (first failure thrown): handle lookup → optional `current` Stack must still equal a
 * complete snapshot ({@link currentMatches}) → packet parse ({@link parseReturn}) → Cast
 * authorization ({@link checkReturnAgainstCast}) → operations applied to a working copy
 * ({@link applyOperations}) → Entry ID uniqueness ({@link checkEntryIds}).
 *
 * Partial vs complete handles: with a partial handle, `before` texts and ID checks cover
 * only the included files; omitted bytes, omitted directories and omitted Entry IDs are
 * unverifiable and the warnings say so. With a complete handle the ID scan covers the whole
 * Stack and a `current` Stack can be verified byte-for-byte. Passing `current` with a
 * partial handle always throws 'Stale or incomplete base'.
 *
 * Trust: `source` is model output; `handle` is the only authority. Pure apart from reading
 * the snapshot; the result holds copies.
 * @param {TrustedHandle} handle
 * @param {string} source  Return packet text.
 * @param {HostStack|null} [current=null]  The host's live Stack, for same-revision conflict detection.
 * @returns {StageResult}
 * @throws {Error} 'Unknown trusted dispatch' | currentMatches() errors | parseReturn() errors |
 *   checkReturnAgainstCast() errors | applyOperations() errors | 'Duplicate Entry ID'
 */
export function stageReturn(handle, source, current = null) {
  const s = snapshots.get(handle);
  check(s, 'Unknown trusted dispatch');
  if (current) currentMatches(current, s);
  const { meta: m, files } = parseReturn(source);
  checkReturnAgainstCast(m, s.cast, files);
  const changes = applyOperations(s, m, files);
  checkEntryIds(s, m, files);
  return {
    meta: structuredClone(m),
    changes,
    files: new Map(files),
    warnings: stageWarnings(s)
  };
}

/**
 * Explicit in-memory Carbon bridge; revalidate against current full bytes at acceptance.
 *
 * Requires `approved === true` (never a default), a **complete** handle from
 * {@link registerStack} (a partial handle fails with 'Stale or incomplete base' because it
 * retains no base bytes to compare), the live `stack` to equal the snapshot byte-for-byte,
 * and at least one staged change (a checkpoint-only Return is a receipt, not a transaction).
 * Then calls `stack.change()` once with the proposed writes (UTF-8 encoded bodies), deletes
 * and moves. The input `stack` is not mutated by this module; Carbon's `change()` returns
 * the next revision.
 *
 * Trust: `stack` is host code; `source` is model output and is re-staged here rather than
 * trusting any earlier {@link stageReturn} result. Side effects: whatever `stack.change()`
 * does in the host.
 * @param {HostStack} stack  Must implement `change()`.
 * @param {TrustedHandle} handle  Must be complete.
 * @param {string} source  Return packet text.
 * @param {{approved?: boolean}} [options]
 * @returns {AcceptanceResult}
 * @throws {Error} 'Explicit user approval required' | 'Unknown trusted dispatch' |
 *   currentMatches() errors | stageReturn() errors | 'Checkpoint-only Return has no Stack mutation'
 */
export function acceptInCarbon(stack, handle, source, { approved = false } = {}) {
  check(approved === true, 'Explicit user approval required');
  const s = snapshots.get(handle);
  check(s, 'Unknown trusted dispatch');
  currentMatches(stack, s);
  const stage = stageReturn(handle, source, stack);
  check(stage.changes.length, 'Checkpoint-only Return has no Stack mutation');
  const writes = new Map([...stage.files].map(([p, text]) => [p, encode(text)]));
  const next = stack.change({ writes, deletes: stage.meta.deletes, moves: stage.meta.renames });
  const acceptance = {
    assignment_id: s.cast.assignment_id,
    checkpoint_id: stage.meta.checkpoint_id,
    stack_id: s.cast.stack_id,
    base_revision: s.cast.base_revision,
    accepted_revision: next.manifest.revision
  };
  return { next, receipt: source, previous: stack, acceptance };
}
