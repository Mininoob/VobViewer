// Renders assets/icon.svg into the app's .ico and the website's favicons.
// Usage: node scripts/make-icon.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'assets', 'icon.svg'));

const png = (size) => sharp(svg, { density: 300 }).resize(size, size).png().toBuffer();

const [p16, p24, p32, p48, p64, p128, p180, p256] = await Promise.all(
  [16, 24, 32, 48, 64, 128, 180, 256].map(png)
);

mkdirSync(join(root, 'assets'), { recursive: true });

// App icon: multi-size .ico for the exe (packager) and a png for the dev window.
writeFileSync(join(root, 'assets', 'icon.ico'), await pngToIco([p16, p24, p32, p48, p64, p128, p256]));
writeFileSync(join(root, 'assets', 'icon-256.png'), p256);
console.log('make-icon: wrote assets/icon.ico and assets/icon-256.png');

// The website lives outside this repo; refresh its favicons when it's present.
const siteAssets = join(root, '..', 'VobViewer-site', 'site', 'assets');
if (existsSync(siteAssets)) {
  writeFileSync(join(siteAssets, 'favicon.ico'), await pngToIco([p16, p32, p48]));
  writeFileSync(join(siteAssets, 'icon-32.png'), p32);
  writeFileSync(join(siteAssets, 'icon-180.png'), p180);
  console.log('make-icon: refreshed site favicons in', siteAssets);
}
