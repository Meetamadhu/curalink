import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { postChat } from "./api.js";

const initialForm = {
  patientName: "",
  disease: "",
  additionalQuery: "",
  location: "",
};

function SourceCard({ item, kind }) {
  return (
    <article className={`source-card source-card--${kind}`}>
      <div className="source-card__meta">
        <span className="pill">{item.platform}</span>
        {item.label && <span className="pill pill--muted">{item.label}</span>}
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

export default function App() {
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const hasContext = useMemo(() => Boolean(form.disease || form.location || form.patientName), [form]);

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

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__logo" aria-hidden />
          <div>
            <div className="brand__name">Curalink</div>
            <div className="brand__tag">Research + reasoning</div>
          </div>
        </div>

        <p className="sidebar__intro">
          Structured context improves retrieval. Follow-up questions reuse your last disease focus automatically.
        </p>

        <div className="panel">
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

        <div className="panel panel--compact">
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

        <div className="panel panel--compact sidebar-stats" aria-live="polite">
          <h3>Retrieval stats</h3>
          {loading && !lastRunStats && (
            <p className="sidebar-stats__empty subtle">Waiting for the latest run…</p>
          )}
          {!loading && !lastRunStats && (
            <p className="sidebar-stats__empty subtle">
              Candidate counts from OpenAlex, PubMed, and ClinicalTrials.gov appear here after your first answer in this session.
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

        {conversationId && (
          <p className="mono subtle">
            Thread: <span className="select-all">{String(conversationId)}</span>
          </p>
        )}
      </aside>

      <main className="main">
        <header className="main__header">
          <div className="main__header-intro">
            <h1>Assistant</h1>
            <p className="subtle main__header-intro__tagline">
              OpenAlex + PubMed + ClinicalTrials.gov → rank →{" "}
              <span className="accent">local open-source LLM</span> (Ollama). Not medical advice.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--new-thread"
            onClick={() => {
              setConversationId(null);
              setMessages([]);
              setError("");
            }}
            disabled={loading}
          >
            New conversation
          </button>
        </header>

        {error && <div className="banner banner--error">{error}</div>}
        {loading && (
          <div className="banner banner--info" role="status">
            Retrieving from OpenAlex, PubMed, and ClinicalTrials.gov, then running the local model. This often takes{" "}
            <strong>1–5 minutes</strong> on a CPU; the page will update when the answer is ready.
          </div>
        )}

        <section className="thread" aria-live="polite">
          {messages.length === 0 && (
            <div className="empty">
              <h2>Start a research conversation</h2>
              <p>
                Ask in natural language, optionally set disease and location on the left. The backend pulls a{" "}
                <strong>broad candidate pool</strong> (hundreds of items), then <strong>ranks</strong> to the top few
                with transparent sources.
              </p>
            </div>
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
                  {m.payload?.retrievalStats && (
                    <div className="stats mono subtle">
                      Candidates — OpenAlex: {m.payload.retrievalStats.openAlexCandidates}, PubMed:{" "}
                      {m.payload.retrievalStats.pubmedCandidates}, trials: {m.payload.retrievalStats.trialCandidates},
                      merged pubs: {m.payload.retrievalStats.mergedPublicationCandidates}
                    </div>
                  )}
                  {m.meta?.expandedQuery && (
                    <div className="stats mono subtle">Expanded query: {m.meta.expandedQuery}</div>
                  )}
                  {m.payload?.sources?.publications?.length > 0 && (
                    <div className="sources-block">
                      <h3>Publication sources</h3>
                      <div className="source-grid">
                        {m.payload.sources.publications.map((p) => (
                          <SourceCard key={p.label + p.url} item={p} kind="pub" />
                        ))}
                      </div>
                    </div>
                  )}
                  {m.payload?.sources?.trials?.length > 0 && (
                    <div className="sources-block">
                      <h3>Clinical trial sources</h3>
                      <div className="source-grid">
                        {m.payload.sources.trials.map((t) => (
                          <SourceCard key={t.label + t.url} item={t} kind="trial" />
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
        </section>

        <footer className="composer">
          {hasContext && <span className="composer__hint subtle">Using sidebar context for this thread.</span>}
          <div className="composer__row">
            <textarea
              rows={2}
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
      </main>
    </div>
  );
}
