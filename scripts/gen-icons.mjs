// One-off: render public/icon.svg to PNGs at common sizes.
// Run with: node scripts/gen-icons.mjs
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const svgPath = path.join(root, 'public', 'icon.svg');
const outDir = path.join(root, 'public');

const sizes = [
  { size: 1024, name: 'icon-1024.png' }, // app stores / source
  { size: 512, name: 'icon-512.png' },   // PWA splash
  { size: 192, name: 'icon-192.png' },   // Android home screen
  { size: 180, name: 'icon-180.png' },   // iOS home screen
];

const svg = await fs.readFile(svgPath);

for (const { size, name } of sizes) {
  const out = path.join(outDir, name);
  await sharp(svg, { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`Wrote ${out}`);
}
