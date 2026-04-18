export function buildConversationSummary(messages, maxChars = 1200) {
  const recent = (messages || []).slice(-8);
  const lines = [];
  for (const m of recent) {
    const prefix = m.role === "user" ? "User" : "Assistant";
    const text = String(m.content || "").replace(/\s+/g, " ").trim();
    if (text) lines.push(`${prefix}: ${text}`);
  }
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(joined.length - maxChars);
}

export function deterministicExpansion({ disease, additionalQuery, location }) {
  const d = String(disease || "").trim();
  const q = String(additionalQuery || "").trim();
  const loc = String(location || "").trim();
  const parts = [q, d].filter(Boolean);
  const expandedQuery = parts.join(" ").replace(/\s+/g, " ").trim() || q || d || "medical research";
  return {
    expandedQuery,
    pubmedTerm: [d, q].filter(Boolean).join(" AND ") || expandedQuery,
    openAlexPhrase: expandedQuery,
    trialCondition: d || expandedQuery,
    trialOtherTerms: q || "",
    trialLocation: loc,
    rationale: "Merged disease focus with free-text intent for broader recall, then precision ranking.",
  };
}
