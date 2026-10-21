// Renders assets/icon.svg into the app's .ico and the website's favicons.
// Usage: node scripts/make-icon.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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
mkdirSync(join(root, 'site', 'assets'), { recursive: true });

// App icon: multi-size .ico for the exe (packager) and a png for the dev window.
writeFileSync(join(root, 'assets', 'icon.ico'), await pngToIco([p16, p24, p32, p48, p64, p128, p256]));
writeFileSync(join(root, 'assets', 'icon-256.png'), p256);

// Site favicons.
writeFileSync(join(root, 'site', 'assets', 'favicon.ico'), await pngToIco([p16, p32, p48]));
writeFileSync(join(root, 'site', 'assets', 'icon-32.png'), p32);
writeFileSync(join(root, 'site', 'assets', 'icon-180.png'), p180);

console.log('make-icon: wrote assets/icon.ico, assets/icon-256.png and site/assets favicons');
