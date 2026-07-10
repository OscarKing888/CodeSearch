export function formatIndexDisplayTitle(rootDirs: string[], fallbackName: string): string {
  if (rootDirs.length === 0) {
    return fallbackName || '—';
  }
  return rootDirs.join('; ');
}
