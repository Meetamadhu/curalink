import { fetchOpenAlexWorks } from "./openalex.js";
import { fetchPubMedWorks, enrichPubMedAbstracts } from "./pubmed.js";
import { fetchClinicalTrials } from "./clinicalTrials.js";
import { semanticOptionsFromEnv } from "./embeddings.js";
import { rankPublications, rankTrials } from "./ranking.js";
import { deterministicExpansion, buildConversationSummary } from "./queryContext.js";
import { expandQueryWithLlm, synthesizeAnswerWithLlm, fallbackSynthesis } from "./llm.js";

/** Fast retrieval + skip expansion LLM unless CURALINK_FAST_MODE is 0/false/full */
function fastModeFromEnv() {
  const s = String(process.env.CURALINK_FAST_MODE ?? "1").trim().toLowerCase();
  if (s === "0" || s === "false" || s === "full" || s === "off") return false;
  return true;
}

function mergeExpansion(det, llm) {
  if (!llm) return det;
  return {
    expandedQuery: llm.expandedQuery || det.expandedQuery,
    pubmedTerm: llm.pubmedTerm || det.pubmedTerm,
    openAlexPhrase: llm.openAlexPhrase || det.openAlexPhrase,
    trialCondition: llm.trialCondition || det.trialCondition,
    trialOtherTerms: llm.trialOtherTerms ?? det.trialOtherTerms,
    trialLocation: det.trialLocation,
    rationale: llm.rationale || det.rationale,
    _llmExpanded: true,
  };
}

/** Provenance / curation signal for investor-facing source cards. */
function trustMetaForSource(platform, kind) {
  const s = String(platform || "").toLowerCase();
  if (kind === "trial") {
    if (s.includes("clinical"))
      return { trustTier: "registry", trustLabel: "Official registry", trustClass: "trust--registry" };
    return { trustTier: "listing", trustLabel: "Trial listing", trustClass: "trust--listing" };
  }
  if (s.includes("pubmed"))
    return { trustTier: "indexed", trustLabel: "Indexed literature", trustClass: "trust--indexed" };
  if (s.includes("openalex"))
    return { trustTier: "graph", trustLabel: "Open bibliographic graph", trustClass: "trust--graph" };
  return { trustTier: "external", trustLabel: "External source", trustClass: "trust--external" };
}

/** Rank-based retrieval fit within each list (publications vs trials). */
function evidenceFitMeta(rankIndex, listLength) {
  const n = Math.max(listLength, 1);
  const strongCap = Math.max(1, Math.ceil(n * 0.375));
  const modCap = Math.max(strongCap + 1, Math.ceil(n * 0.75));
  if (rankIndex <= strongCap)
    return { evidenceStrength: "strong", evidenceLabel: "Strong fit", evidenceClass: "evidence--strong" };
  if (rankIndex <= modCap)
    return { evidenceStrength: "moderate", evidenceLabel: "Moderate fit", evidenceClass: "evidence--moderate" };
  return { evidenceStrength: "emerging", evidenceLabel: "Exploratory fit", evidenceClass: "evidence--emerging" };
}

function computeQualitySignals(synthesis, attributions, retrievalStats) {
  const pubs = attributions.publications || [];
  const trials = attributions.trials || [];
  const usedP = Array.isArray(synthesis?.usedPublicationNumbers) ? synthesis.usedPublicationNumbers : null;
  const usedT = Array.isArray(synthesis?.usedTrialNumbers) ? synthesis.usedTrialNumbers : null;

  const scoresFor = (items, used) => {
    const use = used && used.length > 0 ? new Set(used.map(Number)) : null;
    return items
      .filter((it) => use == null || use.has(Number(it.index)))
      .map((it) => Number(it.relevanceScore) || 0);
  };

  let citedScores = [...scoresFor(pubs, usedP), ...scoresFor(trials, usedT)];
  if (citedScores.length === 0) {
    citedScores = [
      ...pubs.slice(0, 4).map((p) => Number(p.relevanceScore) || 0),
      ...trials.slice(0, 4).map((t) => Number(t.relevanceScore) || 0),
    ];
  }

  const allScores = [...pubs, ...trials].map((x) => Number(x.relevanceScore) || 0);
  const maxS = allScores.length ? Math.max(...allScores, 0.001) : 1;
  const minS = allScores.length ? Math.min(...allScores) : 0;
  const span = Math.max(maxS - minS, 0.001);
  const mean = citedScores.length ? citedScores.reduce((a, b) => a + b, 0) / citedScores.length : (minS + maxS) / 2;
  const normalized = (mean - minS) / span;
  const retrievalAlignment = Math.min(96, Math.max(34, Math.round(36 + normalized * 58)));

  let evidenceStrengthSummary = "Moderate";
  if (retrievalAlignment >= 78) evidenceStrengthSummary = "High";
  else if (retrievalAlignment < 55) evidenceStrengthSummary = "Emerging";

  const merged = retrievalStats?.mergedPublicationCandidates ?? 0;
  const trialC = retrievalStats?.trialCandidates ?? 0;
  const poolBreadth = Math.min(100, Math.round(28 + Math.log1p(merged + trialC) * 10));

  const citedSourceSlots =
    (usedP && usedP.length > 0) || (usedT && usedT.length > 0)
      ? (usedP?.length || 0) + (usedT?.length || 0)
      : pubs.length + trials.length;

  return {
    retrievalAlignment,
    poolBreadth,
    citedSourceSlots,
    evidenceStrengthSummary,
    disclaimer:
      "Scores reflect retrieval rank and synthesis coverage — not diagnostic certainty or regulatory endorsement.",
  };
}

function buildAttributions(rankedPublications, rankedTrials, synthesis) {
  const pubNums = Array.isArray(synthesis?.usedPublicationNumbers)
    ? synthesis.usedPublicationNumbers
    : rankedPublications.map((_, i) => i + 1);
  const trialNums = Array.isArray(synthesis?.usedTrialNumbers) ? synthesis.usedTrialNumbers : rankedTrials.map((_, i) => i + 1);

  const pubN = rankedPublications.length;
  const trialN = rankedTrials.length;

  const publications = rankedPublications.map((p, idx) => ({
    index: idx + 1,
    label: `P${idx + 1}`,
    title: p.title,
    authors: p.authors || [],
    year: p.year,
    platform: p.platform,
    url: p.url,
    snippet: p.supportingSnippet || (p.abstract || "").slice(0, 400),
    relevanceScore: p.relevanceScore,
    ...(p.semanticSimilarity != null ? { semanticSimilarity: p.semanticSimilarity } : {}),
    ...trustMetaForSource(p.platform, "pub"),
    ...evidenceFitMeta(idx + 1, pubN),
  }));

  const trials = rankedTrials.map((t, idx) => ({
    index: idx + 1,
    label: `T${idx + 1}`,
    title: t.title,
    status: t.status,
    eligibility: (t.eligibility || "").slice(0, 1200),
    locations: t.locations || "",
    contacts: t.contacts || "",
    platform: t.platform,
    url: t.url,
    snippet: t.supportingSnippet || "",
    relevanceScore: t.relevanceScore,
    ...(t.semanticSimilarity != null ? { semanticSimilarity: t.semanticSimilarity } : {}),
    ...trustMetaForSource(t.platform, "trial"),
    ...evidenceFitMeta(idx + 1, trialN),
  }));

  return {
    publications,
    trials,
    emphasis: {
      publicationIndexes: pubNums,
      trialIndexes: trialNums,
    },
  };
}

/**
 * End-to-end retrieval + ranking + optional open-source LLM synthesis.
 */
export async function runResearchPipeline(
  {
    message,
    structured = {},
    priorMessages = [],
    env,
  },
  options = {}
) {
  const fast = options.fast ?? fastModeFromEnv();
  const disease = structured.disease || "";
  const additionalQuery = structured.additionalQuery || message || "";
  const location = structured.location || "";
  const patientName = structured.patientName || "";

  const conversationSummary = buildConversationSummary(priorMessages);
  const det = deterministicExpansion({ disease, additionalQuery, location });

  let expansion = det;
  const skipExpand = options.skipLlmExpansion || fast;
  if (skipExpand) {
    expansion = det;
    if (fast) console.log("[curalink] fast mode: skipping LLM query expansion");
  } else {
    try {
      console.log("[curalink] LLM query expansion…");
      const llmExp = await expandQueryWithLlm(
        { disease, additionalQuery, location, conversationSummary },
        { baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_MODEL }
      );
      expansion = mergeExpansion(det, llmExp);
    } catch (e) {
      console.warn("[curalink] query expansion failed, using deterministic merge:", e?.message || e);
      expansion = det;
    }
  }

  const queryForRank = [expansion.expandedQuery, disease, additionalQuery].filter(Boolean).join(" ");

  const oaPer = fast ? 100 : 200;
  const pmMax = fast ? 80 : 200;
  const ctMax = fast ? 100 : 220;
  const ctPage = fast ? 50 : 100;
  const enrichMax = fast ? 35 : 100;

  console.log("[curalink] retrieving OpenAlex / PubMed / ClinicalTrials.gov…");
  const [oaRes, pmRes, ctRes] = await Promise.allSettled([
    fetchOpenAlexWorks(expansion.openAlexPhrase || expansion.expandedQuery, { perPage: oaPer }),
    fetchPubMedWorks(expansion.pubmedTerm || expansion.expandedQuery, {
      retmax: pmMax,
      email: env.PUBMED_EMAIL,
      tool: env.PUBMED_TOOL,
    }),
    fetchClinicalTrials({
      disease: expansion.trialCondition || disease,
      intent: expansion.trialOtherTerms || additionalQuery,
      location: expansion.trialLocation || location,
      pageSize: ctPage,
      maxStudies: ctMax,
    }),
  ]);

  const oa = oaRes.status === "fulfilled" ? oaRes.value : [];
  const pm = pmRes.status === "fulfilled" ? pmRes.value : [];
  const ct = ctRes.status === "fulfilled" ? ctRes.value : [];

  const errors = [];
  if (oaRes.status === "rejected") errors.push({ source: "OpenAlex", message: String(oaRes.reason?.message || oaRes.reason) });
  if (pmRes.status === "rejected") errors.push({ source: "PubMed", message: String(pmRes.reason?.message || pmRes.reason) });
  if (ctRes.status === "rejected") errors.push({ source: "ClinicalTrials.gov", message: String(ctRes.reason?.message || ctRes.reason) });

  const mergedPubs = [...pm, ...oa];
  const enriched = await enrichPubMedAbstracts(mergedPubs, {
    max: enrichMax,
    email: env.PUBMED_EMAIL,
    tool: env.PUBMED_TOOL,
  }).catch(() => mergedPubs);

  const semanticOpts = semanticOptionsFromEnv(process.env, { fast });
  const rankedPublications = await rankPublications(enriched, {
    queryText: queryForRank,
    topN: 8,
    semantic: semanticOpts,
  });
  const rankedTrials = await rankTrials(ct, {
    queryText: queryForRank,
    topN: 8,
    semantic: semanticOpts,
  });

  console.log(
    "[curalink] ranked top pubs/trials; candidates",
    enriched.length,
    "/",
    ct.length,
    "— synthesis",
    fast ? "(fast)" : "(full)",
    semanticOpts ? `; semantic=${semanticOpts.preset} (${semanticOpts.modelId})` : "; semantic=off"
  );

  let synthesis = null;
  if (!options.skipLlmSynthesis) {
    try {
      console.log("[curalink] Ollama synthesis…");
      synthesis = await synthesizeAnswerWithLlm(
        {
          disease,
          additionalQuery: additionalQuery || message,
          location,
          patientName,
          rankedPublications,
          rankedTrials,
          conversationSummary,
        },
        { baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_MODEL, fast }
      );
    } catch (e) {
      console.warn("[curalink] synthesis failed, using fallback:", e?.message || e);
      synthesis = null;
    }
  }
  if (!synthesis) {
    synthesis = fallbackSynthesis({ disease, additionalQuery: additionalQuery || message, rankedPublications, rankedTrials });
  }

  const attributions = buildAttributions(rankedPublications, rankedTrials, synthesis);
  const retrievalStats = {
    openAlexCandidates: oa.length,
    pubmedCandidates: pm.length,
    trialCandidates: ct.length,
    mergedPublicationCandidates: enriched.length,
  };
  const qualitySignals = computeQualitySignals(synthesis, attributions, retrievalStats);

  const assistantMarkdown = [
    `## Condition Summary`,
    synthesis.conditionSummary,
    ``,
    `## Latest Evidence`,
    synthesis.latestEvidence,
    ``,
    `## Recommended Clinical Trials`,
    synthesis.recommendedClinicalTrials,
    ``,
    `## Doctor Discussion Points`,
    synthesis.doctorDiscussionPoints,
    ``,
    `## References`,
    synthesis.references,
  ].join("\n");

  return {
    assistantText: assistantMarkdown,
    assistantPayload: {
      expansion,
      retrievalStats,
      qualitySignals,
      structured: synthesis,
      sources: attributions,
      errors,
    },
    meta: {
      expandedQuery: expansion.expandedQuery,
      queryForRank,
      embedding: semanticOpts
        ? {
            enabled: true,
            preset: semanticOpts.preset,
            modelId: semanticOpts.modelId,
            label: semanticOpts.label,
            semanticWeight: semanticOpts.semanticWeight,
            poolSize: semanticOpts.poolSize,
          }
        : { enabled: false },
    },
  };
}
