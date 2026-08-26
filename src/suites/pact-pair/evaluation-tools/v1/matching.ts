/**
 * Fact-matching semantics for the evaluation tools.
 *
 * VERBATIM copy of the matcher in pulse `research/scripts/eval_single_step.ts`
 * (norm / expandDollarVariants / extractValuePart / extractKeyTokens /
 * containsFact). The report's numbers were produced by that matcher, so the
 * PACT-side tools must reproduce it bit-for-bit — do NOT "improve" this file.
 *
 * Known, deliberate quirks (kept for reproducibility):
 * - token matching is substring-based on normalized text, so e.g. the token
 *   "version" matches inside "conversion";
 * - no stemming; plural/singular differ unless one is a substring of the other.
 *
 * This intentionally preserves the historical matcher used to produce the
 * benchmark report; changing it would make past and current scores diverge.
 */

export function norm(s: string): string {
  return s
    .replace(/[‘’‚‹›]/g, "'")
    .replace(/[“”„«»]/g, '"')
    .replace(/[–—]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function expandDollarVariants(s: string): string[] {
  const variants: string[] = [s];
  const kMatch = s.match(/^\$?([\d,.]+)k$/i);
  if (kMatch) {
    const num = parseFloat(kMatch[1].replace(/,/g, ''));
    const full = num * 1000;
    const formatted = full.toLocaleString('en-US');
    variants.push(`$${formatted}`, `${formatted}`, `$${num}k`, `${num}k`);
  }
  const fullMatch = s.match(/^\$?([\d,]+)$/);
  if (fullMatch) {
    const num = parseFloat(fullMatch[1].replace(/,/g, ''));
    if (num >= 1000 && num % 1000 === 0) {
      const k = num / 1000;
      variants.push(`$${k}k`, `${k}k`);
    }
  }
  const mMatch = s.match(/^\$?([\d,.]+)m$/i);
  if (mMatch) {
    const num = parseFloat(mMatch[1].replace(/,/g, ''));
    const full = num * 1_000_000;
    const formatted = full.toLocaleString('en-US');
    variants.push(`$${formatted}`, `${formatted}`, `$${num}m`, `${num}m`);
  }
  return [...new Set(variants.map((v) => v.toLowerCase()))];
}

export function extractValuePart(fact: string): string[] {
  const parts = [norm(fact)];
  const colonIdx = fact.indexOf(': ');
  if (colonIdx > 0 && colonIdx < fact.length - 2) {
    parts.push(norm(fact.slice(colonIdx + 2)));
  }
  return parts;
}

export function extractKeyTokens(fact: string): string[] {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'of', 'to', 'for', 'in',
    'on', 'by', 'at', 'and', 'or', 'but', 'with', 'from', 'that', 'this',
    'has', 'had', 'not', 'no', 'be', 'been', 'being', 'it', 'its',
  ]);
  const normalized = norm(fact);
  const specials: string[] = [];
  let working = normalized;
  working = working.replace(/~?\$[\d,.]+[km]?(?:\/\w+)?/g, (m) => { specials.push(m.replace(/^~/, '')); return ' '; });
  working = working.replace(/\/[\w/.-]+/g, (m) => { specials.push(m); return ' '; });
  working = working.replace(/[\d.]+%/g, (m) => { specials.push(m); return ' '; });
  working = working.replace(
    /(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?/g,
    (m) => { specials.push(m); return ' '; },
  );
  working = working.replace(/#[\w]+/g, (m) => { specials.push(m); return ' '; });
  const wordTokens = working.split(/[\s,;:()\[\]{}]+/).filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  return [...specials, ...wordTokens];
}

export function containsFact(text: string, fact: string): boolean {
  const normText = norm(text);
  const candidates = extractValuePart(fact);
  for (const candidate of candidates) {
    if (normText.includes(candidate)) return true;
    for (const variant of expandDollarVariants(candidate)) {
      if (normText.includes(variant)) return true;
    }
  }
  for (const candidate of candidates) {
    const tokens = extractKeyTokens(candidate);
    if (tokens.length === 0) continue;
    let matched = 0;
    for (const token of tokens) {
      if (token.includes('$') || /^\d+[km]$/i.test(token)) {
        if (expandDollarVariants(token).some((v) => normText.includes(v))) { matched += 1; continue; }
      }
      if (normText.includes(token)) matched += 1;
    }
    if (matched === tokens.length) return true;
  }
  return false;
}
