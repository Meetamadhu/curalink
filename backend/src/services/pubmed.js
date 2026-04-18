const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

function buildHeaders(email, tool) {
  return {
    Accept: "application/json",
    "User-Agent": `${tool || "curalink"} (${email || "unknown@example.com"})`,
  };
}

async function esearch(term, { retmax = 200, email, tool } = {}) {
  const params = new URLSearchParams({
    db: "pubmed",
    term,
    retmax: String(retmax),
    retmode: "json",
    sort: "relevance",
    tool: tool || "curalink",
    email: email || "unknown@example.com",
  });
  const url = `${EUTILS}/esearch.fcgi?${params.toString()}`;
  const res = await fetch(url, { headers: buildHeaders(email, tool) });
  if (!res.ok) throw new Error(`PubMed esearch ${res.status}`);
  const data = await res.json();
  const idList = data?.esearchresult?.idlist;
  return Array.isArray(idList) ? idList : [];
}

async function esummary(ids, { email, tool } = {}) {
  if (!ids.length) return {};
  const params = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "json",
    tool: tool || "curalink",
    email: email || "unknown@example.com",
  });
  const url = `${EUTILS}/esummary.fcgi?${params.toString()}`;
  const res = await fetch(url, { headers: buildHeaders(email, tool) });
  if (!res.ok) throw new Error(`PubMed esummary ${res.status}`);
  const data = await res.json();
  return data?.result || {};
}

function authorsFromSummary(doc) {
  const authors = doc?.authors;
  if (!Array.isArray(authors)) return [];
  return authors.map((a) => a?.name).filter(Boolean).slice(0, 12);
}

/**
 * Fetch a broad candidate pool from PubMed (batched esummary).
 */
export async function fetchPubMedWorks(term, { retmax = 200, email, tool } = {}) {
  const ids = await esearch(term, { retmax, email, tool });
  if (!ids.length) return [];
  const batchSize = 200;
  const batches = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    batches.push(ids.slice(i, i + batchSize));
  }
  const merged = {};
  for (const batch of batches) {
    const chunk = await esummary(batch, { email, tool });
    Object.assign(merged, chunk);
  }
  const out = [];
  for (const uid of ids) {
    const doc = merged[uid];
    if (!doc || uid === "uids") continue;
    const title = doc?.title || "Untitled";
    const abstract =
      typeof doc?.abstract === "string"
        ? doc.abstract
        : Array.isArray(doc?.abstract)
          ? doc.abstract.map((x) => x?.value || x?.text || "").join(" ")
          : "";
    const pubdate = doc?.pubdate || doc?.sortpubdate || "";
    const year = pubdate ? Number(String(pubdate).slice(0, 4)) : null;
    const url = `https://pubmed.ncbi.nlm.nih.gov/${uid}/`;
    out.push({
      platform: "PubMed",
      sourceId: `pubmed:${uid}`,
      pmid: uid,
      title,
      abstract: abstract || "",
      authors: authorsFromSummary(doc),
      year: Number.isFinite(year) ? year : null,
      url,
      journal: doc?.fulljournalname || doc?.source || "",
      raw: doc,
    });
  }
  return out;
}

/**
 * PubMed esummary often omits abstract; enrich top candidates via efetch (XML-lite parse).
 */
export async function enrichPubMedAbstracts(records, { max = 80, email, tool } = {}) {
  const need = records
    .filter((r) => r.platform === "PubMed" && (!r.abstract || r.abstract.length < 40))
    .slice(0, max)
    .map((r) => r.pmid)
    .filter(Boolean);
  if (!need.length) return records;
  const params = new URLSearchParams({
    db: "pubmed",
    id: need.join(","),
    retmode: "xml",
    rettype: "abstract",
    tool: tool || "curalink",
    email: email || "unknown@example.com",
  });
  const url = `${EUTILS}/efetch.fcgi?${params.toString()}`;
  const res = await fetch(url, { headers: buildHeaders(email, tool) });
  if (!res.ok) return records;
  const xml = await res.text();
  const byPmid = new Map();
  const articles = xml.split(/<PubmedArticle>/i).slice(1);
  for (const block of articles) {
    const pm =
      block.match(/<PMID[^>]*>(\d+)<\/PMID>/i)?.[1] ||
      block.match(/<ArticleId IdType="pubmed">(\d+)<\/ArticleId>/i)?.[1];
    if (!pm) continue;
    const abs =
      block.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/i)?.[1] ||
      block.match(/<AbstractText>([\s\S]*?)<\/AbstractText>/i)?.[1] ||
      "";
    const cleaned = abs.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned) byPmid.set(pm, cleaned);
  }
  return records.map((r) => {
    if (r.platform !== "PubMed" || !r.pmid) return r;
    const a = byPmid.get(String(r.pmid));
    if (!a) return r;
    return { ...r, abstract: r.abstract && r.abstract.length > a.length ? r.abstract : a };
  });
}
