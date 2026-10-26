import { isLocalFolder } from "../local-files.js";
/** Declarative template commands. No executable code is loaded from a Stack. */
import { firstHeading } from "./headings.js";
import { entry, yaml } from "../../core/entries.js";
import { assert, encode, path as validPath } from "../../core/validate.js";
import { assertNewPath, localDate } from "../../core/naming.js";

export const COMMANDS_PATH = "templates/commands.yaml";
export const DEFAULT_COMMANDS = [
  {
    id: "today-log",
    label: "Open Today's Log",
    template: "builtin:note",
    path: "entries/logbook/{{date}}.md",
    title: "Log {{date}}",
  },
];
const text = (value, max = 256) =>
  typeof value === "string" &&
  value.trim() &&
  value.length <= max &&
  !/[\r\n\0]/.test(value);
export function templateCommands(stack) {
  if (isLocalFolder(stack)) return { commands: [], error: null };
  if (!stack.files.has(COMMANDS_PATH))
    return { commands: DEFAULT_COMMANDS, error: null };
  try {
    const { commands } = yaml(stack.text(COMMANDS_PATH)).data;
    assert(
      Array.isArray(commands) && commands.length <= 50,
      "Expected up to 50 template commands",
    );
    const ids = new Set();
    for (const c of commands) {
      assert(
        c &&
          typeof c.id === "string" &&
          /^[a-z0-9][a-z0-9-]{0,63}$/.test(c.id) &&
          !ids.has(c.id),
        "Template command IDs must be unique lowercase names",
      );
      ids.add(c.id);
      assert(
        text(c.label) &&
          text(c.template) &&
          text(c.path, 1024) &&
          text(c.title),
        "Each template command needs label, template, path and title strings",
      );
      if (!c.template.startsWith("builtin:")) {
        validPath(c.template);
        assert(/\.md$/i.test(c.template), "Templates must be Markdown Entries");
      }
      // Validate substitutions with a fixed date; the real local date is chosen on activation.
      validPath(expand(c.path, variables(new Date(2026, 0, 1))));
      assert(/\.md$/i.test(c.path), "Template target must end in .md");
      expand(c.title, variables(new Date(2026, 0, 1)));
    }
    return { commands, error: null };
  } catch (e) {
    return { commands: [], error: `${COMMANDS_PATH}: ${e.message}` };
  }
}
function variables(date) {
  const value = localDate(date);
  return {
    date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`,
    year: value.slice(0, 4),
    month: value.slice(4, 6),
    day: value.slice(6),
  };
}
function expand(value, values) {
  return value.replace(/\{\{([^{}]+)\}\}/g, (_match, name) => {
    assert(Object.hasOwn(values, name), `Unknown template variable: ${name}`);
    return values[name];
  });
}
/** Plan against the live Stack. An existing target is opened without overwriting it. */
export function planTemplate(
  stack,
  drafts,
  templates,
  command,
  date = new Date(),
  random = () => crypto.randomUUID(),
) {
  const values = variables(date),
    path = expand(command.path, values),
    title = expand(command.title, values);
  validPath(path);
  assert(/\.md$/i.test(path), "Template target must end in .md");
  if (stack.files.has(path)) return { path, next: null };
  assertNewPath(stack, path);
  const source = command.template.startsWith("builtin:")
    ? templates[command.template.slice(8)]
    : (drafts.get(command.template) ??
      (stack.files.has(command.template)
        ? stack.text(command.template)
        : null));
  assert(typeof source === "string", `Template not found: ${command.template}`);
  const parsed = entry(source);
  const raw = parsed.frontmatter
    ? parsed.frontmatter.replace(/^---\r?\n/, "").replace(/---\r?\n?$/, "")
    : "{}";
  const doc = yaml(raw).doc;
  doc.set("id", "ent-" + random());
  doc.set("title", title);
  let body = expand(parsed.body, { ...values, title });
  const heading = firstHeading(body);
  // Metadata titles are literal text, not inline Markdown or ATX closing markers.
  const headingTitle = title.replace(/[\\`*_[\]<>#&~]/g, "\\$&");
  if (heading) body = body.slice(0, heading.from) + `# ${headingTitle}` + body.slice(heading.to);
  const output = `---\n${doc.toString()}---\n${body}`;
  return {
    path,
    next: stack.change({ writes: new Map([[path, encode(output)]]) }),
  };
}
