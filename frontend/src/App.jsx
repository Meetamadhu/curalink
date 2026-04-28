import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { postChat } from "./api.js";

const initialForm = {
  patientName: "",
  disease: "",
  additionalQuery: "",
  location: "",
};

const RESEARCH_PHASES = [
  { title: "Retrieving", detail: "OpenAlex, PubMed, and ClinicalTrials.gov" },
  { title: "Ranking", detail: "Deduplicating and scoring candidate matches" },
  { title: "Synthesizing", detail: "Local model producing structured sections" },
  { title: "Finalizing", detail: "Binding sources, trust tiers, and alignment scores" },
];

function ResearchProgress({ active }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active) {
      setPhase(0);
      return;
    }
    setPhase(0);
    const id = setInterval(() => {
      setPhase((p) => Math.min(p + 1, RESEARCH_PHASES.length - 1));
    }, 2400);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return null;
  const cur = RESEARCH_PHASES[phase];
  return (
    <div className="research-progress" role="status" aria-live="polite" aria-busy="true">
      <div className="research-progress__bar-wrap" aria-hidden="true">
        <div className="research-progress__bar" />
      </div>
      <div className="research-progress__body">
        <div className="research-progress__phase">{cur.title}</div>
        <p className="research-progress__detail">{cur.detail}</p>
        <ol className="research-progress__steps">
          {RESEARCH_PHASES.map((s, i) => (
            <li
              key={s.title}
              className={i < phase ? "is-done" : i === phase ? "is-active" : "is-pending"}
            >
              <span className="research-progress__step-dot" aria-hidden="true" />
              <span>{s.title}</span>
            </li>
          ))}
        </ol>
        <p className="research-progress__hint subtle">
          Full runs often take <strong>1–5 minutes</strong> on CPU; the thread updates when the answer is ready.
        </p>
      </div>
    </div>
  );
}

function EvidenceQualityStrip({ quality, retrievalStats }) {
  if (!quality) return null;
  const ra = quality.retrievalAlignment;
  const pb = quality.poolBreadth;
  const summary = quality.evidenceStrengthSummary;
  const summaryClass =
    summary === "High" ? "quality-chip--high" : summary === "Emerging" ? "quality-chip--low" : "quality-chip--mid";
  return (
    <div className="quality-strip">
      <div className="quality-strip__row">
        <div className="quality-metric">
          <div className="quality-metric__head">
            <span className="quality-metric__label">Alignment confidence</span>
            <span className="quality-metric__value mono">{ra}</span>
          </div>
          <div className="quality-metric__track" aria-hidden="true">
            <div className="quality-metric__fill" style={{ width: `${ra}%` }} />
          </div>
        </div>
        <div className="quality-metric">
          <div className="quality-metric__head">
            <span className="quality-metric__label">Pool depth index</span>
            <span className="quality-metric__value mono">{pb}</span>
          </div>
          <div className="quality-metric__track" aria-hidden="true">
            <div className="quality-metric__fill quality-metric__fill--alt" style={{ width: `${pb}%` }} />
          </div>
        </div>
        <div className={`quality-chip ${summaryClass}`} title="Summary of how tightly retrieved items match the query">
          <span className="quality-chip__k">Evidence</span>
          <span className="quality-chip__v">{summary}</span>
        </div>
      </div>
      <p className="quality-strip__note subtle">{quality.disclaimer}</p>
      {retrievalStats && (
        <p className="quality-strip__stats mono subtle">
          Candidates — OA {retrievalStats.openAlexCandidates} · PM {retrievalStats.pubmedCandidates} · trials{" "}
          {retrievalStats.trialCandidates} · merged pubs {retrievalStats.mergedPublicationCandidates}
        </p>
      )}
    </div>
  );
}

function trustDisplay(item, kind) {
  if (item.trustLabel)
    return { label: item.trustLabel, className: item.trustClass || "trust--external" };
  const s = String(item.platform || "").toLowerCase();
  if (kind === "trial")
    return s.includes("clinical")
      ? { label: "Official registry", className: "trust--registry" }
      : { label: "Trial listing", className: "trust--listing" };
  if (s.includes("pubmed")) return { label: "Indexed literature", className: "trust--indexed" };
  if (s.includes("openalex")) return { label: "Open bibliographic graph", className: "trust--graph" };
  return { label: "External source", className: "trust--external" };
}

function evidenceDisplay(item, listLength) {
  if (item.evidenceLabel)
    return { label: item.evidenceLabel, className: item.evidenceClass || "evidence--moderate" };
  const n = Math.max(listLength, 1);
  const idx = Number(item.index) || 1;
  const strongCap = Math.max(1, Math.ceil(n * 0.375));
  const modCap = Math.max(strongCap + 1, Math.ceil(n * 0.75));
  if (idx <= strongCap) return { label: "Strong fit", className: "evidence--strong" };
  if (idx <= modCap) return { label: "Moderate fit", className: "evidence--moderate" };
  return { label: "Exploratory fit", className: "evidence--emerging" };
}

function SourceCard({ item, kind, listLength }) {
  const trust = trustDisplay(item, kind);
  const ev = evidenceDisplay(item, listLength ?? 8);
  return (
    <article className={`source-card source-card--${kind}`}>
      <div className="source-card__meta">
        <span className="pill">{item.platform}</span>
        {item.label && <span className="pill pill--muted">{item.label}</span>}
        <span className={`pill pill--trust ${trust.className}`} title="Provenance / curation signal">
          {trust.label}
        </span>
        <span className={`pill pill--evidence ${ev.className}`} title="Retrieval rank fit within this list">
          {ev.label}
        </span>
        {item.relevanceScore != null && (
          <span className="pill pill--muted" title="Composite retrieval score from the ranker">
            Rank {item.relevanceScore}
          </span>
        )}
        {item.year != null && kind === "pub" && <span className="pill pill--muted">{item.year}</span>}
        {item.status && kind === "trial" && <span className="pill pill--accent">{item.status}</span>}
      </div>
      <h4 className="source-card__title">
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer">
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </h4>
      {kind === "pub" && item.authors?.length > 0 && (
        <p className="source-card__authors">{item.authors.join(", ")}</p>
      )}
      {item.snippet && <p className="source-card__snippet">{item.snippet}</p>}
      {kind === "trial" && item.locations && (
        <p className="source-card__sub">
          <strong>Locations</strong>: {item.locations}
        </p>
      )}
      {kind === "trial" && item.contacts && (
        <p className="source-card__sub">
          <strong>Contacts</strong>: {item.contacts}
        </p>
      )}
    </article>
  );
}

function SafetyBoundariesContent({ titleId }) {
  return (
    <>
      <h3 id={titleId}>Safety & Clinical Boundaries</h3>
      <p className="safety-panel__lead">
        This system is designed as a <strong>Medical Research Assistant</strong>
        {" — "}not a diagnosis engine.
      </p>
      <p className="safety-panel__label subtle">Responses are:</p>
      <ul className="safety-panel__list safety-panel__list--emphasis">
        <li>research-backed</li>
        <li>source-attributed</li>
        <li>evidence-focused</li>
      </ul>
      <p className="safety-panel__label subtle">but intentionally avoid:</p>
      <ul className="safety-panel__list safety-panel__list--caution">
        <li>direct prescriptions</li>
        <li>diagnosis claims</li>
        <li>treatment decisions</li>
      </ul>
      <p className="safety-panel__footer subtle">
        The assistant is positioned as a health research companion to support doctor-patient discussions, not replace
        professional medical advice.
      </p>
    </>
  );
}

export default function App() {
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const threadRef = useRef(null);

  const hasContext = useMemo(() => Boolean(form.disease || form.location || form.patientName), [form]);

  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 960px)");
    const onViewportChange = () => {
      if (!mq.matches) setMobileNavOpen(false);
    };
    mq.addEventListener("change", onViewportChange);
    return () => mq.removeEventListener("change", onViewportChange);
  }, []);

  const lastRunStats = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === "assistant" && m.payload?.retrievalStats) {
        return {
          retrievalStats: m.payload.retrievalStats,
          meta: m.meta,
          sources: m.payload.sources,
          errors: m.payload.errors,
        };
      }
    }
    return null;
  }, [messages]);

  async function send(overrideText) {
    const text = (overrideText ?? input).trim();
    if (!text && !form.disease && !form.additionalQuery) {
      setError("Add a message or fill disease / research focus.");
      return;
    }
    setError("");
    setLoading(true);
    const userContent = text || form.additionalQuery || form.disease || "Research request";
    setMessages((m) => [...m, { role: "user", content: userContent, local: true }]);
    setInput("");
    try {
      const structured =
        form.patientName || form.disease || form.additionalQuery || form.location
          ? {
              patientName: form.patientName || undefined,
              disease: form.disease || undefined,
              additionalQuery: form.additionalQuery || undefined,
              location: form.location || undefined,
            }
          : undefined;
      const data = await postChat({
        conversationId,
        message: text,
        structured,
      });
      setConversationId(data.conversationId);
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last?.local) copy[copy.length - 1] = { role: "user", content: last.content };
        copy.push({ role: "assistant", content: data.reply, payload: data.payload, meta: data.meta });
        return copy;
      });
    } catch (e) {
      setMessages((m) => m.filter((x, i) => !(x.local && i === m.length - 1)));
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  function startNewConversation() {
    setConversationId(null);
    setMessages([]);
    setError("");
  }

  function scrollPageToTop() {
    window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    threadRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="layout" id="page-top">
      <div className="layout__sidebar-lower">
      <aside className="sidebar sidebar--top" aria-label="About Curalink">
        <div className="brand">
          <div className="brand__logo" aria-hidden />
          <div>
            <div className="brand__name">Curalink</div>
            <div className="brand__tag">Research + reasoning</div>
          </div>
        </div>
      </aside>

      <aside className="sidebar layout__sidebar-session" aria-label="Session context">
        <div className="panel" id="session-context">
          <h3>Session context</h3>
          <label className="field">
            <span>Patient name (optional)</span>
            <input
              value={form.patientName}
              onChange={(e) => setForm({ ...form, patientName: e.target.value })}
              placeholder="e.g. John Smith"
            />
          </label>
          <label className="field">
            <span>Disease / condition</span>
            <input
              value={form.disease}
              onChange={(e) => setForm({ ...form, disease: e.target.value })}
              placeholder="e.g. Parkinson disease"
            />
          </label>
          <label className="field">
            <span>Research focus / intent</span>
            <input
              value={form.additionalQuery}
              onChange={(e) => setForm({ ...form, additionalQuery: e.target.value })}
              placeholder="e.g. Deep brain stimulation"
            />
          </label>
          <label className="field">
            <span>Location (trials)</span>
            <input
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              placeholder="e.g. Toronto, Canada"
            />
          </label>
          <div className="panel__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setForm(initialForm)} disabled={loading}>
              Clear fields
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const combined = [form.disease, form.additionalQuery]
                  .map((s) => String(s || "").trim())
                  .filter(Boolean)
                  .join(" · ");
                send(combined || input.trim() || undefined);
              }}
              disabled={loading}
            >
              Run with context
            </button>
          </div>
        </div>
      </aside>

      <aside className="sidebar layout__sidebar-quick" aria-label="Quick prompts">
        <div className="panel panel--compact" id="quick-prompts">
          <h3>Quick prompts</h3>
          <div className="chips">
            {[
              "Latest treatment for lung cancer",
              "Clinical trials for diabetes",
              "Top researchers in Alzheimer disease",
              "Recent studies on heart disease",
            ].map((q) => (
              <button key={q} type="button" className="chip" onClick={() => send(q)} disabled={loading}>
                {q}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <aside
        className="sidebar layout__sidebar-stats"
        aria-label="Retrieval stats"
        aria-live="polite"
        id="retrieval-stats"
      >
        <div className="panel panel--compact sidebar-stats">
          <h3>Retrieval stats</h3>
          {loading && !lastRunStats && <p className="sidebar-stats__empty subtle">Waiting for the latest run…</p>}
          {!loading && !lastRunStats && (
            <p className="sidebar-stats__empty subtle">
              Candidate counts from OpenAlex, PubMed, and ClinicalTrials.gov appear here after your first answer in
              this session.
            </p>
          )}
          {loading && lastRunStats && <p className="sidebar-stats__hint subtle">Refreshing after your latest message…</p>}

          {lastRunStats && (
            <>
              <ul className="sidebar-stats__list">
                <li className="sidebar-stat">
                  <span className="sidebar-stat__label">OpenAlex</span>
                  <span className="sidebar-stat__value mono">{lastRunStats.retrievalStats.openAlexCandidates}</span>
                </li>
                <li className="sidebar-stat">
                  <span className="sidebar-stat__label">PubMed</span>
                  <span className="sidebar-stat__value mono">{lastRunStats.retrievalStats.pubmedCandidates}</span>
                </li>
                <li className="sidebar-stat">
                  <span className="sidebar-stat__label">Trials (CT.gov)</span>
                  <span className="sidebar-stat__value mono">{lastRunStats.retrievalStats.trialCandidates}</span>
                </li>
                <li className="sidebar-stat">
                  <span className="sidebar-stat__label">Merged publications</span>
                  <span className="sidebar-stat__value mono">
                    {lastRunStats.retrievalStats.mergedPublicationCandidates}
                  </span>
                </li>
                <li className="sidebar-stat">
                  <span className="sidebar-stat__label">Ranked in answer</span>
                  <span className="sidebar-stat__value mono">
                    P{lastRunStats.sources?.publications?.length ?? 0} · T{lastRunStats.sources?.trials?.length ?? 0}
                  </span>
                </li>
              </ul>
              {lastRunStats.meta?.expandedQuery && (
                <p className="sidebar-stats__expanded mono subtle">
                  <span className="sidebar-stats__expanded-label">Expanded query</span>
                  {lastRunStats.meta.expandedQuery}
                </p>
              )}
              {lastRunStats.errors?.length > 0 && (
                <p className="sidebar-stats__warn" role="status">
                  Partial retrieval:{" "}
                  {lastRunStats.errors.map((e) => `${e.source}: ${e.message}`).join(" · ")}
                </p>
              )}
            </>
          )}
        </div>
      </aside>
      </div>

      <header className="main__header">
        <div className="main__header-intro">
          <div className="main__header-title-row">
            <h1 className="main__header-welcome">
              Welcome — I am your AI{" "}
              <span className="main__header-welcome__role">Medical Research Assistant</span>.
            </h1>
            <button
              type="button"
              className="mobile-nav-toggle"
              aria-label={mobileNavOpen ? "Close section menu" : "Open section menu"}
              aria-expanded={mobileNavOpen}
              aria-controls="mobile-nav-panel"
              onClick={() => setMobileNavOpen((o) => !o)}
            >
              <span className="mobile-nav-toggle__bars" aria-hidden>
                <span />
                <span />
                <span />
              </span>
            </button>
          </div>
        </div>
        <button type="button" className="btn btn--ghost btn--new-thread" onClick={startNewConversation} disabled={loading}>
          New conversation
        </button>
      </header>

      <main className="main">
        {error && <div className="banner banner--error">{error}</div>}
        <ResearchProgress active={loading} />

        <section ref={threadRef} className="thread" aria-live="polite" id="thread">
          {messages.length === 0 && (
            <>
              <div className="empty">
                <h2 className="empty__title">Start a research conversation</h2>
                <p className="empty__context subtle">
                  <a
                    href="#session-context"
                    className="empty__context-link"
                    title="Jump to Session context in the sidebar"
                  >
                    Structured context
                  </a>{" "}
                  improves retrieval. Follow-up questions reuse your last disease focus automatically. Use{" "}
                  <a
                    href="#quick-prompts"
                    className="empty__context-link"
                    title="Jump to Quick prompts in the sidebar"
                  >
                    Quick prompts
                  </a>{" "}
                  for one-tap example questions. Type your own message in the{" "}
                  <a href="#query-field" className="empty__context-link" title="Jump to the query text box">
                    query field
                  </a>
                  .
                </p>
                <p className="empty__body">
                  Ask in natural language, optionally set disease and location on the left. The backend pulls a{" "}
                  <strong>broad candidate pool</strong> (hundreds of items), then <strong>ranks</strong> to the top few
                  with transparent sources.
                </p>
              </div>
              <section
                className="main-safety safety-panel safety-panel--landing"
                id="safety-boundaries"
                aria-labelledby="safety-landing-title"
              >
                <SafetyBoundariesContent titleId="safety-landing-title" />
              </section>
            </>
          )}
          {messages.map((m, idx) => (
            <div key={idx} className={`bubble bubble--${m.role}`}>
              {m.role === "user" ? (
                <div className="bubble__content">{m.content}</div>
              ) : (
                <>
                  <div className="bubble__content markdown">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                  {m.meta?.expandedQuery && (
                    <div className="stats mono subtle">Expanded query: {m.meta.expandedQuery}</div>
                  )}
                  {m.meta?.embedding?.enabled && (
                    <div className="stats mono subtle">
                      Semantic rank — {m.meta.embedding.label ?? m.meta.embedding.preset} ({m.meta.embedding.modelId}) ·{" "}
                      {Math.round((m.meta.embedding.semanticWeight ?? 0.55) * 100)}% embedding · pool{" "}
                      {m.meta.embedding.poolSize}
                    </div>
                  )}
                  {m.payload?.sources?.publications?.length > 0 && (
                    <div className="sources-block sources-block--publications">
                      <h3>Publication sources</h3>
                      <div className="source-grid">
                        {m.payload.sources.publications.map((p) => (
                          <SourceCard
                            key={p.label + p.url}
                            item={p}
                            kind="pub"
                            listLength={m.payload.sources.publications.length}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {m.payload?.sources?.trials?.length > 0 && (
                    <div className="sources-block">
                      <h3>Clinical trial sources</h3>
                      <div className="source-grid">
                        {m.payload.sources.trials.map((t) => (
                          <SourceCard
                            key={t.label + t.url}
                            item={t}
                            kind="trial"
                            listLength={m.payload.sources.trials.length}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {m.payload?.errors?.length > 0 && (
                    <div className="banner banner--warn">
                      Partial retrieval: {m.payload.errors.map((e) => `${e.source}: ${e.message}`).join(" · ")}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          {messages.length > 0 && (
            <div className="thread__end">
              <p className="thread__end-label subtle" role="status">
                End of results
              </p>
              <button
                type="button"
                className="btn btn--ghost thread__back-top"
                onClick={scrollPageToTop}
                aria-label="Scroll to top of page"
              >
                Back to top
              </button>
            </div>
          )}
        </section>
      </main>

      <footer className="composer" id="composer">
        {hasContext && <span className="composer__hint subtle">Using sidebar context for this thread.</span>}
        <div className="composer__row">
          <textarea
            id="query-field"
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a follow-up… (prior disease context is kept on the server)"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={loading}
          />
          <button type="button" className="btn btn--primary" onClick={() => send()} disabled={loading}>
            {loading ? "…" : "Send"}
          </button>
        </div>
      </footer>

      {mobileNavOpen && (
        <>
          <div
            className="mobile-nav-backdrop"
            role="presentation"
            aria-hidden
            onClick={() => setMobileNavOpen(false)}
          />
          <nav className="mobile-nav-panel" id="mobile-nav-panel" aria-label="Jump to page sections">
            <div className="mobile-nav-panel__header">
              <span className="mobile-nav-panel__title">Jump to</span>
              <button
                type="button"
                className="mobile-nav-panel__close"
                aria-label="Close menu"
                onClick={() => setMobileNavOpen(false)}
              >
                ×
              </button>
            </div>
            <ul className="mobile-nav-panel__list">
              <li>
                <a href="#session-context" className="mobile-nav-panel__link" onClick={() => setMobileNavOpen(false)}>
                  Session context
                </a>
              </li>
              <li>
                <a href="#quick-prompts" className="mobile-nav-panel__link" onClick={() => setMobileNavOpen(false)}>
                  Quick prompts
                </a>
              </li>
              <li>
                <a
                  href="#query-field"
                  className="mobile-nav-panel__link"
                  onClick={() => {
                    setMobileNavOpen(false);
                    window.setTimeout(() => document.getElementById("query-field")?.focus(), 200);
                  }}
                >
                  Query text area
                </a>
              </li>
              <li>
                <a href="#retrieval-stats" className="mobile-nav-panel__link" onClick={() => setMobileNavOpen(false)}>
                  Retrieval stats
                </a>
              </li>
            </ul>
          </nav>
        </>
      )}
    </div>
  );
}
