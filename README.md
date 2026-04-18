# Curalink — AI Medical Research Assistant (MERN prototype)

End-to-end research companion: **query understanding → broad retrieval (OpenAlex, PubMed, ClinicalTrials.gov) → ranking → open-source LLM synthesis** with **MongoDB-backed multi-turn context**.

## Architecture (high level)

1. **Input**: Natural language plus optional structured fields (patient label, disease, research intent, trial geography).
2. **Context**: Last messages are summarized textually for the LLM; MongoDB stores `summaryContext` (disease, location, etc.) for follow-ups when the client omits fields.
3. **Query expansion**: Deterministic merge of disease + intent, optionally refined by **Ollama** JSON (no proprietary LLM APIs).
4. **Retrieval (depth first)**:
   - OpenAlex: up to **200** works.
   - PubMed: up to **200** IDs → batched esummary + abstract **efetch** enrichment for the top slice.
   - ClinicalTrials.gov v2: **paged** fetch up to **~220** studies (`query.cond`, `query.term`, optional `query.locn`).
5. **Ranking**: Hybrid **keyword relevance** + **recency** + light **venue / recruitment** signals → **top 8** publications and **top 8** trials, each with a **supporting snippet** for attribution.
6. **Reasoning**: **Ollama** generates strict JSON sections grounded on numbered `P*` / `T*` sources; if Ollama is unavailable, a **deterministic fallback** still lists retrieved evidence.

## Prerequisites

- **Node.js 18+**
- **MongoDB** (local or Atlas), URI in `.env`
- **Ollama** running locally with a chat model, e.g. `ollama pull llama3.2`

## Configuration

Copy `backend/.env.example` to `backend/.env` and set at least:

- `MONGODB_URI`
- `PUBMED_EMAIL` (NCBI polite-use)
- `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- `OLLAMA_MODEL` (e.g. `llama3.2`)
- `CURALINK_FAST_MODE` — default **`1`** in code (smaller retrieval, skips the extra LLM query-expansion call, shorter Ollama synthesis budget). Set to **`0`** or **`full`** for maximum depth (slower on CPU).

Frontend dev proxy targets `http://127.0.0.1:5000`. For production you can either:

- Set `VITE_API_BASE` at build time to your public API origin and host `frontend/dist` on any static host, **or**
- Build the SPA then set `FRONTEND_DIST` (see `backend/.env.example`) so Express serves `index.html` and assets from one process (same-origin `/api`).

## Run locally

Terminal 1 — API:

```bash
cd backend
npm install
npm run dev
```

Terminal 2 — UI:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Ensure MongoDB and Ollama are running.

## Deployment notes

- **API**: Any Node host (Render, Railway, Fly.io, etc.) with env vars and outbound HTTPS to NCBI, OpenAlex, ClinicalTrials.gov, and your Ollama **ingress** (or swap Ollama for another self-hosted inference endpoint reachable from the API).
- **Database**: MongoDB Atlas recommended.
- **Ollama in production**: Usually runs on a GPU-capable VM; point `OLLAMA_BASE_URL` at that internal URL and protect it with network policy / auth.

### Deploy the frontend on Vercel

Vercel is best for the **React (Vite) static build**. The **Express API** should run on a Node-capable host (e.g. Render/Railway) because chat requests are **long-lived** and need **MongoDB + Ollama** next to the API.

1. Deploy the **backend** first; note its public origin, e.g. `https://curalink-api.onrender.com` (no trailing slash).
2. In [Vercel](https://vercel.com): **Add New Project** → import **`Meetamadhu/curalink`** (or your fork).
3. **Root Directory**: set to **`frontend`** (Project Settings → General if you need to change it later).
4. **Environment Variables** (Production — required **before** the first successful build):
   - **`VITE_API_BASE`** = your API origin, e.g. `https://curalink-api.onrender.com`  
     Vite bakes this in at **build** time. If you change it, trigger a **Redeploy**.
5. **Build**: default `npm run build`, **Output**: `dist` (Vercel auto-detects Vite when root is `frontend`).
6. **CORS**: this repo’s API uses `cors({ origin: true })`, which reflects the browser origin so the Vercel URL can call the API.

`frontend/vercel.json` adds a SPA-style rewrite so hard-refreshes keep serving `index.html`.

## API

- `POST /api/chat` — body: `{ "conversationId"?: string, "message": string, "structured"?: { patientName?, disease?, additionalQuery?, location? } }`
- `GET /api/chat/:id` — fetch stored conversation
- `GET /api/health` — liveness

## Trade-offs (evaluation-friendly)

- **Embeddings / vector DB**: Not required for the MVP; ranking is **transparent and fast**, suitable for demo-scale traffic. Swapping in embeddings over stored abstracts is a natural upgrade path.
- **Chunking**: Publications are used as **title + abstract-level** units for this prototype; full-text PDF ingestion would need PDF extraction + chunking + vector index.
- **Safety**: Responses are **research-oriented**, not clinical directives; the UI and prompts state this explicitly.
