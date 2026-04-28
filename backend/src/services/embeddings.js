/**
 * Semantic reranking via @xenova/transformers (Sentence Transformers–compatible ONNX models).
 * Presets: MiniLM, BGE-small, E5-small, Instructor (large ONNX build; see preset alias below).
 */

/** Curated Xenova Hub models (transformers.js). */
export const EMBEDDING_PRESETS = {
  minilm: {
    label: "MiniLM L6",
    modelId: "Xenova/all-MiniLM-L6-v2",
    kind: "plain",
  },
  "bge-small": {
    label: "BGE small EN v1.5",
    modelId: "Xenova/bge-small-en-v1.5",
    kind: "plain",
  },
  "e5-small": {
    label: "E5 multilingual small",
    modelId: "Xenova/multilingual-e5-small",
    kind: "e5",
  },
  /** ONNX distribution uses instructor-large weights (closest XL-tier Instructor build on Xenova Hub). */
  "instructor-xl": {
    label: "Instructor (large ONNX)",
    modelId: "Xenova/instructor-large",
    kind: "instructor",
    queryInstr: "Represent the question for retrieving supporting scientific documents:",
    docInstr: "Represent the biomedical document for retrieval:",
  },
};

const extractorCache = new Map();

function tensorToVectors(tensor) {
  const data = tensor.data;
  const d = tensor.dims;
  if (!d?.length) {
    return [Float32Array.from(data)];
  }
  if (d.length === 1) {
    return [Float32Array.from(data)];
  }
  const batch = d[0];
  const dim = d[1];
  const out = [];
  for (let i = 0; i < batch; i++) {
    const start = i * dim;
    out.push(Float32Array.from(data.subarray(start, start + dim)));
  }
  return out;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function normalize01(values) {
  const xs = values.map((v) => Number(v));
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const span = Math.max(max - min, 1e-9);
  return xs.map((x) => (x - min) / span);
}

function formatQuery(queryText, spec) {
  const q = String(queryText || "").trim().slice(0, 2000);
  switch (spec.kind) {
    case "e5":
      return `query: ${q}`;
    case "instructor":
      return `${spec.queryInstr}\n${q}`;
    default:
      return q;
  }
}

function formatPassage(text, spec) {
  const t = String(text || "").trim().slice(0, 6000);
  switch (spec.kind) {
    case "e5":
      return `passage: ${t}`;
    case "instructor":
      return `${spec.docInstr}\n${t}`;
    default:
      return t;
  }
}

async function getExtractor(modelId) {
  if (extractorCache.has(modelId)) return extractorCache.get(modelId);
  const { pipeline } = await import("@xenova/transformers");
  const ext = await pipeline("feature-extraction", modelId);
  extractorCache.set(modelId, ext);
  return ext;
}

async function embedBatch(extractor, strings, spec) {
  const formatted = strings.map((s) => formatPassage(s, spec));
  const out = await extractor(formatted, { pooling: "mean", normalize: true });
  return tensorToVectors(out);
}

async function embedOne(extractor, text, asQuery, spec) {
  const s = asQuery ? formatQuery(text, spec) : formatPassage(text, spec);
  const out = await extractor(s, { pooling: "mean", normalize: true });
  return tensorToVectors(out)[0];
}

function publicationPassage(p) {
  const title = String(p.title || "").trim();
  const abs = String(p.abstract || "").replace(/\s+/g, " ").trim().slice(0, 4000);
  return `${title}\n${abs}`;
}

function trialPassage(t) {
  const title = String(t.title || "").trim();
  const el = String(t.eligibility || "").replace(/\s+/g, " ").trim().slice(0, 3500);
  const loc = String(t.locations || "").trim().slice(0, 800);
  return `${title}\n${el}\n${loc}`;
}

/**
 * Build semantic options from env. Returns null when disabled or in fast mode (caller passes fast).
 * Override model: set CURALINK_EMBEDDING_MODEL to a full Xenova model id (preset ignored).
 */
export function semanticOptionsFromEnv(env = process.env, { fast } = {}) {
  if (fast) return null;
  const off = ["0", "false", "no", "off"].includes(String(env.CURALINK_EMBEDDINGS ?? "").trim().toLowerCase());
  if (off) return null;

  const rawWeight = Number(env.CURALINK_EMBEDDING_WEIGHT ?? 0.55);
  const semanticWeight = Math.min(0.95, Math.max(0.05, Number.isFinite(rawWeight) ? rawWeight : 0.55));
  const rawPool = Number(env.CURALINK_EMBEDDING_POOL ?? 64);
  const poolSize = Math.min(160, Math.max(12, Number.isFinite(rawPool) ? rawPool : 64));

  const customModel = String(env.CURALINK_EMBEDDING_MODEL || "").trim();
  if (customModel) {
    return {
      enabled: true,
      preset: "custom",
      label: customModel,
      modelId: customModel,
      kind: "plain",
      semanticWeight,
      poolSize,
    };
  }

  const presetKey = String(env.CURALINK_EMBEDDING_PRESET || "minilm")
    .trim()
    .toLowerCase();
  const spec = EMBEDDING_PRESETS[presetKey];
  if (!spec) {
    console.warn(`[curalink] Unknown CURALINK_EMBEDDING_PRESET="${presetKey}", falling back to minilm`);
    return {
      enabled: true,
      preset: "minilm",
      ...EMBEDDING_PRESETS.minilm,
      semanticWeight,
      poolSize,
    };
  }

  return {
    enabled: true,
    preset: presetKey,
    ...spec,
    semanticWeight,
    poolSize,
  };
}

export async function rerankPublicationsSemantic(pool, queryText, options) {
  const modelId = options.modelId;
  const spec = {
    kind: options.kind || "plain",
    queryInstr: options.queryInstr,
    docInstr: options.docInstr,
  };
  const extractor = await getExtractor(modelId);
  const qVec = await embedOne(extractor, queryText, true, spec);

  const passages = pool.map(publicationPassage);
  const batchSize = 12;
  const semRaw = [];
  for (let i = 0; i < passages.length; i += batchSize) {
    const chunk = passages.slice(i, i + batchSize);
    const vecs = await embedBatch(extractor, chunk, spec);
    for (let j = 0; j < vecs.length; j++) semRaw.push(dot(qVec, vecs[j]));
  }

  const lex = normalize01(pool.map((p) => p._score));
  const sem = normalize01(semRaw);
  const w = options.semanticWeight;

  const combined = pool.map((p, i) => ({
    ...p,
    _semanticSim: Number(semRaw[i].toFixed(4)),
    _score: 15 * (w * sem[i] + (1 - w) * lex[i]),
  }));
  combined.sort((a, b) => b._score - a._score);
  return combined;
}

export async function rerankTrialsSemantic(pool, queryText, options) {
  const modelId = options.modelId;
  const spec = {
    kind: options.kind || "plain",
    queryInstr: options.queryInstr,
    docInstr: options.docInstr,
  };
  const extractor = await getExtractor(modelId);
  const qVec = await embedOne(extractor, queryText, true, spec);

  const passages = pool.map(trialPassage);
  const batchSize = 12;
  const semRaw = [];
  for (let i = 0; i < passages.length; i += batchSize) {
    const chunk = passages.slice(i, i + batchSize);
    const vecs = await embedBatch(extractor, chunk, spec);
    for (let j = 0; j < vecs.length; j++) semRaw.push(dot(qVec, vecs[j]));
  }

  const lex = normalize01(pool.map((p) => p._score));
  const sem = normalize01(semRaw);
  const w = options.semanticWeight;

  const combined = pool.map((p, i) => ({
    ...p,
    _semanticSim: Number(semRaw[i].toFixed(4)),
    _score: 15 * (w * sem[i] + (1 - w) * lex[i]),
  }));
  combined.sort((a, b) => b._score - a._score);
  return combined;
}
