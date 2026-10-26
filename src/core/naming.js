import { assert, path, validatePaths } from "./validate.js";

/**
 * Local calendar date as `YYYYMMDD` (never the UTC date) for generated names.
 * @param {Date} [date]
 * @returns {string}
 * @throws {Error} on an invalid Date
 */
export function localDate(date = new Date()) {
  assert(Number.isFinite(date.getTime()), "Invalid naming date");
  return (
    String(date.getFullYear()).padStart(4, "0") +
    String(date.getMonth() + 1).padStart(2, "0") +
    String(date.getDate()).padStart(2, "0")
  );
}

/**
 * Suggest a Stack display title `stack-YYYYMMDD-xxxxxxxx` that does not collide
 * case-insensitively with `existing`. Stable Stack IDs are generated separately.
 * @param {Iterable<string>} [existing]  titles already in use
 * @param {Date} [date]
 * @param {() => string} [random]  eight lowercase hex characters per call (injectable for tests)
 * @returns {string}
 * @throws {Error} when `random` misbehaves or 100 attempts all collide
 */
export function suggestStackName(
  existing = [],
  date = new Date(),
  random = () => crypto.randomUUID().slice(0, 8),
) {
  const used = new Set(
    [...existing].map((name) => name.normalize("NFC").toUpperCase()),
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = random();
    assert(/^[a-f0-9]{8}$/.test(suffix), "Invalid naming suffix");
    const name = `stack-${localDate(date)}-${suffix}`;
    if (!used.has(name.toUpperCase())) return name;
  }
  throw new Error(
    "Could not suggest a unique Stack name. Please enter a title.",
  );
}

/**
 * Validate a creation target: portable, `.md` for Entries, not already present (case-
 * insensitively) and collision-free with the Stack's files and directories.
 * @param {Stack} stack
 * @param {string} value   untrusted candidate path
 * @param {boolean} [folder]  true for a directory, false for a Markdown Entry
 * @param {{text?: boolean}} [options]  `text`: any file name (an ordinary workspace's text file),
 *   not only a Markdown Entry; every other rule still applies
 * @returns {string}  the same value
 * @throws {Error} "Already exists: ...", a collision, or an unsafe path
 */
export function assertNewPath(stack, value, folder = false, { text = false } = {}) {
  path(value);
  assert(folder || text || /\.md$/i.test(value), "Entry filename must end in .md");
  const key = value.toUpperCase();
  assert(
    ![...stack.files.keys(), ...stack.directories].some(
      (p) => p.toUpperCase() === key,
    ),
    `Already exists: ${value}. Choose another name.`,
  );
  validatePaths(
    folder ? stack.files.keys() : [...stack.files.keys(), value],
    folder ? [...stack.directories, value] : stack.directories,
  );
  return value;
}

/**
 * Next free `<kind>-YYYYMMDD-NNN[.md]` path under the Stack's Entries directory (its
 * existing spelling is respected; the root is used when `entries` is a file).
 * @param {Stack} stack
 * @param {"note"|"research"|"requirement"|"mission"|"meeting"|"transcript"|"folder"} [kind]
 * @param {Date} [date]
 * @param {{parent?: string}} [options]  `parent`: where to suggest when there is no Entries
 *   directory (default `entries`; `""` is the root, as for an ordinary folder)
 * @returns {string}  validated by {@link assertNewPath}
 * @throws {Error} on an unknown kind or when 10000 candidates are all taken
 */
export function suggestPath(stack, kind = "note", date = new Date(), { parent: fallback = "entries" } = {}) {
  assert(
    [
      "note",
      "research",
      "requirement",
      "mission",
      "meeting",
      "transcript",
      "folder",
    ].includes(kind),
    "Unknown naming kind",
  );
  const folder = kind === "folder";
  // Respect the spelling of an imported Entries directory. If it is a file, use the root.
  const parent =
    [...stack.directories].find((p) => p.toUpperCase() === "ENTRIES") ||
    ([...stack.files.keys()].some((p) => p.toUpperCase() === "ENTRIES")
      ? ""
      : fallback);
  const used = new Set(
    [...stack.files.keys(), ...stack.directories].map((p) => p.toUpperCase()),
  );
  for (let n = 1; n <= 10000; n++) {
    const name = `${kind}-${localDate(date)}-${String(n).padStart(3, "0")}${folder ? "" : ".md"}`;
    const candidate = parent ? `${parent}/${name}` : name;
    if (!used.has(candidate.toUpperCase()))
      return assertNewPath(stack, candidate, folder);
  }
  throw new Error("No free generated filename. Choose a custom path.");
}
