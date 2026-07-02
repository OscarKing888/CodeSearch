import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { getIndexingSettings } from '../indexingSettings';
import { FileRecord } from '../types';

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  '.cs', '.vb', '.fs', '.fsx',
  '.php', '.swift', '.m', '.mm',
  '.lua', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.html', '.htm', '.xml', '.xaml', '.svg',
  '.css', '.scss', '.sass', '.less',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.md', '.markdown', '.txt', '.rst', '.adoc',
  '.vue', '.svelte', '.astro',
  '.gradle', '.cmake', '.makefile', '.dockerfile',
  '.proto', '.graphql', '.gql',
  '.r', '.pl', '.pm', '.tcl', '.v', '.sv', '.vhdl',
  '.asm', '.s', '.uplugin', '.uproject', '.Build.cs',
  '.gitignore', '.editorconfig', '.env',
]);

export function isBinaryBuffer(buf: Buffer): boolean {
  if (buf.length === 0) {
    return false;
  }
  const sample = buf.subarray(0, Math.min(512, buf.length));
  let nullCount = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) {
      nullCount++;
    }
  }
  return nullCount / sample.length > 0.3;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function matchesAny(patterns: string[], filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return patterns.some((pattern) => minimatch(normalized, pattern, { dot: true, nocase: process.platform === 'win32' }));
}

export function shouldIndexFile(
  filePath: string,
  config: { excludeGlobs: string[]; includeGlobs: string[]; maxFileSizeKB: number },
  sizeBytes: number
): boolean {
  const normalized = normalizePath(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  if (sizeBytes > config.maxFileSizeKB * 1024) {
    return false;
  }

  if (!matchesAny(config.includeGlobs, normalized)) {
    return false;
  }

  if (matchesAny(config.excludeGlobs, normalized)) {
    return false;
  }

  if (ext && TEXT_EXTENSIONS.has(ext)) {
    return true;
  }

  if (!ext && TEXT_EXTENSIONS.has('.' + basename.toLowerCase())) {
    return true;
  }

  // Extensionless common files
  if (!ext && ['makefile', 'dockerfile', 'license', 'readme', 'changelog'].includes(basename.toLowerCase())) {
    return true;
  }

  // Unknown extension: allow if small enough (will binary-check on read)
  return sizeBytes < 512 * 1024;
}

export async function readFileForIndex(filePath: string): Promise<FileRecord | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }

    const buf = await fs.promises.readFile(filePath);
    if (isBinaryBuffer(buf)) {
      return null;
    }

    const content = buf.toString('utf8');
    const dir = normalizePath(path.dirname(filePath));
    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();

    return {
      path: filePath,
      mtime: Math.floor(stat.mtimeMs),
      size: stat.size,
      ext,
      dir,
      content,
    };
  } catch {
    return null;
  }
}

export async function* walkDirectory(
  rootDir: string,
  config: { excludeGlobs: string[]; includeGlobs: string[]; maxFileSizeKB: number }
): AsyncGenerator<string> {
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const normalized = normalizePath(fullPath);

      if (entry.isDirectory()) {
        if (matchesAny(config.excludeGlobs, normalized + '/')) {
          continue;
        }
        stack.push(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (shouldIndexFile(fullPath, config, stat.size)) {
            yield fullPath;
          }
        } catch {
          // skip
        }
      }
    }
  }
}

export function extractTokens(content: string): string[] {
  const tokens = new Set<string>();
  const regex = /[a-zA-Z_][a-zA-Z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[0].length >= 2) {
      tokens.add(match[0]);
    }
  }
  return Array.from(tokens);
}
