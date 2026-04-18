const CT_BASE = "https://clinicaltrials.gov/api/v2/studies";

function firstStr(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function extractContacts(protocol) {
  const central = protocol?.contactsLocationsModule?.centralContacts || [];
  const overall = protocol?.contactsLocationsModule?.overallOfficials || [];
  const lines = [];
  for (const c of [...central, ...overall].slice(0, 4)) {
    const name = firstStr(c?.name);
    const phone = firstStr(c?.phone, c?.phoneExt);
    const email = firstStr(c?.email);
    const role = firstStr(c?.role);
    if (name || phone || email) {
      lines.push([name, role, phone, email].filter(Boolean).join(" · "));
    }
  }
  return lines.join("\n");
}

function extractLocations(protocol) {
  const locs = protocol?.contactsLocationsModule?.locations || [];
  if (!Array.isArray(locs)) return "";
  const parts = locs
    .slice(0, 12)
    .map((l) => {
      const facility = firstStr(l?.facility);
      const city = firstStr(l?.city);
      const state = firstStr(l?.state);
      const country = firstStr(l?.country);
      const geo = [city, state, country].filter(Boolean).join(", ");
      return [facility, geo].filter(Boolean).join(" — ");
    })
    .filter(Boolean);
  return parts.join("\n");
}

function eligibilityText(protocol) {
  const el = protocol?.eligibilityModule;
  const crit = firstStr(el?.eligibilityCriteria);
  const healthy = el?.healthyVolunteers;
  const sex = firstStr(el?.sex);
  const min = el?.minimumAge;
  const max = el?.maximumAge;
  const head = [sex && `Sex: ${sex}`, min && `Min age: ${min}`, max && `Max age: ${max}`, healthy != null && `Healthy volunteers: ${healthy}`]
    .filter(Boolean)
    .join(" | ");
  return [head, crit].filter(Boolean).join("\n\n");
}

function mapStudies(studies) {
  return studies.map((s) => {
    const protocol = s?.protocolSection || {};
    const idm = protocol?.identificationModule || {};
    const status = protocol?.statusModule?.overallStatus || "";
    const nct = firstStr(idm?.nctId);
    const title = firstStr(idm?.briefTitle, idm?.officialTitle, "Untitled trial");
    const urlTrial = nct ? `https://clinicaltrials.gov/study/${nct}` : "";
    return {
      platform: "ClinicalTrials.gov",
      sourceId: nct || "",
      title,
      status,
      eligibility: eligibilityText(protocol),
      locations: extractLocations(protocol),
      contacts: extractContacts(protocol),
      url: urlTrial,
      raw: s,
    };
  });
}

/**
 * Broad retrieval from ClinicalTrials.gov v2 API with shallow pagination for depth.
 */
export async function fetchClinicalTrials({
  disease,
  intent,
  location,
  pageSize = 100,
  maxStudies = 220,
} = {}) {
  const studies = [];
  let pageToken = "";
  const page = Math.min(pageSize, 500);

  while (studies.length < maxStudies) {
    const params = new URLSearchParams({
      format: "json",
      pageSize: String(page),
      sort: "LastUpdatePostDate:desc",
    });
    const cond = firstStr(disease);
    const term = firstStr(intent, disease);
    if (cond) params.set("query.cond", cond);
    if (term) params.set("query.term", term);
    const loc = firstStr(location);
    if (loc) params.set("query.locn", loc);
    if (pageToken) params.set("pageToken", pageToken);

    const url = `${CT_BASE}?${params.toString()}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`ClinicalTrials.gov error ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const batch = Array.isArray(data?.studies) ? data.studies : [];
    studies.push(...batch);
    pageToken = data?.nextPageToken || data?.pageToken || "";
    if (!pageToken || batch.length === 0) break;
  }

  return mapStudies(studies);
}
