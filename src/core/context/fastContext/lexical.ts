/**
 * Lexical name helpers used when ranking snippet symbols against a query.
 *
 * They stayed in TypeScript because they run on a handful of symbol names per
 * request — moving them to Rust would add a round-trip for microseconds of work.
 */

/** Splits camelCase / snake_case / kebab-case into components.
 *  getUserById → ['get', 'user', 'by', 'id'] */
export function splitNameParts(name: string): string[] {
  return name
    // camelCase: insert the break in the ORIGINAL string — lowercasing first
    // would make [A-Z] never match.
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(part => part.length >= 2)
}

const STEMMED_CACHE = new Map<string, string>()

/** Lightweight stemmer: plurals + common suffixes.
 *  users → user, authentication → auth, configuration → config */
export function stem(word: string): string {
  const cached = STEMMED_CACHE.get(word)
  if (cached !== undefined) return cached
  let s = word
  // Plurals
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y'
  else if (s.length > 3 && s.endsWith('es')) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
  // Common suffixes → abbreviation
  if (s.length > 6 && s.endsWith('tion')) s = s.slice(0, -4)
  else if (s.length > 5 && s.endsWith('ment')) s = s.slice(0, -4)
  else if (s.length > 4 && s.endsWith('ing')) s = s.slice(0, -3)
  else if (s.length > 4 && s.endsWith('er') && !s.endsWith('eer')) s = s.slice(0, -2)
  else if (s.length > 4 && s.endsWith('ed') && !s.endsWith('eed')) s = s.slice(0, -2)
  else if (s.length > 8 && s.endsWith('ization')) s = s.slice(0, -7)
  else if (s.length > 9 && s.endsWith('izations')) s = s.slice(0, -8)
  else if (s.length > 6 && s.endsWith('ware')) s = s.slice(0, -4)
  else if (s.length > 7 && s.endsWith('ation')) s = s.slice(0, -5)
  else if (s.length > 6 && s.endsWith('al') && !s.endsWith('ial')) s = s.slice(0, -2)
  else if (s.length > 6 && s.endsWith('ity')) s = s.slice(0, -3)
  else if (s.length > 6 && s.endsWith('ness')) s = s.slice(0, -4)
  else if (s.length > 7 && (s.endsWith('ance') || s.endsWith('ence'))) s = s.slice(0, -4)
  else if (s.length > 5 && (s.endsWith('ize') || s.endsWith('ise'))) s = s.slice(0, -3)
  STEMMED_CACHE.set(word, s)
  return s
}
