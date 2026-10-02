const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const PACKAGE_LOCK_JSON = path.join(ROOT, 'package-lock.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const VERSION_FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md'];

function usage() {
  console.error('Usage: node scripts/bump-version.js <version> [--date YYYY-MM-DD] [--notes "text"] [--no-commit]');
  console.error('Example: node scripts/bump-version.js 0.2.1 --notes "Fix Electron ABI 146 native packaging."');
  console.error('Updates and commits version files by default; --no-commit only updates files.');
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseArgs(argv) {
  const args = [...argv];
  const version = args.shift();
  const options = {
    date: formatLocalDate(new Date()),
    notes: [],
    commit: true,
  };

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--date') {
      options.date = args.shift();
    } else if (flag === '--notes') {
      options.notes.push(args.shift());
    } else if (flag === '--no-commit') {
      options.commit = false;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  if (!version) {
    usage();
    process.exit(1);
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid version "${version}". Expected semver like 0.2.1.`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error(`Invalid date "${options.date}". Expected YYYY-MM-DD.`);
  }

  return { version, ...options };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function checkCommitPreconditions() {
  try {
    const gitRoot = fs.realpathSync(git(['rev-parse', '--show-toplevel']));
    const scriptRoot = fs.realpathSync(ROOT);
    const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(gitRoot) !== normalize(scriptRoot)) {
      throw new Error('The script must run from the CodeSearch repository root.');
    }
    git(['ls-files', '--error-unmatch', '--', ...VERSION_FILES]);
    if (git(['status', '--porcelain', '--untracked-files=all', '--', ...VERSION_FILES])) {
      throw new Error('Version files already have uncommitted changes; commit them first.');
    }
  } catch (error) {
    throw new Error(
      `Cannot automatically commit the version bump: ${error.message}\n` +
      'No version files were changed. Use --no-commit for the previous files-only behavior.'
    );
  }
}

function commitVersion(version) {
  if (!git(['diff', '--name-only', '--', ...VERSION_FILES])) {
    console.log('No version changes to commit.');
    return;
  }
  try {
    // --only commits these working-tree paths without including other staged work.
    console.log(git(['commit', '--only', '-m', `chore: bump version to ${version}`, '--', ...VERSION_FILES]));
  } catch (error) {
    throw new Error(
      `Version files were updated, but the commit failed: ${error.message}\n` +
      'Changes were kept. After fixing the Git error, commit only package.json, package-lock.json, and CHANGELOG.md.'
    );
  }
}

function updatePackageJson(version) {
  const pkg = readJson(PACKAGE_JSON);
  const previous = pkg.version;
  pkg.version = version;
  writeJson(PACKAGE_JSON, pkg);
  return previous;
}

function updatePackageLock(version) {
  const lock = readJson(PACKAGE_LOCK_JSON);
  lock.version = version;

  if (lock.packages?.['']) {
    lock.packages[''].version = version;
  }

  writeJson(PACKAGE_LOCK_JSON, lock);
}

function defaultNotes(version) {
  return [`Release ${version}.`];
}

function formatChangelogEntry(version, date, notes) {
  const lines = [`## [${version}] - ${date}`, '', '### Changed'];
  for (const note of notes.length > 0 ? notes : defaultNotes(version)) {
    lines.push(`- ${note}`);
  }
  return `${lines.join('\n')}\n\n`;
}

function updateChangelog(version, date, notes) {
  const current = fs.readFileSync(CHANGELOG, 'utf8');
  const heading = `## [${version}]`;

  if (current.includes(heading)) {
    console.log(`CHANGELOG.md already contains ${heading}; leaving it unchanged.`);
    return;
  }

  const firstVersionHeading = current.search(/^## \[/m);
  const entry = formatChangelogEntry(version, date, notes);

  if (firstVersionHeading === -1) {
    fs.writeFileSync(CHANGELOG, `${current.trimEnd()}\n\n${entry}`);
    return;
  }

  const updated =
    current.slice(0, firstVersionHeading) +
    entry +
    current.slice(firstVersionHeading);
  fs.writeFileSync(CHANGELOG, updated);
}

function main() {
  const { version, date, notes, commit } = parseArgs(process.argv.slice(2));
  if (commit) checkCommitPreconditions();
  const previous = updatePackageJson(version);
  updatePackageLock(version);
  updateChangelog(version, date, notes.filter(Boolean));

  console.log(`Updated version ${previous} -> ${version}`);
  console.log('Updated package.json, package-lock.json, and CHANGELOG.md.');
  if (commit) commitVersion(version);
  else console.log('Skipped commit (--no-commit).');
  console.log(`Release tag must be v${version}.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
