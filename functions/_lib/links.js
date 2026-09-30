// URL extraction for the contact panel's Links tab.
//
// Extraction happens at QUERY TIME from the message body — nothing is stored,
// so there is no column and no backfill. The endpoint pre-filters to messages
// whose body contains "http" (an index-friendly ILIKE), then this pulls the
// actual URLs out.

// Matches http:// and https:// URLs. Intentionally does NOT match bare
// "www.foo.com" or scheme-less domains: without a scheme the false-positive
// rate on ordinary prose ("acme.com", "e.g.") is high enough to make the tab
// noise. The pre-filter is ILIKE '%http%', so scheme-less URLs never reach
// here anyway — the two are consistent by design.
//
// Parens ARE allowed inside the match so Wikipedia-style links survive;
// trimUrl() then strips a trailing ')' only when it is unbalanced (i.e. the
// sentence "(see https://x.com)" rather than part of the path).
const URL_RE = /https?:\/\/[^\s<>[\]{}"']+/gi

// Trailing punctuation that is almost always sentence punctuation, not part of
// the URL: "see https://x.com." or "(https://x.com)". Stripped from the end
// only. A closing paren is stripped unless the URL itself contains an opening
// one (Wikipedia-style links).
const TRAILING = /[.,;:!?]+$/

function trimUrl(raw) {
  let url = raw
  // Balance parens: drop a trailing ')' only when it is unmatched within the URL.
  while (url.endsWith(')') && (url.match(/\(/g)?.length || 0) < (url.match(/\)/g)?.length || 0)) {
    url = url.slice(0, -1)
  }
  url = url.replace(TRAILING, '')
  return url
}

/**
 * Every http(s) URL in a string, de-duplicated, in first-seen order.
 * Returns [] for anything with no URL — the caller drops those rows.
 */
export function extractUrls(text) {
  const source = String(text ?? '')
  if (!source) return []

  const seen = new Set()
  const out = []
  const matches = source.match(URL_RE) || []
  for (const raw of matches) {
    const url = trimUrl(raw)
    // A URL has to have something after the scheme.
    if (!/^https?:\/\/\S/i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/** Does this text contain at least one extractable URL? */
export const hasUrl = (text) => extractUrls(text).length > 0
