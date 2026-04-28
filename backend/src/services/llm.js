const DEFAULT_OLLAMA = "http://127.0.0.1:11434";

function ollamaBodyLooksLikeMemoryError(text) {
  const s = String(text || "").toLowerCase();
  return (
    s.includes("system memory") ||
    s.includes("more memory") ||
    s.includes("insufficient vram") ||
    s.includes("model requires") ||
    (s.includes("gib") && s.includes("available"))
  );
}

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
    options = { temperature, num_ctx: 2048, num_predict: 512 };
  } else {
    options = { temperature, num_ctx: 8192, num_predict: 1536 };
  }
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  const post = (opts) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model, stream: false, options: opts, messages }),
    });
  try {
    let res = await post(options);
    let raw = await res.text();
    if (
      !res.ok &&
      ollamaBodyLooksLikeMemoryError(raw) &&
      (options.num_ctx > 1024 || options.num_predict > 256)
    ) {
      const low =
        preset === "expand"
          ? { temperature, num_ctx: 1024, num_predict: 192 }
          : { temperature, num_ctx: 1024, num_predict: 256 };
      res = await post(low);
      raw = await res.text();
    }
    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${raw.slice(0, 240)}`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Ollama returned non-JSON (${raw.slice(0, 120)}…)`);
    }
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
Output ONLY valid JSON with exactly these keys:
conditionSummary (string, 2-4 sentences — plain-language overview of the condition/topic as connected to the user's question),
latestEvidence (string, paragraph(s) on recent or relevant publication findings; cite P-numbers where used, e.g. (P2)),
recommendedClinicalTrials (string, paragraph(s) on trials worth noting; cite T-numbers where used),
doctorDiscussionPoints (string, bullet-style or short paragraphs: limitations of evidence, uncertainties, and concrete talking points for a clinician),
references (string, a concise numbered bibliography of each P and T source you actually relied on — short title + year/status where applicable; URLs may repeat from SOURCES),
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
  if (!parsed) return null;

  const conditionSummary = parsed.conditionSummary ?? parsed.conditionOverview;
  const latestEvidence = parsed.latestEvidence ?? parsed.researchInsights;
  if (typeof conditionSummary !== "string" || typeof latestEvidence !== "string") return null;

  return {
    conditionSummary,
    latestEvidence,
    recommendedClinicalTrials:
      typeof parsed.recommendedClinicalTrials === "string"
        ? parsed.recommendedClinicalTrials
        : typeof parsed.clinicalTrialsSummary === "string"
          ? parsed.clinicalTrialsSummary
          : "",
    doctorDiscussionPoints:
      typeof parsed.doctorDiscussionPoints === "string"
        ? parsed.doctorDiscussionPoints
        : typeof parsed.caveatsAndNextSteps === "string"
          ? parsed.caveatsAndNextSteps
          : "",
    references: typeof parsed.references === "string" ? parsed.references : "",
    usedPublicationNumbers: parsed.usedPublicationNumbers,
    usedTrialNumbers: parsed.usedTrialNumbers,
  };
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
  const refLines = [
    ...rankedPublications.map(
      (p, i) =>
        `(P${i + 1}) ${p.title}${p.year ? ` (${p.year})` : ""}. ${p.url ? p.url : ""}`
    ),
    ...rankedTrials.map((t, i) => `(T${i + 1}) ${t.title}. Status: ${t.status || "unknown"}. ${t.url ? t.url : ""}`),
  ].join("\n\n");

  return {
    conditionSummary: intro,
    latestEvidence: pubBullets || "No publication matches were retrieved for this query.",
    recommendedClinicalTrials: trialBullets || "No clinical trial matches were retrieved.",
    doctorDiscussionPoints:
      "Automated retrieval can miss relevant work or surface tangential items. Discuss findings with a qualified clinician before acting on them.",
    references:
      refLines.trim() ||
      "No numbered sources were available; verify retrieval settings and try a broader query.",
    usedPublicationNumbers: rankedPublications.map((_, i) => i + 1),
    usedTrialNumbers: rankedTrials.map((_, i) => i + 1),
    _fallback: true,
  };
}
