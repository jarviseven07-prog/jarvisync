import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// .ico wants the small sizes, .icns wants the powers of two up to 1024.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icnsSizes = [16, 32, 64, 128, 256, 512, 1024];
const directory = fileURLToPath(new URL('../desktop/assets/', import.meta.url));
await mkdir(directory, { recursive: true });
const svg = await readFile(`${directory}/jarvisync.svg`, 'utf8');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const entries = [];
try {
  const page = await browser.newPage();
  for (const size of [...new Set([...icoSizes, ...icnsSizes])].sort((a, b) => a - b)) {
    const base64 = await page.evaluate(async ({ svg, size }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { svg, size });
    const png = Buffer.from(base64, 'base64');
    entries.push({ size, png });
    if (size === 256) await writeFile(`${directory}/jarvisync.png`, png);
  }
} finally { await browser.close(); }
const icoEntries = entries.filter(entry => icoSizes.includes(entry.size));
const header = Buffer.alloc(6 + icoEntries.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoEntries.length, 4);
let offset = header.length;
icoEntries.forEach(({ size, png }, index) => {
  const position = 6 + index * 16;
  header[position] = header[position + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, position + 4);
  header.writeUInt16LE(32, position + 6);
  header.writeUInt32LE(png.length, position + 8);
  header.writeUInt32LE(offset, position + 12);
  offset += png.length;
});
await writeFile(`${directory}/jarvisync.ico`, Buffer.concat([header, ...icoEntries.map(item => item.png)]));

// iconutil ships with macOS, so the .icns is only rebuilt when running there. The committed file
// keeps Windows and Linux checkouts able to package a macOS build from an existing icon.
if (process.platform === 'darwin') {
  const iconset = await mkdtemp(join(tmpdir(), 'jarvisync-iconset-'));
  const bundle = join(iconset, 'jarvisync.iconset');
  await mkdir(bundle, { recursive: true });
  const bytesFor = size => entries.find(entry => entry.size === size).png;
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(join(bundle, `icon_${size}x${size}.png`), bytesFor(size));
    await writeFile(join(bundle, `icon_${size}x${size}@2x.png`), bytesFor(size * 2));
  }
  await promisify(execFile)('iconutil', ['-c', 'icns', bundle, '-o', `${directory}/jarvisync.icns`]);
  await rm(iconset, { recursive: true, force: true });
}

process.stdout.write(`Created JarviSync icon (${entries.length} sizes${process.platform === 'darwin' ? ', including .icns' : ''}).\n`);
