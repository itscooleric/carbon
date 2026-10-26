import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sample } from "./helpers.js";
import { readTar, writeTar } from "../src/archives/tar.js";
import { sameStack } from "../src/core/stack.js";
test("Python tarfile independently reads Carbon PAX; Carbon reads Python PAX and ustar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "carbon-interop-"));
  try {
    const stack = sample();
    await writeFile(join(dir, "carbon.tar"), writeTar(stack));
    execFileSync("python3", [
      "-c",
      `
import tarfile, pathlib, sys
root=pathlib.Path(sys.argv[1])
with tarfile.open(root/'carbon.tar') as t:
    assert t.getmember('stk-test.stack/entries/日本語-☃.md').pax_headers['path'].endswith('日本語-☃.md')
    assert t.extractfile('stk-test.stack/assets/bytes.bin').read()==bytes(i%256 for i in range(257))
    members=t.getmembers()
    with tarfile.open(root/'python-pax.tar','w',format=tarfile.PAX_FORMAT) as out:
        for m in members: out.addfile(m,t.extractfile(m) if m.isfile() else None)
with tarfile.open(root/'python-ustar.tar','w',format=tarfile.USTAR_FORMAT) as out:
    import io
    b=b'format: envoy.stack/v0.2\\nid: stk-python\\nrevision: 0\\n'
    info=tarfile.TarInfo('ordinary.stack/stack.yaml');info.size=len(b);out.addfile(info,io.BytesIO(b))
`,
      dir,
    ]);
    assert.ok(
      sameStack(
        stack,
        readTar(new Uint8Array(await readFile(join(dir, "python-pax.tar")))),
      ),
    );
    assert.equal(
      readTar(new Uint8Array(await readFile(join(dir, "python-ustar.tar"))))
        .manifest.id,
      "stk-python",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("GNU tar independently lists Carbon output and generates readable POSIX PAX", async () => {
  const dir = await mkdtemp(join(tmpdir(), "carbon-gnu-"));
  try {
    const s = sample();
    await writeFile(join(dir, "carbon.tar"), writeTar(s));
    const list = execFileSync("tar", ["-tf", join(dir, "carbon.tar")], {
      encoding: "utf8",
    });
    assert.match(list, /assets\/bytes.bin/);
    await mkdir(join(dir, "stack"));
    await writeFile(
      join(dir, "stack", "stack.yaml"),
      s.files.get("stack.yaml"),
    );
    for (const [p, b] of s.files) {
      await mkdir(join(dir, "stack", p, ".."), { recursive: true });
      await writeFile(join(dir, "stack", p), b);
    }
    await mkdir(join(dir, "stack", "empty"));
    execFileSync("tar", [
      "--format=pax",
      "-cf",
      join(dir, "gnu.tar"),
      "-C",
      dir,
      "stack",
    ]);
    assert.ok(
      sameStack(
        s,
        readTar(new Uint8Array(await readFile(join(dir, "gnu.tar")))),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
