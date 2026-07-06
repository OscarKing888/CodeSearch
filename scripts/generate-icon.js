#!/usr/bin/env node
/**
 * Renders media/search.svg to media/icon.png for the extension marketplace listing.
 * VS Code requires a root-level package.json "icon" PNG (128px+); SVG is not supported.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'media', 'search.svg');
const PNG_PATH = path.join(ROOT, 'media', 'icon.png');

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    console.error(`Missing ${SVG_PATH}`);
    process.exit(1);
  }

  const svg = fs.readFileSync(SVG_PATH);
  await sharp(svg, { density: 384 })
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(PNG_PATH);

  console.log(`Generated ${path.relative(ROOT, PNG_PATH)} (256x256)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
