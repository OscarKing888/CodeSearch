/**
 * Levenshtein distance for fuzzy term matching.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) {
    row[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return row[b.length];
}

export function fuzzyThreshold(word: string): number {
  if (word.length <= 3) {
    return 0;
  }
  if (word.length <= 6) {
    return 1;
  }
  return 2;
}

export function fuzzyMatch(term: string, candidate: string, caseSensitive: boolean): boolean {
  const a = caseSensitive ? term : term.toLowerCase();
  const b = caseSensitive ? candidate : candidate.toLowerCase();

  if (a === b) {
    return true;
  }
  if (a.includes('*')) {
    return wildcardWordMatch(a, b);
  }
  const maxDist = fuzzyThreshold(a);
  if (maxDist === 0) {
    return false;
  }
  return levenshtein(a, b) <= maxDist;
}

function wildcardWordMatch(pattern: string, word: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    'i'
  );
  return regex.test(word);
}

export function expandFuzzyTerms(term: string, dictionary: string[], caseSensitive: boolean): string[] {
  const results = new Set<string>([term]);
  for (const word of dictionary) {
    if (fuzzyMatch(term, word, caseSensitive)) {
      results.add(word);
    }
  }
  return Array.from(results);
}
