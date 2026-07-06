#!/usr/bin/env node
/**
 * Patches package.json codeSearch.indexThreads enum based on build machine CPU count.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const packagePath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

const cpuCount = Math.max(1, os.cpus().length);
const enumValues = [0, ...Array.from({ length: cpuCount }, (_, i) => i + 1)];
const enumItemLabels = [
  `自动（本机 ${cpuCount} 线程）`,
  ...Array.from({ length: cpuCount }, (_, i) => {
    const n = i + 1;
    return n === cpuCount ? `${n} 线程（全部）` : `${n} 线程`;
  }),
];

const props = pkg.contributes?.configuration?.properties;
if (!props) {
  console.error('package.json: missing contributes.configuration.properties');
  process.exit(1);
}

props['codeSearch.indexThreads'] = {
  type: 'number',
  default: 0,
  enum: enumValues,
  enumItemLabels,
  description: `Concurrent file-read threads during indexing. Auto uses all logical processors on this machine (${cpuCount} detected at build time; runtime auto always uses live CPU count).`,
};

fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`Updated codeSearch.indexThreads enum: 0 (auto) + 1..${cpuCount}`);
