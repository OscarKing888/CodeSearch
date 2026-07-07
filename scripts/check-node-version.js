const MIN_MAJOR = 20;

function main() {
  const version = process.versions.node;
  const major = Number(version.split('.')[0]);

  if (!Number.isInteger(major) || major < MIN_MAJOR) {
    console.error(`[ERROR] Node.js ${MIN_MAJOR}+ is required. Current: v${version}`);
    console.error(`        Executable: ${process.execPath}`);
    console.error('        Install Node.js 20/22/24 LTS and make sure it is first on PATH.');
    console.error('        better-sqlite3 and @vscode/vsce in this repo do not support Node 16.');
    process.exit(1);
  }
}

main();
