import { fetchOpenAlexWorks } from "./openalex.js";
import { fetchPubMedWorks, enrichPubMedAbstracts } from "./pubmed.js";
import { fetchClinicalTrials } from "./clinicalTrials.js";
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

function buildAttributions(rankedPublications, rankedTrials, synthesis) {
  const pubNums = Array.isArray(synthesis?.usedPublicationNumbers)
    ? synthesis.usedPublicationNumbers
    : rankedPublications.map((_, i) => i + 1);
  const trialNums = Array.isArray(synthesis?.usedTrialNumbers) ? synthesis.usedTrialNumbers : rankedTrials.map((_, i) => i + 1);

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

  const rankedPublications = rankPublications(enriched, { queryText: queryForRank, topN: 8 });
  const rankedTrials = rankTrials(ct, { queryText: queryForRank, topN: 8 });

  console.log(
    "[curalink] ranked top pubs/trials; candidates",
    enriched.length,
    "/",
    ct.length,
    "— synthesis",
    fast ? "(fast)" : "(full)"
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

  const assistantMarkdown = [
    `## Condition overview`,
    synthesis.conditionOverview,
    ``,
    `## Research insights`,
    synthesis.researchInsights,
    ``,
    `## Clinical trials`,
    synthesis.clinicalTrialsSummary,
    ``,
    `## Caveats & next steps`,
    synthesis.caveatsAndNextSteps,
  ].join("\n");

  return {
    assistantText: assistantMarkdown,
    assistantPayload: {
      expansion,
      retrievalStats: {
        openAlexCandidates: oa.length,
        pubmedCandidates: pm.length,
        trialCandidates: ct.length,
        mergedPublicationCandidates: enriched.length,
      },
      structured: synthesis,
      sources: attributions,
      errors,
    },
    meta: {
      expandedQuery: expansion.expandedQuery,
      queryForRank,
    },
  };
}
