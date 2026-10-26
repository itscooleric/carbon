import { Stack } from "../src/core/stack.js";
import { encode } from "../src/core/validate.js";
export function sample() {
  return new Stack(
    [
      [
        "stack.yaml",
        encode(
          "# keep manifest comment\nformat: envoy.stack/v0.2\nid: stk-test\nrevision: 3 # revision comment\ntitle: Test notebook\nentrypoint: entries/nested/note.md\nunknown: [a, b]\n",
        ),
      ],
      [
        "entries/nested/note.md",
        encode(
          "---\nid: ent-note # stable\n# keep comment\nkind: research\nunknown:\n  custom: yes\n---\n# Original\n\nEvidence stays.\n",
        ),
      ],
      ["entries/other.md", encode("# Plain note\n\n[[ent-note]]\n")],
      ["assets/bytes.bin", Uint8Array.from({ length: 257 }, (_, i) => i % 256)],
      ["entries/日本語-☃.md", encode("# Unicode\r\nNo final newline")],
      ["entries/" + "long/".repeat(20) + "note.md", encode("Long path")],
    ],
    ["empty"],
  );
}
export function fixChecksum(bytes, at = 0) {
  bytes.fill(32, at + 148, at + 156);
  const sum = bytes.subarray(at, at + 512).reduce((a, b) => a + b, 0);
  bytes.set(encode(sum.toString(8).padStart(6, "0") + "\0 "), at + 148);
  return bytes;
}
export function setName(bytes, name, at = 0) {
  bytes.fill(0, at, at + 100);
  bytes.set(encode(name), at);
  return fixChecksum(bytes, at);
}
