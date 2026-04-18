const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "you",
  "are",
  "was",
  "were",
  "has",
  "have",
  "not",
  "but",
  "can",
  "may",
  "use",
  "using",
  "based",
  "study",
  "patients",
  "patient",
  "treatment",
  "disease",
  "clinical",
  "trial",
  "trials",
  "research",
  "effects",
  "effect",
  "new",
  "also",
  "between",
  "than",
  "more",
  "such",
  "our",
  "their",
  "its",
  "an",
  "a",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "or",
  "as",
  "is",
  "be",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function keywordScore(queryTokens, title, abstract) {
  if (!queryTokens.length) return 0;
  const hay = new Map();
  for (const t of tokenize(`${title}\n${abstract}`)) {
    hay.set(t, (hay.get(t) || 0) + 1);
  }
  let score = 0;
  for (const qt of queryTokens) {
    const c = hay.get(qt);
    if (c) score += 1 + Math.log1p(c);
  }
  return score / Math.sqrt(queryTokens.length + 1);
}

function recencyBoost(year) {
  if (!year || !Number.isFinite(year)) return 0;
  const y = new Date().getFullYear();
  const age = Math.max(0, y - year);
  return Math.max(0, 6 - age * 0.35);
}

function venueCredibility(pub) {
  const venue = String(pub.hostVenue || pub.journal || "").toLowerCase();
  if (!venue) return 0;
  const topSignals = ["lancet", "nejm", "jama", "bmj", "nature", "science", "cell", "plos", "cochrane"];
  for (const s of topSignals) if (venue.includes(s)) return 2;
  return 0.5;
}

function normalizeTitleKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Merge OpenAlex + PubMed, dedupe by title similarity, rank, return top N.
 */
export function rankPublications(publications, { queryText, topN = 8 } = {}) {
  const queryTokens = tokenize(queryText);
  const byKey = new Map();
  for (const p of publications) {
    const key = normalizeTitleKey(p.title);
    if (!key) continue;
    const score =
      3 * keywordScore(queryTokens, p.title, p.abstract) +
      recencyBoost(p.year) +
      venueCredibility(p) +
      (p.platform === "PubMed" ? 0.25 : 0) +
      Math.log1p(Number(p.citedByCount || 0)) * 0.15;
    const prev = byKey.get(key);
    if (!prev || score > prev._score) {
      byKey.set(key, { ...p, _score: score });
    }
  }
  const merged = [...byKey.values()].sort((a, b) => b._score - a._score);
  return merged.slice(0, topN).map(({ _score, ...rest }) => ({
    ...rest,
    relevanceScore: Number(_score.toFixed(3)),
    supportingSnippet: snippetFromAbstract(rest.abstract, queryTokens),
  }));
}

function snippetFromAbstract(abstract, queryTokens, maxLen = 420) {
  const text = String(abstract || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  let bestIdx = 0;
  let best = -1;
  for (const t of queryTokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (best < 0 || idx < bestIdx)) {
      bestIdx = idx;
      best = idx;
    }
  }
  const start = best >= 0 ? Math.max(0, bestIdx - 80) : 0;
  const slice = text.slice(start, start + maxLen);
  return start > 0 ? `…${slice}` : slice;
}

export function rankTrials(trials, { queryText, topN = 8 } = {}) {
  const queryTokens = tokenize(queryText);
  const scored = trials.map((t) => {
    const hay = `${t.title}\n${t.eligibility}\n${t.locations}`;
    const score =
      2.5 * keywordScore(queryTokens, t.title, hay) +
      (String(t.status).toUpperCase().includes("RECRUIT") ? 0.75 : 0) +
      (t.locations && t.locations.length > 20 ? 0.35 : 0);
    return { ...t, _score: score };
  });
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, topN).map(({ _score, ...rest }) => ({
    ...rest,
    relevanceScore: Number(_score.toFixed(3)),
    supportingSnippet: snippetFromAbstract(`${rest.title}. ${rest.eligibility}`, queryTokens, 360),
  }));
}
