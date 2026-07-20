import { canonicalPathKey } from './sharedIndexStorage';

export interface StartupPrimaryCandidate<T, TDetails = undefined> {
  dbPath: string;
  details: TDetails;
  open: () => Promise<T>;
}

export interface StartupPrimaryFailure<TDetails = undefined> {
  dbPath: string;
  details: TDetails;
  error: unknown;
}

export interface StartupPrimarySelection<T, TDetails = undefined> {
  selected?: {
    candidate: StartupPrimaryCandidate<T, TDetails>;
    value: T;
  };
  failures: StartupPrimaryFailure<TDetails>[];
}

/**
 * Opens startup candidates in priority order and keeps going after a stale or
 * invalid database. A physical path is attempted at most once so a failed
 * saved binding is not immediately retried through legacy registry metadata.
 */
export async function selectFirstUsableStartupPrimary<T, TDetails = undefined>(
  candidates: readonly StartupPrimaryCandidate<T, TDetails>[],
  onFailure?: (failure: StartupPrimaryFailure<TDetails>) => void
): Promise<StartupPrimarySelection<T, TDetails>> {
  const attemptedPaths = new Set<string>();
  const failures: StartupPrimaryFailure<TDetails>[] = [];

  for (const candidate of candidates) {
    const key = canonicalPathKey(candidate.dbPath);
    if (attemptedPaths.has(key)) {
      continue;
    }
    attemptedPaths.add(key);

    try {
      const value = await candidate.open();
      return {
        selected: { candidate, value },
        failures,
      };
    } catch (error) {
      const failure = {
        dbPath: candidate.dbPath,
        details: candidate.details,
        error,
      };
      failures.push(failure);
      onFailure?.(failure);
    }
  }

  return { failures };
}
