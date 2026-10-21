import { Image } from "@mobrowser/api";

let argbChannels: number[] | undefined;

function nativeArgbChannels(): number[] {
  if (!argbChannels) {
    // SDK 2.13 on macOS returns BGRA although its documentation says RGBA.
    // Probe an opaque red pixel so a future SDK correction cannot swap colors.
    const red = Image.fromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWL6z8DwHwAAAP//A3ONEwAAAAZJREFUAwAFCgIByRpMngAAAABJRU5ErkJggg==").asBitmap(1);
    if (red[0] === 255 && red[2] === 0 && red[3] === 255) argbChannels = [3, 0, 1, 2];
    else if (red[2] === 255 && red[0] === 0 && red[3] === 255) argbChannels = [3, 2, 1, 0];
    else throw new Error("Unsupported native icon pixel layout.");
  }
  return argbChannels;
}

/**
 * iconutil on macOS 15 writes straight RGB into its small ARGB representations,
 * but the system decodes those channels as premultiplied. Rebuild these two
 * entries from the PNGs using the native image decoder's premultiplied pixels.
 * PNG-backed entries (including every Retina size) stay byte-for-byte intact.
 */
export function preserveSmallIconAlpha(icns: Buffer, png16: Buffer, png32: Buffer): Buffer {
  const replacements = new Map([
    ["ic04", encodeArgb(png16, 16)],
    ["ic05", encodeArgb(png32, 32)],
  ]);
  if (icns.length < 8 || icns.toString("ascii", 0, 4) !== "icns" || icns.readUInt32BE(4) !== icns.length) {
    throw new Error("Invalid ICNS output.");
  }
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < icns.length;) {
    if (offset + 8 > icns.length) throw new Error("Truncated ICNS entry.");
    const type = icns.toString("ascii", offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > icns.length) throw new Error("Invalid ICNS entry length.");
    const replacement = replacements.get(type);
    // A table of contents, if present, would contain stale entry lengths.
    if (type !== "TOC ") chunks.push(replacement ?? icns.subarray(offset, offset + length));
    replacements.delete(type);
    offset += length;
  }
  // Also support iconutil versions that use older tags for the small sizes.
  chunks.push(...replacements.values());
  const header = Buffer.alloc(8);
  header.write("icns");
  header.writeUInt32BE(8 + chunks.reduce((n, chunk) => n + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

function encodeArgb(png: Buffer, size: 16 | 32): Buffer {
  const image = Image.fromDataURL(`data:image/png;base64,${png.toString("base64")}`);
  const rgba = image.asBitmap(1);
  if (image.isEmpty || image.size.width !== size || image.size.height !== size || rgba.length !== size * size * 4) {
    throw new Error(`Could not decode the ${size}px icon.`);
  }
  const data: number[] = [];
  // ICNS ARGB stores A, R, G, B as separate PackBits-like channels. Literal
  // packets are sufficient for these tiny images (at most 4 KiB of pixels).
  for (const channel of nativeArgbChannels()) {
    for (let start = 0; start < size * size; start += 128) {
      const count = Math.min(128, size * size - start);
      data.push(count - 1);
      for (let i = start; i < start + count; i++) data.push(rgba[i * 4 + channel]);
    }
  }
  // Terminal padding avoids the ARM decoder dropping the last blue packet.
  // Format reference: https://github.com/relikd/icns-analysis#image-data-formats
  const body = Buffer.concat([Buffer.from("ARGB"), Buffer.from(data), Buffer.from([0])]);
  const header = Buffer.alloc(8);
  header.write(size === 16 ? "ic04" : "ic05");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}
