const OPENALEX_BASE = "https://api.openalex.org";

function invertAbstract(inverted) {
  if (!inverted || typeof inverted !== "object") return "";
  const pairs = [];
  for (const [word, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) pairs.push([pos, word]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map(([, w]) => w).join(" ").trim();
}

function pickAuthors(work) {
  const authorships = work?.authorships;
  if (!Array.isArray(authorships)) return [];
  return authorships
    .map((a) => a?.author?.display_name)
    .filter(Boolean)
    .slice(0, 12);
}

function workUrl(work) {
  return (
    work?.primary_location?.landing_page_url ||
    work?.id ||
    work?.doi ||
    ""
  );
}

/**
 * Fetch a broad candidate pool from OpenAlex (depth-first).
 */
export async function fetchOpenAlexWorks(search, { perPage = 200 } = {}) {
  const params = new URLSearchParams({
    search,
    "per-page": String(Math.min(perPage, 200)),
    sort: "cited_by_count:desc",
  });
  const url = `${OPENALEX_BASE}/works?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAlex error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((work) => {
    const title = work?.display_name || work?.title || "Untitled";
    const abstract =
      typeof work?.abstract_inverted_index === "object"
        ? invertAbstract(work.abstract_inverted_index)
        : work?.abstract || "";
    const year =
      work?.publication_year ||
      (work?.publication_date ? Number(String(work.publication_date).slice(0, 4)) : null);
    return {
      platform: "OpenAlex",
      sourceId: work?.id || "",
      title,
      abstract,
      authors: pickAuthors(work),
      year,
      url: workUrl(work),
      hostVenue: work?.primary_location?.source?.display_name || "",
      citedByCount: work?.cited_by_count ?? 0,
      raw: work,
    };
  });
}
