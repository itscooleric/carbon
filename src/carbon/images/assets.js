import { sourceFor } from "../local-files.js";
/** Bounded raster headers and portable local references; no decoding or network IO. */
import {
  assert,
  encode,
  path as validPath,
  LIMITS,
} from "../../core/validate.js";

export const IMAGE_PIXELS = 16 * 1024 * 1024;
export const imagePath = (path) =>
  typeof path === "string" && /\.(png|jpe?g|webp)$/i.test(path);
const ascii = (bytes, at, n) =>
  String.fromCharCode(...bytes.subarray(at, at + n));
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function pngCRC(bytes, from, to) {
  let crc = 0xffffffff;
  for (let i = from; i < to; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function dimensions(width, height) {
  assert(
    width > 0 &&
      height > 0 &&
      width <= 8192 &&
      height <= 8192 &&
      width * height <= IMAGE_PIXELS,
    "Image exceeds 8192 pixels per side or 16 megapixels",
  );
  return { width, height };
}
/** Header checks precede browser decoding. Browser decode is also required before insertion/display. */
export function inspectImage(bytes) {
  assert(
    bytes instanceof Uint8Array &&
      bytes.length >= 12 &&
      bytes.length <= LIMITS.file,
    "Image must be a nonempty PNG, JPEG or WebP, at most 8 MiB",
  );
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, type;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) {
    type = "png";
    assert(
      bytes.length >= 45 &&
        v.getUint32(8) === 13 &&
        ascii(bytes, 12, 4) === "IHDR",
      "Invalid PNG header",
    );
    width = v.getUint32(16);
    height = v.getUint32(20);
    dimensions(width, height);
    let at = 8,
      ended = false,
      data = false;
    while (at + 12 <= bytes.length) {
      const size = v.getUint32(at),
        kind = ascii(bytes, at + 4, 4);
      assert(at + 12 + size <= bytes.length, "Truncated PNG chunk");
      assert(
        kind !== "acTL",
        "Animated PNG is not supported in this increment",
      );
      assert(pngCRC(bytes, at + 4, at + 8 + size) === v.getUint32(at + 8 + size), "Invalid PNG chunk CRC");
      if (kind === "IDAT") data = true;
      at += 12 + size;
      if (kind === "IEND") {
        assert(size === 0 && at === bytes.length, "Invalid PNG ending");
        ended = true;
        break;
      }
    }
    assert(ended && data, "Incomplete PNG");
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    type = "jpeg";
    let at = 2, scanned = false, ended = false, inScan = false;
    while (at < bytes.length) {
      if (inScan) {
        while (at < bytes.length && bytes[at] !== 255) at++;
      }
      assert(bytes[at++] === 255, "Invalid or truncated JPEG marker");
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
      inScan = false;
      if (marker === 0xd9) {
        assert(scanned && at === bytes.length, "Invalid JPEG ending");
        ended = true;
        break;
      }
      assert(marker !== 0 && marker !== 0xd8 && !(marker >= 0xd0 && marker <= 0xd7), "Invalid JPEG marker");
      if (marker === 1) continue;
      assert(at + 2 <= bytes.length, "Truncated JPEG marker");
      const size = v.getUint16(at);
      assert(size >= 2 && at + size <= bytes.length, "Truncated JPEG segment");
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        assert(size >= 8, "Invalid JPEG dimensions");
        height = v.getUint16(at + 3);
        width = v.getUint16(at + 5);
        dimensions(width, height);
      }
      if (marker === 0xda) {
        assert(width && height && size >= 6, "Invalid JPEG scan");
        scanned = inScan = true;
      }
      at += size;
    }
    assert(width && height && scanned && ended, "Incomplete JPEG");
  } else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    type = "webp";
    assert(v.getUint32(4, true) + 8 === bytes.length, "Invalid WebP length");
    let at = 12,
      image = false;
    while (at + 8 <= bytes.length) {
      const kind = ascii(bytes, at, 4),
        size = v.getUint32(at + 4, true),
        start = at + 8;
      assert(start + size + (size % 2) <= bytes.length, "Truncated WebP chunk");
      assert(
        !["ANIM", "ANMF"].includes(kind),
        "Animated WebP is not supported in this increment",
      );
      if (kind === "VP8X") {
        assert(
          size === 10 && !(bytes[start] & 2),
          "Invalid or animated WebP header",
        );
        width = 1 + (v.getUint32(start + 4, true) & 0xffffff);
        height =
          1 +
          (bytes[start + 7] |
            (bytes[start + 8] << 8) |
            (bytes[start + 9] << 16));
      } else if (kind === "VP8L") {
        assert(
          size >= 5 && bytes[start] === 0x2f,
          "Invalid lossless WebP header",
        );
        const bits = v.getUint32(start + 1, true);
        const w = (bits & 0x3fff) + 1,
          h = ((bits >>> 14) & 0x3fff) + 1;
        dimensions(w, h);
        width ??= w;
        height ??= h;
        image = true;
      } else if (kind === "VP8 ") {
        assert(
          size >= 10 &&
            bytes[start + 3] === 0x9d &&
            bytes[start + 4] === 1 &&
            bytes[start + 5] === 0x2a,
          "Invalid WebP frame",
        );
        const w = v.getUint16(start + 6, true) & 0x3fff,
          h = v.getUint16(start + 8, true) & 0x3fff;
        dimensions(w, h);
        width ??= w;
        height ??= h;
        image = true;
      }
      at = start + size + (size % 2);
    }
    assert(at === bytes.length && image && width && height, "Incomplete WebP");
  } else
    throw Error(
      "Only PNG, JPEG and WebP raster images are supported; SVG and remote images are disabled",
    );
  return {
    type,
    mime: "image/" + type,
    extension: type === "jpeg" ? "jpg" : type,
    ...dimensions(width, height),
  };
}

/** Resolve local asset paths only, using relative and Stack-root candidates; ambiguity fails closed. */
export function resolveLocalFile(stack, href, from) {
  try {
    assert(
      typeof href === "string" && href.length <= 4096,
      "Invalid image reference",
    );
    const value = decodeURIComponent(href.split(/[?#]/)[0]);
    assert(
      value &&
        !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value) &&
        !/[\\\0]/.test(value),
      "External image disabled",
    );
    const relative = (base) => {
      for (const bit of value.split("/")) {
        if (bit === ".") continue;
        if (bit === "..") {
          if (!base.length) return null;
          base.pop();
        } else base.push(bit);
      }
      try {
        return validPath(base.join("/"));
      } catch {
        return null;
      }
    };
    const candidates = [relative(from.split("/").slice(0, -1))];
    if (!/^\.\.?\//.test(value)) candidates.push(relative([]));
    const paths = new Set(candidates.filter((p) => p && stack.files.has(p)));
    return paths.size === 1 ? [...paths][0] : null;
  } catch {
    return null;
  }
}
export function relativeReference(from, target) {
  validPath(from);
  validPath(target);
  const base = from.split("/").slice(0, -1),
    parts = target.split("/");
  while (base.length && parts.length && base[0] === parts[0]) {
    base.shift();
    parts.shift();
  }
  const reference = [...base.map(() => ".."), ...parts]
    .map((p) =>
      encodeURIComponent(p).replace(
        /[!'()*]/g,
        (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join("/");
  return reference.startsWith("../") ? reference : "./" + reference;
}
/** Pure transaction plan. Asset bytes commit now; the Entry reference stays an unsaved draft. */
export function planImages(
  stack,
  current,
  source,
  range,
  images,
  random = () => crypto.randomUUID(),
) {
  assert(
    /\.md$/i.test(current) && stack.files.has(current),
    "Open a Markdown Entry before inserting images",
  );
  assert(
    images.length > 0 && images.length <= 8,
    "Insert up to 8 images at once",
  );
  assert(
    Number.isInteger(range.from) &&
      Number.isInteger(range.to) &&
      range.from >= 0 &&
      range.to >= range.from &&
      range.to <= source.length,
    "Invalid image insertion position",
  );
  const used = new Set(
    [...stack.files.keys(), ...stack.directories].map((p) => p.toUpperCase()),
  );
  const parent =
    [...stack.directories].find((p) => p.toUpperCase() === "ASSETS") ||
    ([...stack.files.keys()].some((p) => p.toUpperCase() === "ASSETS")
      ? ""
      : "assets");
  const writes = new Map(),
    paths = [];
  for (const bytes of images) {
    const info = inspectImage(bytes),
      token = random();
    assert(/^[a-z0-9-]{1,64}$/i.test(token), "Invalid image name token");
    let path;
    for (let n = 0; n < 10000; n++) {
      const candidate =
        (parent ? parent + "/" : "") +
        `image-${token}${n ? "-" + n : ""}.${info.extension}`;
      if (!used.has(candidate.toUpperCase())) {
        path = candidate;
        break;
      }
    }
    assert(path, "No free image asset name");
    used.add(path.toUpperCase());
    paths.push(path);
    writes.set(path, bytes.slice());
  }
  const insert = paths
    .map((p) => `![Image](${relativeReference(current, p)})`)
    .join("\n");
  const draft = sourceFor(
    stack,
    source.slice(0, range.from) + insert + source.slice(range.to),
    stack.text(current),
  );
  // Validate the resulting Entry and its future saved Stack without committing the draft.
  stack.change({ writes: new Map([...writes, [current, encode(draft)]]) });
  return {
    stack: stack.change({ writes }),
    draft,
    paths,
    changes: { ...range, insert },
    caret: range.from + insert.length,
  };
}
