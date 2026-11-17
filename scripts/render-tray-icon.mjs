/**
 * Render the StudyBuddy Windows tray icon from `assets/logo1.png`.
 *
 * Sharp comes from the fixed DSH source tree (the desktop package already depends
 * on it), so the project keeps no additional image toolchain. Windows picks a
 * bitmap by display scale, so each edge is resized from the trimmed artwork
 * instead of downscaling one large PNG. Run from the project root:
 *
 *   node scripts/render-tray-icon.mjs
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const source = join(project, 'source/deepseek-harness');
const require = createRequire(join(source, 'apps/desktop/package.json'));
const sharp = require('sharp');

/** Bitmap edge lengths bundled in the tray icon: 16 px at 100 % through 400 % display scale. */
export const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64];
/** Share of the bitmap the logo occupies; the rest is transparent breathing room. */
const CONTENT_SCALE = 0.92;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * Pack square PNG bitmaps into one ICO file.
 * @param {readonly { size: number, png: Buffer }[]} entries - Bitmaps in ascending size.
 * @returns {Buffer} ICO bytes with PNG-compressed entries (Windows Vista and later).
 */
export function packIco(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((entry, index) => {
    if (entry.size < 1 || entry.size > 256) throw new Error(`tray icon: unsupported bitmap edge ${entry.size}`);
    if (entry.png.readUInt32BE(16) !== entry.size || entry.png.readUInt32BE(20) !== entry.size) {
      throw new Error(`tray icon: bitmap ${index} is not ${entry.size}x${entry.size}`);
    }
    const at = 6 + 16 * index;
    header.writeUInt8(entry.size % 256, at);
    header.writeUInt8(entry.size % 256, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(entry.png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, ...entries.map(entry => entry.png)]);
}

/** @param {Buffer} logo @param {number} size @returns {Promise<Buffer>} Square PNG. */
async function renderBitmap(logo, size) {
  const inner = Math.max(1, Math.round(size * CONTENT_SCALE));
  const glyph = await sharp(logo).resize(inner, inner, { fit: 'contain', background: TRANSPARENT }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: TRANSPARENT } })
    .composite([{ input: glyph, gravity: 'center' }])
    .png()
    .toBuffer();
}

const logo = await sharp(await readFile(join(project, 'assets/logo1.png')))
  // The logo carries transparent margins; trimming first keeps the glyph as
  // large as possible at 16 px while every edge is padded back to a square.
  .ensureAlpha()
  .trim({ background: TRANSPARENT, threshold: 10 })
  .png()
  .toBuffer();
const entries = await Promise.all(TRAY_ICON_SIZES.map(async size => ({ size, png: await renderBitmap(logo, size) })));
const output = join(project, 'assets/tray.ico');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, packIco(entries));
console.log(JSON.stringify({ ok: true, output: 'assets/tray.ico', sizes: TRAY_ICON_SIZES, bytes: packIco(entries).length }));
