const DEFAULT_OLLAMA = "http://127.0.0.1:11434";

function safeJsonParse(text) {
  const raw = String(text || "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function ollamaChat({
  baseUrl,
  model,
  system,
  user,
  temperature = 0.2,
  timeoutMs = 180_000,
  fast = false,
  preset = "default",
}) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/chat`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let options;
  if (preset === "expand") {
    options = { temperature, num_ctx: 2048, num_predict: 384 };
  } else if (fast) {
    options = { temperature, num_ctx: 4096, num_predict: 768 };
  } else {
    options = { temperature, num_ctx: 8192, num_predict: 1536 };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        options,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 240)}`);
    }
    const data = await res.json();
    return data?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

export async function expandQueryWithLlm(
  { disease, additionalQuery, location, conversationSummary },
  { baseUrl, model }
) {
  const system = `You are a biomedical search strategist. Output ONLY valid JSON with keys:
expandedQuery (string, concise English search phrase combining disease + user intent),
pubmedTerm (string, PubMed-friendly boolean-ish phrase),
openAlexPhrase (string, short semantic search),
trialCondition (string, ClinicalTrials.gov condition),
trialOtherTerms (string, optional extra terms),
rationale (one sentence).
No markdown, no commentary outside JSON.`;
  const user = `Disease or condition focus: ${disease || "not specified"}
User question / intent: ${additionalQuery || ""}
Location (for trials geography if relevant): ${location || "not specified"}
Prior thread summary: ${conversationSummary || "none"}

Return JSON now.`;
  const text = await ollamaChat({
    baseUrl: baseUrl || DEFAULT_OLLAMA,
    model,
    system,
    user,
    temperature: 0.15,
    timeoutMs: 45_000,
    preset: "expand",
  });
  const parsed = safeJsonParse(text);
  if (parsed && typeof parsed.expandedQuery === "string") return parsed;
  return null;
}

export async function synthesizeAnswerWithLlm(
  {
    disease,
    additionalQuery,
    location,
    patientName,
    rankedPublications,
    rankedTrials,
    conversationSummary,
  },
  { baseUrl, model, fast = false }
) {
  const snip = fast ? 220 : 400;
  const locMax = fast ? 220 : 400;
  const pubs = rankedPublications.map((p, i) => ({
    n: i + 1,
    platform: p.platform,
    title: p.title,
    year: p.year,
    authors: (p.authors || []).slice(0, 4).join(", "),
    url: p.url,
    snippet: (p.supportingSnippet || (p.abstract || "")).slice(0, snip),
  }));
  const trs = rankedTrials.map((t, i) => ({
    n: i + 1,
    platform: t.platform,
    title: t.title,
    status: t.status,
    url: t.url,
    locations: (t.locations || "").slice(0, locMax),
    contacts: (t.contacts || "").slice(0, locMax),
    snippet: (t.supportingSnippet || (t.eligibility || "")).slice(0, snip),
  }));

  const system = `You are Curalink, a careful medical research assistant. You MUST:
- Base every factual claim ONLY on the numbered SOURCES below (publications P1.. and trials T1..).
- If evidence is thin, say so plainly.
- Never invent citations, authors, years, or trial IDs.
- This is not personalized medical advice; include appropriate caution.
Output ONLY valid JSON with keys:
conditionOverview (string, 2-4 sentences),
researchInsights (string, rich paragraph(s) referencing P-numbers where used, e.g. (P2)),
clinicalTrialsSummary (string, paragraph(s) referencing T-numbers where used),
caveatsAndNextSteps (string, limitations + what a clinician might consider next),
usedPublicationNumbers (array of integers actually relied on),
usedTrialNumbers (array of integers actually relied on).
No markdown fences.`;

  const user = `User context:
Patient label: ${patientName || "not provided"}
Disease/condition focus: ${disease || "not specified"}
User intent / question: ${additionalQuery || ""}
Location: ${location || "not specified"}
Conversation summary: ${conversationSummary || "none"}

SOURCES — Publications:
${JSON.stringify(pubs, null, 2)}

SOURCES — Clinical trials:
${JSON.stringify(trs, null, 2)}

Return JSON now.`;

  const text = await ollamaChat({
    baseUrl: baseUrl || DEFAULT_OLLAMA,
    model,
    system,
    user,
    temperature: 0.25,
    timeoutMs: fast ? 90_000 : 180_000,
    fast,
  });
  const parsed = safeJsonParse(text);
  if (
    parsed &&
    typeof parsed.conditionOverview === "string" &&
    typeof parsed.researchInsights === "string"
  ) {
    return parsed;
  }
  return null;
}

export function fallbackSynthesis({ disease, additionalQuery, rankedPublications, rankedTrials }) {
  const intro = `Research-oriented overview for "${disease || "the stated topic"}" regarding "${additionalQuery || "your query"}". The passages below are synthesized from retrieved metadata only; verify on the linked pages.`;
  const pubBullets = rankedPublications
    .map(
      (p, i) =>
        `(P${i + 1}) ${p.title} (${p.year || "n.d."}) — ${p.platform}. ${(p.supportingSnippet || "").slice(0, 280)}`
    )
    .join("\n\n");
  const trialBullets = rankedTrials
    .map(
      (t, i) =>
        `(T${i + 1}) ${t.title} — status: ${t.status || "unknown"}. ${(t.supportingSnippet || "").slice(0, 240)}`
    )
    .join("\n\n");
  return {
    conditionOverview: intro,
    researchInsights: pubBullets || "No publication matches were retrieved for this query.",
    clinicalTrialsSummary: trialBullets || "No clinical trial matches were retrieved.",
    caveatsAndNextSteps:
      "Automated retrieval can miss relevant work or surface tangential items. Discuss findings with a qualified clinician before acting on them.",
    usedPublicationNumbers: rankedPublications.map((_, i) => i + 1),
    usedTrialNumbers: rankedTrials.map((_, i) => i + 1),
    _fallback: true,
  };
}
