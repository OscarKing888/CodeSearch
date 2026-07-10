export const TOKEN_SUGGESTION_CANDIDATE_LIMIT = 500;

export interface TokenSuggestion {
  token: string;
  freq: number;
}

export function compareTokenSuggestions(a: TokenSuggestion, b: TokenSuggestion): number {
  return a.token.length - b.token.length || b.freq - a.freq;
}

export function finalizeTokenSuggestions(
  candidates: TokenSuggestion[],
  limit: number
): TokenSuggestion[] {
  return [...candidates].sort(compareTokenSuggestions).slice(0, limit);
}

export const TOKEN_AUTOCOMPLETE_INDEX = 'idx_tokens_token_freq';

export const TOKEN_AUTOCOMPLETE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_tokens_token_freq
  ON tokens(token COLLATE NOCASE, freq DESC);
`;
