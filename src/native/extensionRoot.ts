import * as fs from 'fs';
import * as path from 'path';

function hasNodeNativeBinding(root: string): boolean {
  const tag = `${process.platform}-${process.arch}-${process.versions.modules}`;
  return (
    fs.existsSync(
      path.join(root, 'native-node', tag, 'better_sqlite3.node')
    ) ||
    fs.existsSync(
      path.join(
        root,
        'node_modules',
        'better-sqlite3',
        'build',
        'Release',
        'better_sqlite3.node'
      )
    )
  );
}

/**
 * Resolve an installed extension root from either bundled `dist/` code or an
 * unbundled TypeScript source directory. A package root with a usable binding
 * wins; otherwise the nearest package root is returned so the native loader can
 * produce its detailed missing-ABI diagnostic.
 */
export function resolveExtensionRoot(startDir: string): string {
  let current = path.resolve(startDir);
  let nearestPackageRoot: string | undefined;

  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      nearestPackageRoot ??= current;
      if (hasNodeNativeBinding(current)) {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  if (nearestPackageRoot) {
    return nearestPackageRoot;
  }
  throw new Error(
    `Unable to locate the Ace Code Search extension root from ${path.resolve(startDir)}. ` +
      'Pass --extension-root <dir> explicitly.'
  );
}
