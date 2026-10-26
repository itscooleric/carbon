/** Active-Stack search. Results contain source offsets, never rendered Markdown/HTML. */
import { firstHeading } from "./headings.js";
import { canEdit, entryFor, toEditorText } from "../local-files.js";
import { resolveEntry, scanWikiLinks, prepareEntryIndex } from "../markdown.js";

/** Search offsets refer to the text the Editor shows: LF line breaks and no BOM (see `toEditorText`). */
export const normalizeSource = toEditorText;
export const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));
export const MAX_QUERY = 256;
const ALIAS_LIMIT = 5000;
export function matcher(query) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}
export function matchRank(value, query) {
  const found = matcher(query).exec(value);
  return !found
    ? Infinity
    : found.index === 0
      ? found[0].length === value.length
        ? 0
        : 1
      : 2;
}
const sortNames = (a, b) =>
  a.rank - b.rank ||
  a.label.localeCompare(b.label) ||
  a.path.localeCompare(b.path);

/** Snapshot drafts so asynchronous searches cannot mix different revisions or edits. */
export async function buildIndex(
  state,
  { cancelled = () => false, pause = yieldToUI } = {},
) {
  const stack = state.stack,
    drafts = new Map(state.drafts),
    records = [],
    aliases = new Map();
  let limited = false,
    invalidDrafts = 0,
    ambiguous = 0,
    work = 0,
    processed = 0,
    resolverReady = false;
  for (const path of [...stack.files.keys()]
    .filter((p) => /\.md$/i.test(p))
    .sort()) {
    if (cancelled()) return null;
    if (++processed % 16 === 0) await pause();
    if (!canEdit(stack, path)) continue;
    const saved = entryFor(stack, stack.text(path), path);
    const text = drafts.get(path) ?? stack.text(path), source = normalizeSource(text);
    let parsed = saved;
    try {
      // Metadata is read from the text as stored (a BOM still means "no frontmatter"); offsets use `source`.
      parsed = entryFor(stack, text.replace(/\r\n?/g, "\n"), path);
    } catch {
      invalidDrafts++;
    }
    const title =
      typeof parsed.data.title === "string" && parsed.data.title.trim()
        ? parsed.data.title.trim()
        : firstHeading(parsed.body)?.text || path.split("/").pop();
    records.push({
      path,
      label: title,
      id: saved.data.id,
      source,
      draft: drafts.has(path),
    });
    // Entity aliases are existing wiki targets/labels, resolved in their referring Entry.
    for (const { target } of scanWikiLinks(saved.body)) {
      if (!resolverReady) {
        if (!(await prepareEntryIndex(stack, { pause, cancelled }))) return null;
        resolverReady = true;
      }
      const [raw, display] = target.split("|");
      const label = (display || raw).trim();
      if (!label) continue;
      const key = label.toLowerCase();
      if (!aliases.has(key) && aliases.size >= ALIAS_LIMIT) {
        limited = true;
        continue;
      }
      const resolved = resolveEntry(stack, target, path);
      const prior = aliases.get(key);
      if (!prior) aliases.set(key, { label, path: resolved });
      else if (prior.path !== resolved) prior.path = null;
      if (++work % 256 === 0) {
        await pause();
        if (cancelled()) return null;
      }
    }
  }
  const entities = [];
  for (const item of aliases.values()) {
    if (item.path) entities.push(item);
    else ambiguous++;
  }
  return { stack, records, entities, limited, invalidDrafts, ambiguous };
}

/** Exact non-overlapping count; retain only a page of offsets, yielding on dense input. */
export async function occurrences(
  source,
  query,
  {
    from = 0,
    limit = 20,
    countAll = false,
    cancelled = () => false,
    pause = yieldToUI,
  } = {},
) {
  const re = matcher(query),
    matches = [];
  if (!query) return { count: 0, matches, next: from };
  re.lastIndex = from;
  let match,
    count = 0,
    next = from;
  while ((match = re.exec(source))) {
    count++;
    if (matches.length < limit) {
      matches.push({ from: match.index, to: re.lastIndex });
      next = re.lastIndex;
    }
    if (!countAll && matches.length === limit) break;
    if (count % 2048 === 0) {
      await pause();
      if (cancelled()) return null;
    }
  }
  return { count, matches, next };
}

/** Commands, names and resolvable entities precede document-grouped full text. */
export async function searchIndex(
  index,
  query,
  commands,
  { entriesOnly = false, cancelled = () => false, pause = yieldToUI } = {},
) {
  if (!query.trim()) query = "";
  if (query.length > MAX_QUERY)
    throw Error(`Use at most ${MAX_QUERY} search characters.`);
  const result = {
    commands: [],
    entries: [],
    entities: [],
    content: [],
    query,
  };
  if (!entriesOnly)
    result.commands = commands
      .map((command) => ({
        ...command,
        rank: query
          ? matchRank(command.label + " " + (command.keywords || ""), query)
          : 0,
      }))
      .filter((c) => Number.isFinite(c.rank))
      .sort((a, b) => a.rank - b.rank);
  let processed = 0;
  for (const record of index.records) {
    if (cancelled()) return null;
    const rank = query
      ? Math.min(
          ...[
            record.label,
            record.path,
            record.path.split("/").pop(),
            record.id || "",
          ].map((s) => matchRank(s, query)),
        )
      : 0;
    if (Number.isFinite(rank)) result.entries.push({ ...record, rank });
    if (query && !entriesOnly) {
      const found = await occurrences(record.source, query, {
        countAll: true,
        cancelled,
        pause,
      });
      if (!found) return null;
      if (found.count) result.content.push({ ...record, ...found });
    }
    if (++processed % 16 === 0) await pause();
  }
  if (query && !entriesOnly)
    result.entities = index.entities
      .map((item) => ({ ...item, rank: matchRank(item.label, query) }))
      .filter((item) => Number.isFinite(item.rank))
      .sort(sortNames);
  result.entries.sort(sortNames);
  return cancelled() ? null : result;
}

export function excerpt(source, match) {
  const start = Math.max(
    source.lastIndexOf("\n", match.from - 1) + 1,
    match.from - 64,
  );
  const newline = source.indexOf("\n", match.to);
  const end = Math.min(newline < 0 ? source.length : newline, match.to + 80);
  return {
    text: source.slice(start, end),
    line: 1 + (source.slice(0, match.from).match(/\n/g) || []).length,
    prefix: start > 0 && source[start - 1] !== "\n",
    suffix: end < source.length && source[end] !== "\n",
  };
}
