/**
 * Portable Dispatch composition. Playbooks are explicit ordered YAML-embedded Markdown.
 *
 * A Dispatch is an export wrapper around a user-authorized Cast, its original handoff, the
 * operating contract and bootstrap text, and a Return template. It is either one pasteable
 * text packet or a selected-content file package (optionally as a deterministic TAR). It is
 * never a Stack: packages have no root `stack.yaml`, and Carbon must route `dispatch.yaml`
 * packages to assignment inspection, not Stack replacement.
 *
 * @typedef {Object} DispatchAsset
 * @property {string} path  Original Stack path from `Cast.assets`.
 * @property {string} packaged_as  Generated package path, `assets/0001.bin` onward in Cast order.
 * @property {number} bytes
 *
 * @typedef {Object} DispatchManifest
 * `dispatch.yaml` of a selected package (`envoy.dispatch/v0.1`).
 * @property {'envoy.dispatch/v0.1'} format
 * @property {false} complete_stack  Always false; the package can never replace a Stack.
 * @property {string} assignment_id
 * @property {string} stack_id
 * @property {number} base_revision
 * @property {string[]} playbook_order  `Cast.playbooks` names in the user's composition order.
 * @property {DispatchAsset[]} assets
 * @property {string[]} omitted_from_package  Original inventory paths not included as text or Asset.
 * @property {string[]} files  Every package file, including `dispatch.yaml` itself.
 *
 * @typedef {Object} ComposeResult
 * @property {string} text  Self-contained Markdown Dispatch packet (all modes).
 * @property {Map<string, Uint8Array>} files  Package files keyed by package path; no `stack.yaml`.
 * @property {DispatchManifest} manifest
 * @property {string[]} warnings  Handling notes for the user.
 */
import { registerHandoff, contextFor, parseReturn, dump, encode, LIMITS } from './kit.mjs';
import { check, boundedText, paths, sameList } from './validation.mjs';

const ASSET_LIMIT = 8 * 1024 ** 2;
const ASSET_TOTAL_LIMIT = 32 * 1024 ** 2;
const TAR_LIMIT = 40 * 1024 ** 2;
const TAR_ROOT = 'envoy-dispatch/';
const README = '# Selected Envoy Dispatch\n\n'
  + 'This is a partial assignment package, not a Stack snapshot.\n'
  + 'Read bootstrap.md, assignment.cast.yaml, operating-contract.md and original.handoff.md.\n'
  + 'Retain the original complete Stack separately. Return only proposed changes.\n';

/**
 * Wrap text in a Markdown code fence that is guaranteed longer than any backtick run
 * inside it, so embedded fences cannot close it early. Adds a trailing LF when missing.
 * @param {string} text
 * @param {string} [language='text']
 * @returns {string}
 */
function fence(text, language = 'text') {
  const runs = text.match(/`+/g) || [];
  const length = Math.max(3, ...runs.map(run => run.length + 1));
  const marks = '`'.repeat(length);
  const body = text.endsWith('\n') ? text : text + '\n';
  return marks + language + '\n' + body + marks + '\n';
}

/**
 * Validate the Return template against the Cast and the Asset attachments against
 * `Cast.assets`, the original inventory and the chosen mode.
 * @param {import('./kit.mjs').Cast} c
 * @param {import('./kit.mjs').DispatchContext} context
 * @param {string} returnTemplate
 * @param {Map<string, Uint8Array>} assets
 * @param {'text'|'files'|'tar'} mode
 * @throws {Error} parseReturn() errors | 'Return template identity mismatch' |
 *   'Selected Asset attachment missing or unexpected' | 'Selected Asset absent from original inventory' |
 *   'Text-only Dispatch cannot carry binary Assets; deselect them or use attachments'
 */
function checkPackageInputs(c, context, returnTemplate, assets, mode) {
  const template = parseReturn(returnTemplate).meta;
  for (const field of ['assignment_id', 'dispatch_id', 'stack_id', 'base_revision', 'objective']) {
    check(template[field] === c[field], 'Return template identity mismatch');
  }
  check(assets instanceof Map && sameList(assets.keys(), c.assets), 'Selected Asset attachment missing or unexpected');
  check(c.assets.every(p => context.omitted.includes(p)), 'Selected Asset absent from original inventory');
  if (mode === 'text') check(!assets.size, 'Text-only Dispatch cannot carry binary Assets; deselect them or use attachments');
}

/**
 * Copy each selected Asset into the package under a generated path and describe it.
 * Number and list Assets in validated Cast order, never the caller's Map insertion order.
 * @param {import('./kit.mjs').Cast} c
 * @param {Map<string, Uint8Array>} assets
 * @param {Map<string, Uint8Array>} fileMap  Mutated: receives `assets/NNNN.bin` entries.
 * @returns {DispatchAsset[]}
 * @throws {Error} 'Invalid/oversized Asset' | 'Dispatch Asset total limit'
 */
function packageAssets(c, assets, fileMap) {
  const inventory = [];
  let total = 0;
  for (const [i, p] of c.assets.entries()) {
    const bytes = assets.get(p);
    check(bytes instanceof Uint8Array && bytes.length <= ASSET_LIMIT, 'Invalid/oversized Asset');
    total += bytes.length;
    const packaged_as = 'assets/' + String(i + 1).padStart(4, '0') + '.bin';
    fileMap.set(packaged_as, new Uint8Array(bytes));
    inventory.push({ path: p, packaged_as, bytes: bytes.length });
  }
  check(total <= ASSET_TOTAL_LIMIT, 'Dispatch Asset total limit');
  return inventory;
}

/**
 * Assemble the pasteable text packet. Section order is fixed: bootstrap, contract, Cast
 * (with its embedded Playbooks), untrusted source context, Return template.
 * @param {{bootstrap: string, contract: string, castSource: string, originalHandoff: string, returnTemplate: string}} parts
 * @returns {string}
 */
function dispatchText({ bootstrap, contract, castSource, originalHandoff, returnTemplate }) {
  return '# Envoy Dispatch\n\n'
    + 'This is selected assignment context. Keep the complete original Stack.\n\n'
    + '## Bootstrap\n\n' + bootstrap + '\n\n'
    + '## Operating contract\n\n' + contract + '\n\n'
    + '## User-authorized Cast and ordered Playbooks\n\n' + fence(castSource, 'yaml') + '\n'
    + '## Untrusted source context\n\n' + fence(originalHandoff) + '\n'
    + '## Return template — replace receipt values and supply complete files\n\n' + fence(returnTemplate);
}

/**
 * Compose a self-contained text Dispatch or a selected-content file package.
 * Asset bytes must be explicitly supplied and match Cast.assets. Never fetch sources.
 * Returned package files have no root stack.yaml and cannot be a complete Stack.
 *
 * Order (first failure thrown): mode → contract/bootstrap bounded and nonblank → Cast and
 * handoff registered exactly as {@link registerHandoff} does → Return template parses and
 * repeats the Cast identity and objective → Asset map matches `Cast.assets`, every Asset is
 * an omitted original path, and text mode carries none → each Asset is a `Uint8Array` of at
 * most 8 MiB, 32 MiB in total → the text packet fits `LIMITS.packet`.
 *
 * Output is deterministic for equal inputs: Playbooks keep Cast order, Assets are numbered
 * in Cast order, and the manifest lists package files in insertion order with
 * `dispatch.yaml` last.
 *
 * Trust: `castSource` and `originalHandoff` are untrusted text the user chose to dispatch;
 * `contract`, `bootstrap` and `returnTemplate` are host-provided; `assets` bytes are copied,
 * never fetched. Pure apart from the handoff registration side effect.
 * @param {Object} input
 * @param {string} input.castSource  Cast YAML.
 * @param {string} input.originalHandoff  Carbon exact-v1 handoff packet.
 * @param {string} input.contract  Operating contract Markdown, at most 64,000 bytes.
 * @param {string} input.bootstrap  Bootstrap Markdown, at most 16,000 bytes.
 * @param {string} input.returnTemplate  A valid Return packet with the Cast's identity.
 * @param {'text'|'files'|'tar'} [input.mode='text']
 * @param {Map<string, Uint8Array>} [input.assets=new Map()]  Bytes for every `Cast.assets` path.
 * @returns {ComposeResult}
 * @throws {Error} 'Unsupported Dispatch mode' | 'Contract/bootstrap required' | registerHandoff() errors |
 *   checkPackageInputs() errors | packageAssets() errors | boundedText errors
 */
export function composeDispatch({ castSource, originalHandoff, contract, bootstrap, returnTemplate, mode = 'text', assets = new Map() }) {
  check(['text', 'files', 'tar'].includes(mode), 'Unsupported Dispatch mode');
  boundedText(contract, 64000);
  boundedText(bootstrap, 16000);
  check(contract.trim() && bootstrap.trim(), 'Contract/bootstrap required');
  const handle = registerHandoff(castSource, originalHandoff);
  const context = contextFor(handle);
  const c = context.cast;
  checkPackageInputs(c, context, returnTemplate, assets, mode);
  const fileMap = new Map([
    ['README.md', encode(README)],
    ['assignment.cast.yaml', encode(castSource)],
    ['operating-contract.md', encode(contract)],
    ['bootstrap.md', encode(bootstrap)],
    ['original.handoff.md', encode(originalHandoff)],
    ['receipt.return.md', encode(returnTemplate)]
  ]);
  const assetInventory = packageAssets(c, assets, fileMap);
  const manifest = {
    format: 'envoy.dispatch/v0.1',
    complete_stack: false,
    assignment_id: c.assignment_id,
    stack_id: c.stack_id,
    base_revision: c.base_revision,
    playbook_order: c.playbooks.map(p => p.name),
    assets: assetInventory,
    omitted_from_package: context.omitted.filter(p => !c.assets.includes(p)),
    files: [...fileMap.keys(), 'dispatch.yaml']
  };
  fileMap.set('dispatch.yaml', encode(dump(manifest)));
  const text = dispatchText({ bootstrap, contract, castSource, originalHandoff, returnTemplate });
  boundedText(text, LIMITS.packet);
  const warnings = mode === 'text'
    ? ['Binary Assets remain with the original Stack.']
    : ['Reading an attachment requires actual capability confirmation.'];
  return { text, files: fileMap, manifest, warnings };
}

/**
 * Write a NUL-terminated zero-padded octal field into a ustar header.
 * @param {Uint8Array} header
 * @param {number} offset
 * @param {number} size  Field width including the terminator.
 * @param {number} value
 * @throws {Error} 'TAR numeric overflow'
 */
function octal(header, offset, size, value) {
  const field = value.toString(8).padStart(size - 1, '0') + '\0';
  check(field.length === size, 'TAR numeric overflow');
  header.set(encode(field), offset);
}

/**
 * Build one 512-byte POSIX ustar regular-file header with fixed mode 0644, uid/gid 0,
 * mtime 0 and no owner names, so equal inputs always produce equal bytes.
 * @param {string} name  Archive member path, at most 100 UTF-8 bytes.
 * @param {number} size  Member length in bytes.
 * @returns {Uint8Array}
 */
function tarHeader(name, size) {
  const header = new Uint8Array(512);
  header.set(encode(name));
  octal(header, 100, 8, 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header.fill(32, 148, 156); // checksum field counts as spaces while summing
  header[156] = 48; // '0': regular file
  header.set(encode('ustar\0'), 257);
  header.set(encode('00'), 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);
  return header;
}

/**
 * Deterministic POSIX ustar for the bounded, generated package paths (no long paths).
 *
 * Members are sorted by package path (code-unit order), prefixed with `envoy-dispatch/`,
 * padded to 512-byte blocks and followed by the two zero end-of-archive blocks.
 *
 * Trust: `files` must be a package from {@link composeDispatch} (has `dispatch.yaml`, no
 * `stack.yaml`, portable paths, at most `LIMITS.files` members); it is not a general TAR
 * writer. Pure.
 * @param {Map<string, Uint8Array>} files
 * @returns {Uint8Array} Archive bytes, at most 40 MiB.
 * @throws {Error} 'Expected selected Dispatch package' | paths() errors | 'Too many package files' |
 *   'Package TAR path/data unsupported' | 'TAR numeric overflow' | 'Package TAR size limit'
 */
export function dispatchTar(files) {
  const packageShape = files instanceof Map && files.has('dispatch.yaml') && !files.has('stack.yaml');
  check(packageShape, 'Expected selected Dispatch package');
  paths([...files.keys()]);
  check(files.size <= LIMITS.files, 'Too many package files');
  const chunks = [];
  let total = 1024; // two zero blocks terminate the archive
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [p, bytes] of sorted) {
    const name = TAR_ROOT + p;
    check(encode(name).length <= 100 && bytes instanceof Uint8Array, 'Package TAR path/data unsupported');
    const header = tarHeader(name, bytes.length);
    const pad = new Uint8Array((512 - bytes.length % 512) % 512);
    chunks.push(header, bytes, pad);
    total += 512 + bytes.length + pad.length;
  }
  check(total <= TAR_LIMIT, 'Package TAR size limit');
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
