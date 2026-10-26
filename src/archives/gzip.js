import { assert, LIMITS } from "../core/validate.js";
/** Bound every decompressed chunk before retaining it; native streams validate gzip CRC. */
async function transform(bytes, decompress) {
  assert(
    bytes.length <= LIMITS.archive,
    "Compressed input size limit exceeded",
  );
  const Stream = decompress
    ? globalThis.DecompressionStream
    : globalThis.CompressionStream;
  assert(Stream, "Gzip streams unavailable in this browser. Use TAR instead.");
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new Stream("gzip"))
    .getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assert(
        size <= LIMITS.archive &&
          (!decompress ||
            size <= Math.max(1024 * 1024, bytes.length * LIMITS.ratio)),
        "Excessive gzip decompression",
      );
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let at = 0;
  for (const b of chunks) {
    result.set(b, at);
    at += b.length;
  }
  return result;
}
/**
 * Gzip bytes with the native CompressionStream.
 * @param {Uint8Array} bytes  at most `LIMITS.archive`
 * @returns {Promise<Uint8Array>}
 * @throws {Error} when streams are unavailable or the output exceeds `LIMITS.archive`
 */
export const gzip = (bytes) => transform(bytes, false);
/**
 * Gunzip untrusted bytes with bounded output: at most `LIMITS.archive` and at most
 * max(1 MiB, input × `LIMITS.ratio`), so expansion bombs fail before being retained.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 * @throws {Error} on corrupt gzip data, missing streams or excessive expansion
 */
export const gunzip = (bytes) => transform(bytes, true);
