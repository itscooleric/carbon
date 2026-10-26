import { stringify } from "yaml";
import { yaml, entry } from "./entries.js";
import {
  assert,
  encode,
  decode,
  path,
  equal,
  LIMITS,
  validatePaths,
} from "./validate.js";
import { sameStack } from "./stack.js";
const sorted = (values) => [...values].sort();
const sameList = (a, b) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const frame = (boundary, p, body) =>
  `## File: ${encodeURIComponent(p)}\n<!-- envoy:begin boundary="${boundary}" path="${encodeURIComponent(p)}" -->\n${body}\n<!-- envoy:end boundary="${boundary}" -->\n\n`;
/**
 * Build an `envoy.handoff/v0.2` (exact-v1 framing) text packet from the manifest plus the
 * selected Markdown Entries, with a random boundary that occurs in no included file.
 * The returned object is the trusted local baseline that {@link propose} later requires.
 * @param {Stack} stack
 * @param {string[]} [selected]  Entry paths to include (default: every `.md`); `stack.yaml`
 *   is always included
 * @returns {{text: string, base: Stack, included: string[], omitted: string[], dispatchId: string}}
 * @throws {Error} when a selection is not an existing Entry or the packet exceeds 4 MiB
 */
export function dispatch(
  stack,
  selected = [...stack.files.keys()].filter((p) => /\.md$/i.test(p)),
) {
  const included = sorted(new Set(["stack.yaml", ...selected]));
  assert(
    included.every(
      (p) => stack.files.has(p) && (p === "stack.yaml" || /\.md$/i.test(p)),
    ),
    "Select existing Markdown Entries",
  );
  const omitted = sorted(
    [...stack.files.keys()].filter((p) => !included.includes(p)),
  );
  let boundary;
  do {
    boundary = "envoy-" + crypto.randomUUID();
  } while (included.some((p) => stack.text(p).includes(boundary)));
  const dispatchId = "dispatch-" + crypto.randomUUID();
  const meta = {
    format: "envoy.handoff/v0.2",
    framing: "exact-v1",
    dispatch_id: dispatchId,
    stack_id: stack.manifest.id,
    base_revision: stack.manifest.revision,
    scope: omitted.length ? "selected-text" : "full-text",
    included_files: included,
    omitted_files: omitted,
    boundary,
  };
  const text =
    "# Envoy Handoff\n\n```yaml\n" +
    stringify(meta, { lineWidth: 0 }) +
    "```\n\n" +
    included.map((p) => frame(boundary, p, stack.text(p))).join("");
  assert(
    encode(text).length <= 4 * LIMITS.text,
    "Handoff exceeds 4 MiB; select fewer Entries",
  );
  return { text, base: stack, included, omitted, dispatchId };
}
/**
 * Parse a handoff packet strictly: header YAML, exact frame prefixes/suffixes in inventory
 * order, no truncation, no boundary collision, no trailing content. Frame bodies are
 * returned as bytes without any normalization. Input is untrusted (model output).
 * @param {string} source
 * @returns {{meta: Record<string, unknown>, files: Map<string, Uint8Array>}}
 * @throws {Error} with a user-facing reason on any framing or inventory problem
 */
export function parseHandoff(source) {
  assert(
    encode(source).length <= 4 * LIMITS.text && !source.includes("\0"),
    "Handoff size limit or NUL violation",
  );
  const header = /^# Envoy Handoff\n\n```yaml\n([\s\S]*?)\n```\n\n/.exec(
    source,
  );
  assert(
    header,
    "Invalid handoff header. Export a current Carbon packet; legacy examples need regeneration.",
  );
  const m = yaml(header[1]).data;
  assert(
    m.format === "envoy.handoff/v0.2" && m.framing === "exact-v1",
    "Unsupported handoff format/framing",
  );
  assert(
    typeof m.dispatch_id === "string" &&
      /^dispatch-[a-z0-9-]{1,80}$/.test(m.dispatch_id),
    "Invalid dispatch ID",
  );
  assert(
    typeof m.boundary === "string" && /^[a-zA-Z0-9-]{16,100}$/.test(m.boundary),
    "Invalid handoff boundary",
  );
  assert(
    ["full-text", "selected-text"].includes(m.scope),
    "Invalid handoff scope",
  );
  assert(
    Array.isArray(m.included_files) &&
      Array.isArray(m.omitted_files) &&
      m.included_files.length + m.omitted_files.length <= LIMITS.files,
    "Invalid handoff inventory",
  );
  validatePaths([...m.included_files, ...m.omitted_files]);
  assert(
    m.included_files.includes("stack.yaml") &&
      m.included_files.every((p) => p === "stack.yaml" || /\.md$/i.test(p)),
    "Handoffs contain manifest and Markdown only",
  );
  assert(
    m.scope !== "full-text" || m.omitted_files.length === 0,
    "Full-text packet declares omissions",
  );
  let offset = header[0].length;
  const files = new Map();
  for (const p of m.included_files) {
    path(p);
    const prefix = `## File: ${encodeURIComponent(p)}\n<!-- envoy:begin boundary="${m.boundary}" path="${encodeURIComponent(p)}" -->\n`;
    assert(
      source.startsWith(prefix, offset),
      `Missing, duplicate or mismatched frame: ${p}`,
    );
    offset += prefix.length;
    const suffix = `\n<!-- envoy:end boundary="${m.boundary}" -->\n\n`;
    const end = source.indexOf(suffix, offset);
    assert(end >= offset, `Truncated frame: ${p}`);
    const body = source.slice(offset, end);
    assert(!body.includes(m.boundary), "Boundary collision within file");
    const bytes = encode(body);
    assert(bytes.length <= LIMITS.text, "Handoff file too large");
    files.set(p, bytes);
    offset = end + suffix.length;
  }
  assert(offset === source.length, "Unexpected handoff trailing content");
  return { meta: m, files };
}
/**
 * Re-establish a trusted baseline from an original dispatch packet in another session: the
 * packet must name this Stack and revision, list the complete inventory, and match every
 * included file byte-for-byte.
 * @param {Stack} stack   current Stack
 * @param {string} source  original handoff text (untrusted until verified here)
 * @returns {{text: string, base: Stack, included: string[], omitted: string[], dispatchId: string}}
 * @throws {Error} on identity, revision, inventory or content mismatch
 */
export function registerDispatch(stack, source) {
  const { meta: m, files } = parseHandoff(source);
  assert(
    m.stack_id === stack.manifest.id &&
      m.base_revision === stack.manifest.revision,
    "Stack identity or base revision mismatch",
  );
  assert(
    sameList([...files.keys(), ...m.omitted_files], stack.files.keys()),
    "Dispatch inventory differs from local Stack",
  );
  for (const [p, b] of files)
    assert(
      equal(b, stack.files.get(p)),
      `Original dispatch differs from local file: ${p}`,
    );
  return {
    text: source,
    base: stack,
    included: m.included_files,
    omitted: m.omitted_files,
    dispatchId: m.dispatch_id,
  };
}
/**
 * Validate a Return against the trusted dispatch and produce a candidate next revision.
 * The local Stack must still equal the dispatch base; the Return must keep identity, base
 * revision, dispatch id, scope and `stack.yaml`, and must preserve every changed Entry's
 * frontmatter byte-for-byte. Nothing is applied: the caller shows the diff and accepts.
 * @param {Stack} stack
 * @param {{base: Stack, included: string[], omitted: string[], dispatchId: string}} trusted
 * @param {string} source  Return text (untrusted model output)
 * @returns {{next: Stack, changes: {path: string, before: string, after: string}[], base: Stack}}
 * @throws {Error} on any mismatch, frontmatter change, or an empty change set
 */
export function propose(stack, trusted, source) {
  assert(
    trusted && sameStack(stack, trusted.base),
    "Missing dispatch or local Stack changed since dispatch",
  );
  const { meta: m, files } = parseHandoff(source);
  assert(
    m.stack_id === stack.manifest.id &&
      m.base_revision === stack.manifest.revision,
    "Stack identity or base revision mismatch",
  );
  assert(
    m.dispatch_id === trusted.dispatchId &&
      sameList(m.included_files, trusted.included) &&
      sameList(m.omitted_files, trusted.omitted),
    "Return scope differs from trusted dispatch",
  );
  assert(
    equal(files.get("stack.yaml"), stack.files.get("stack.yaml")),
    "Return cannot change stack.yaml",
  );
  const writes = new Map(
    [...files].filter(
      ([p, b]) => p !== "stack.yaml" && !equal(b, stack.files.get(p)),
    ),
  );
  assert(writes.size, "Return contains no changes");
  for (const [p, bytes] of writes) {
    assert(
      entry(stack.text(p)).frontmatter === entry(decode(bytes)).frontmatter,
      `Return must preserve Entry frontmatter and stable ID byte-for-byte: ${p}. Edit metadata locally.`,
    );
  }
  const next = stack.change({ writes });
  return {
    next,
    changes: [...writes].map(([p, b]) => ({
      path: p,
      before: stack.text(p),
      after: decode(b),
    })),
    base: stack,
  };
}
/**
 * Bounded Myers line diff with three context lines per hunk. Lines split on `\n` only, so
 * CRLF text keeps its `\r`. Returns null when the work or distance budget is exhausted or
 * the result exceeds 2000 lines: callers must then show an explicit full-text comparison.
 * @param {string} before
 * @param {string} after
 * @param {{maxWork?: number, maxDistance?: number}} [options]
 * @returns {{kind: "context"|"added"|"removed"|"hunk", text: string}[]|null}  empty when equal
 */
export function diffLines(
  before,
  after,
  { maxWork = 1000000, maxDistance = 256 } = {},
) {
  const a = before.split("\n"),
    b = after.split("\n");
  const v = new Map([[1, 0]]),
    trace = [];
  let work = 0;
  for (let d = 0; d <= Math.min(maxDistance, a.length + b.length); d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      if (++work > maxWork) return null;
      let x =
        k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
          ? v.get(k + 1)
          : v.get(k - 1) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
        if (++work > maxWork) return null;
      }
      v.set(k, x);
      if (x < a.length || y < b.length) continue;
      const lines = [];
      for (let depth = d; depth >= 0; depth--) {
        const prior = trace[depth],
          diagonal = x - y;
        const prevK =
          diagonal === -depth ||
          (diagonal !== depth &&
            (prior.get(diagonal - 1) ?? -1) < (prior.get(diagonal + 1) ?? -1))
            ? diagonal + 1
            : diagonal - 1;
        const prevX = prior.get(prevK) ?? 0,
          prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
          lines.push({ kind: "context", text: a[--x] });
          y--;
        }
        if (depth > 0) {
          if (x === prevX) lines.push({ kind: "added", text: b[--y] });
          else lines.push({ kind: "removed", text: a[--x] });
        }
      }
      lines.reverse();
      const visible = new Set();
      lines.forEach((line, i) => {
        if (line.kind !== "context")
          for (
            let n = Math.max(0, i - 3);
            n <= Math.min(lines.length - 1, i + 3);
            n++
          )
            visible.add(n);
      });
      const result = [];
      let prior = -1;
      for (const i of [...visible].sort((x, y) => x - y)) {
        if (i > prior + 1)
          result.push({
            kind: "hunk",
            text: `… ${i - prior - 1} unchanged lines …`,
          });
        result.push(lines[i]);
        prior = i;
      }
      if (prior < lines.length - 1 && result.length)
        result.push({
          kind: "hunk",
          text: `… ${lines.length - prior - 1} unchanged lines …`,
        });
      return result.length > 2000 ? null : result;
    }
  }
  return null;
}
