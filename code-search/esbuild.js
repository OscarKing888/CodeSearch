const esbuild = require('esbuild');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const watch = process.argv.includes('--watch');

function generateIndexThreadsSchema() {
  execSync('node scripts/generate-index-threads-schema.js', {
    cwd: path.join(__dirname),
    stdio: 'inherit',
  });
}

const extOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', 'better-sqlite3'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
};

const cliOptions = {
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

const webviewOptions = {
  entryPoints: ['src/ui/webview/main.ts'],
  bundle: true,
  outfile: 'dist/webview/main.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
};

const manageWebviewOptions = {
  entryPoints: ['src/ui/manage-webview/main.ts'],
  bundle: true,
  outfile: 'dist/webview/manage.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
};

async function build() {
  generateIndexThreadsSchema();
  fs.mkdirSync('dist/webview', { recursive: true });
  await esbuild.build(extOptions);
  await esbuild.build(cliOptions);
  await esbuild.build(webviewOptions);
  await esbuild.build(manageWebviewOptions);
  console.log('Build complete.');
}

async function watchBuild() {
  generateIndexThreadsSchema();
  fs.mkdirSync('dist/webview', { recursive: true });
  const extCtx = await esbuild.context(extOptions);
  const cliCtx = await esbuild.context(cliOptions);
  const webCtx = await esbuild.context(webviewOptions);
  const manageCtx = await esbuild.context(manageWebviewOptions);
  await extCtx.watch();
  await cliCtx.watch();
  await webCtx.watch();
  await manageCtx.watch();
  console.log('Watching...');
}

if (watch) {
  watchBuild().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  build().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
