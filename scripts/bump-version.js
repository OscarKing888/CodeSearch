const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const PACKAGE_LOCK_JSON = path.join(ROOT, 'package-lock.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const VERSION_FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md'];

// bump-version.sh / bump-version.bat set this before running the script. They own the commit,
// tag, and push via plain git commands; this script validates, updates files, and prints the plan.
const ENTRY_ENV = 'CODESEARCH_BUMP_ENTRY';

function usage() {
  console.error('Usage: ./bump-version.sh | bump-version.bat <version> [--date YYYY-MM-DD] [--notes "text"] [--no-tag] [--no-push] [--no-commit]');
  console.error('Example: ./bump-version.sh 0.2.1 --notes "Fix Electron ABI 146 native packaging."');
  console.error('Updates, commits, creates an annotated version tag, and pushes main with the tag by default.');
  console.error('--no-tag skips the tag; --no-push keeps the commit and tag local; --no-commit only updates files.');
  console.error('Running node scripts/bump-version.js (or npm run version:bump) directly supports --no-commit only.');
}

// stdout carries only the key=value plan for the entry scripts; messages go to stderr.
function info(message) {
  console.error(message);
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
    tag: true,
    push: true,
  };

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--date') {
      options.date = args.shift();
    } else if (flag === '--notes') {
      options.notes.push(args.shift());
    } else if (flag === '--no-commit') {
      options.commit = false;
    } else if (flag === '--no-tag') {
      options.tag = false;
    } else if (flag === '--no-push') {
      options.push = false;
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

  return { version, ...options, tag: options.commit && options.tag, push: options.commit && options.push };
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

function checkCommitPreconditions(version, tag, push) {
  try {
    const gitRoot = fs.realpathSync(git(['rev-parse', '--show-toplevel']));
    const scriptRoot = fs.realpathSync(ROOT);
    const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(gitRoot) !== normalize(scriptRoot)) {
      throw new Error('The script must run from the CodeSearch repository root.');
    }
    git(['ls-files', '--error-unmatch', '--', ...VERSION_FILES]);
    // Releases are pushed as origin/main, so never publish a work branch by accident.
    if (push && git(['branch', '--show-current']) !== 'main') {
      throw new Error('Pushing a release requires this checkout to be on main; use --no-push to commit and tag locally.');
    }
    if (git(['status', '--porcelain', '--untracked-files=all', '--', ...VERSION_FILES])) {
      throw new Error('Version files already have uncommitted changes; commit them first.');
    }
    const tagName = `v${version}`;
    if (tag) git(['check-ref-format', `refs/tags/${tagName}`]);
    if (tag && git(['tag', '--list', tagName])) {
      // A repeated request may reuse the tag even after unrelated later commits.
      // Never replace an existing tag or write files for a conflicting release.
      if (readJson(PACKAGE_JSON).version !== version ||
          git(['diff', '--name-only', `${tagName}^{commit}`, 'HEAD', '--', ...VERSION_FILES])) {
        throw new Error(`Version tag ${tagName} already exists for different version files; use a new version.`);
      }
      return true;
    }
    return false;
  } catch (error) {
    throw new Error(
      `Cannot automatically commit the version bump: ${error.message}\n` +
      'No version files were changed. Use --no-commit for the previous files-only behavior.'
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
    info(`CHANGELOG.md already contains ${heading}; leaving it unchanged.`);
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
  const { version, date, notes, commit, tag, push } = parseArgs(process.argv.slice(2));
  if (commit && process.env[ENTRY_ENV] !== '1') {
    throw new Error('Run ./bump-version.sh or bump-version.bat to commit, tag, and push a version; ' +
      'running this script directly supports --no-commit only. No version files were changed.');
  }
  const plan = (needsCommit, createTag) => ({
    version, commit: needsCommit, create_tag: createTag, push, push_tag: push && tag,
  });
  if (commit && checkCommitPreconditions(version, tag, push)) {
    info(`Version ${version} is already committed and tagged as v${version}; no new commit needed.`);
    return plan(false, false);
  }
  const previous = updatePackageJson(version);
  updatePackageLock(version);
  updateChangelog(version, date, notes.filter(Boolean));

  info(`Updated version ${previous} -> ${version}`);
  info('Updated package.json, package-lock.json, and CHANGELOG.md.');
  if (!commit) {
    info('Skipped commit, tag, and push (--no-commit).');
    info(`Release tag must be v${version}.`);
    return plan(false, false);
  }
  const needsCommit = Boolean(git(['diff', '--name-only', '--', ...VERSION_FILES]));
  if (!needsCommit) info('No version changes to commit.');
  return plan(needsCommit, tag);
}

function formatPlan(plan) {
  return Object.entries(plan)
    .map(([key, value]) => `${key}=${typeof value === 'boolean' ? Number(value) : value}`)
    .join('\n') + '\n';
}

try {
  process.stdout.write(formatPlan(main()));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
