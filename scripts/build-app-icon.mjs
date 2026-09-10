import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../desktop/assets/', import.meta.url));
await mkdir(directory, { recursive: true });
const svg = await readFile(`${directory}/jarvisync.svg`, 'utf8');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const entries = [];
try {
  const page = await browser.newPage();
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
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
const header = Buffer.alloc(6 + entries.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(({ size, png }, index) => {
  const position = 6 + index * 16;
  header[position] = header[position + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, position + 4);
  header.writeUInt16LE(32, position + 6);
  header.writeUInt32LE(png.length, position + 8);
  header.writeUInt32LE(offset, position + 12);
  offset += png.length;
});
await writeFile(`${directory}/jarvisync.ico`, Buffer.concat([header, ...entries.map(item => item.png)]));
process.stdout.write(`Created JarviSync icon (${entries.length} sizes).\n`);
