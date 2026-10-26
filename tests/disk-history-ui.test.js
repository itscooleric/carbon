import test from "node:test";
import assert from "node:assert/strict";
import { rowsFor, safeStem, baseName, formatSize, mountDiskHistory } from "../src/carbon/ui/disk-history.js";

// The dialog itself (DOM, Download/Restore buttons, confirm) is covered by the browser suite
// once the integrator mounts it; here only the DOM-free logic is checked.
test("rowsFor maps versions to display rows without losing ids", () => {
  const rows = rowsFor([
    { id: "a", savedAt: Date.UTC(2026, 0, 2, 3, 4, 5), size: 2048, modified: null },
    { id: "b", savedAt: Date.UTC(2026, 0, 1), size: 5, modified: Date.UTC(2025, 11, 31) },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
  assert.match(rows[0].text, /^Saved \d{4}-\d\d-\d\d \d\d:\d\d:\d\d · 2\.0 KiB$/);
  assert.match(rows[1].text, /5 B · file modified \d{4}/);
});

test("helpers", () => {
  assert.equal(baseName("a/b/c.md"), "c.md");
  assert.equal(baseName("c.md"), "c.md");
  assert.equal(safeStem("My Folder/../x"), "My-Folder-..-x");
  assert.equal(safeStem(""), "folder");
  assert.equal(formatSize(3 * 1024 ** 2), "3.0 MiB");
});

function mount(extra = {}) {
  const actions = new Map(),
    calls = [];
  const deps = {
    state: { current: null, stack: { manifest: { id: "stk-demo" } } },
    action: (id, fn) => actions.set(id, fn),
    notify: (m) => calls.push(["notify", m]),
    download: (b, n) => calls.push(["download", n, b]),
    openHistory: async () => ({ exportArchive: async () => new Uint8Array([1, 2]) }),
    restoreFromDisk: async () => {},
    modal: async () => null,
    confirm: async () => true,
    ...extra,
  };
  mountDiskHistory(deps);
  return { actions, calls };
}

test("export-history downloads the archive as <folder>-carbon-history.tar", async () => {
  const { actions, calls } = mount();
  assert.deepEqual([...actions.keys()].sort(), ["disk-history", "export-history"]);
  await actions.get("export-history")();
  assert.equal(calls[0][0], "download");
  assert.equal(calls[0][1], "stk-demo-carbon-history.tar");
  const named = mount({ folderName: () => "My Notes" });
  await named.actions.get("export-history")();
  assert.equal(named.calls[0][1], "My-Notes-carbon-history.tar");
});

test("errors from openHistory surface unchanged; no open file is explained", async () => {
  const failing = mount({
    openHistory: async () => {
      throw new Error("This workspace is not linked to a folder.");
    },
  });
  await assert.rejects(failing.actions.get("export-history")(), /not linked/);
  const none = mount();
  await assert.rejects(none.actions.get("disk-history")(), /Open a file/);
});
