import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcesPath = join(__dirname, "..", "data", "sources.json");

const STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "for",
  "from",
  "gitlab",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "should",
  "that",
  "the",
  "their",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
]);

const SYNONYMS = {
  ai: ["artificial", "intelligence", "duo"],
  async: ["asynchronous", "remote", "distributed"],
  candidate: ["interview", "hiring", "employee"],
  ci: ["continuous", "integration", "pipeline"],
  collaboration: ["communication", "teamwork"],
  culture: ["values", "behaviors"],
  devsecops: ["development", "security", "operations", "platform"],
  direction: ["strategy", "roadmap", "vision"],
  handbook: ["documentation", "manual", "process"],
  meeting: ["sync", "synchronous", "communication"],
  remote: ["distributed", "asynchronous", "allremote"],
  security: ["secure", "vulnerability", "compliance"],
  transparency: ["public", "visible", "documentation"],
};

const INTENTS = [
  {
    id: "candidate",
    label: "Candidate readiness",
    terms: ["candidate", "interview", "job", "hiring", "employee", "new"],
  },
  {
    id: "culture",
    label: "Culture and values",
    terms: ["culture", "values", "transparency", "iteration", "collaboration", "results"],
  },
  {
    id: "remote",
    label: "Remote operating model",
    terms: ["remote", "async", "asynchronous", "distributed", "meeting", "timezone"],
  },
  {
    id: "product",
    label: "Product direction",
    terms: ["direction", "strategy", "roadmap", "product", "devsecops", "duo", "platform"],
  },
  {
    id: "process",
    label: "Ways of working",
    terms: ["handbook", "process", "documentation", "decision", "communication"],
  },
];

let cachedIndex;

function unique(tokens) {
  return [...new Set(tokens)];
}

function normalizeToken(token) {
  if (token === "allremote") return "remote";
  if (token === "devsecops") return "devsecops";
  if (token === "kubernetes") return "kubernetes";
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

export function tokenize(text) {
  const baseTokens =
    String(text)
      .toLowerCase()
      .replace(/all[- ]remote/g, "allremote")
      .replace(/devsecops/g, "devsecops")
      .match(/[a-z0-9]+/g)
      ?.map(normalizeToken)
      .filter((token) => (token.length > 2 || ["ai", "ci", "cd"].includes(token)) && !STOP_WORDS.has(token)) || [];

  const expanded = [];
  for (const token of baseTokens) {
    expanded.push(token);
    if (SYNONYMS[token]) expanded.push(...SYNONYMS[token]);
  }
  return expanded;
}

function termFrequency(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function cosineSimilarity(queryVector, documentVector) {
  let dot = 0;
  let queryMagnitude = 0;
  let documentMagnitude = 0;

  for (const value of queryVector.values()) queryMagnitude += value * value;
  for (const [term, value] of documentVector) {
    documentMagnitude += value * value;
    dot += value * (queryVector.get(term) || 0);
  }

  if (!queryMagnitude || !documentMagnitude) return 0;
  return dot / (Math.sqrt(queryMagnitude) * Math.sqrt(documentMagnitude));
}

function vectorize(tokens, idf) {
  const tf = termFrequency(tokens);
  const vector = new Map();
  for (const [term, count] of tf) {
    vector.set(term, (1 + Math.log(count)) * (idf.get(term) || 0));
  }
  return vector;
}

function createChunks(source) {
  const chunks = [
    {
      section: "Overview",
      text: `${source.title}. ${source.summary}`,
      weight: 1.3,
    },
  ];

  for (const [index, highlight] of (source.highlights || []).entries()) {
    chunks.push({
      section: `Evidence ${index + 1}`,
      text: `${source.title}. ${highlight}`,
      weight: 1.15,
    });
  }

  if (source.employeeUseCase) {
    chunks.push({
      section: "Employee Use Case",
      text: `${source.title}. ${source.employeeUseCase}`,
      weight: 1.25,
    });
  }

  return chunks.map((chunk, index) => {
    const searchableText = [
      source.title,
      source.category,
      source.summary,
      chunk.text,
      ...(source.tags || []),
    ].join(" ");

    return {
      id: `${source.id}-${index}`,
      sourceId: source.id,
      title: source.title,
      category: source.category,
      url: source.url,
      section: chunk.section,
      text: chunk.text,
      summary: source.summary,
      highlights: source.highlights || [],
      tags: source.tags || [],
      lastReviewed: source.lastReviewed,
      weight: chunk.weight,
      tokens: tokenize(searchableText),
    };
  });
}

async function loadIndex() {
  if (cachedIndex) return cachedIndex;

  const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
  const chunks = sources.flatMap(createChunks);
  const averageLength = chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / chunks.length;

  const documentFrequency = new Map();
  for (const chunk of chunks) {
    for (const token of new Set(chunk.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [term, frequency] of documentFrequency) {
    idf.set(term, Math.log((chunks.length - frequency + 0.5) / (frequency + 0.5) + 1));
  }

  cachedIndex = {
    averageLength,
    chunkCount: chunks.length,
    sources,
    idf,
    chunks: chunks.map((chunk) => ({
      ...chunk,
      tf: termFrequency(chunk.tokens),
      vector: vectorize(chunk.tokens, idf),
    })),
  };

  return cachedIndex;
}

function bm25Score(queryTokens, chunk, idf, averageLength) {
  const k1 = 1.4;
  const b = 0.72;
  let score = 0;
  const uniqueTerms = new Set(queryTokens);

  for (const term of uniqueTerms) {
    const frequency = chunk.tf.get(term) || 0;
    if (!frequency) continue;
    const termIdf = idf.get(term) || 0;
    const numerator = frequency * (k1 + 1);
    const denominator = frequency + k1 * (1 - b + b * (chunk.tokens.length / averageLength));
    score += termIdf * (numerator / denominator);
  }

  return score;
}

function inferIntent(question) {
  const normalized = question.toLowerCase();
  if (/\b(remote|async|asynchronous|distributed|time ?zone)\b/.test(normalized)) {
    return INTENTS.find((intent) => intent.id === "remote");
  }
  if (/\b(duo|ai|devsecops|direction|roadmap|strategy|product)\b/.test(normalized)) {
    return INTENTS.find((intent) => intent.id === "product");
  }
  if (/\b(handbook-first|communication|meeting|decision|documentation|process)\b/.test(normalized)) {
    return INTENTS.find((intent) => intent.id === "process");
  }
  if (/\b(transparency|transparent|guardrail|values|culture|iteration|collaboration)\b/.test(normalized)) {
    return INTENTS.find((intent) => intent.id === "culture");
  }

  const tokens = tokenize(question);
  const scores = INTENTS.map((intent) => ({
    ...intent,
    score: intent.terms.reduce((sum, term) => sum + tokens.filter((token) => token === term).length, 0),
  })).sort((a, b) => b.score - a.score || a.terms.length - b.terms.length);

  return scores[0]?.score ? scores[0] : { id: "general", label: "General handbook search", score: 0 };
}

function inferIntents(question) {
  const tokens = tokenize(question);
  return INTENTS.map((intent) => ({
    ...intent,
    score: intent.terms.reduce((sum, term) => sum + tokens.filter((token) => token === term).length, 0),
  }))
    .filter((intent) => intent.score > 0)
    .sort((a, b) => b.score - a.score);
}

function shouldUseHistory(question) {
  const normalized = question.toLowerCase().trim();
  const tokenCount = tokenize(question).length;
  return (
    tokenCount <= 4 ||
    /\b(that|this|it|they|them|those|same|above|earlier|previous|you mentioned)\b/.test(normalized) ||
    /^(what about|how about|why|can you explain|tell me more|expand on)\b/.test(normalized)
  );
}

function compactHistory(history, question) {
  if (!shouldUseHistory(question)) return "";

  return history
    .filter((message) => message?.role === "user")
    .map((message) => String(message.content || "").trim())
    .filter((content) => content && content.toLowerCase() !== question.toLowerCase().trim())
    .slice(-2)
    .join(" ");
}

function hasPromptInjection(question) {
  return /ignore (all|the|previous)|system prompt|developer message|reveal.*instruction|jailbreak/i.test(question);
}

function rerankForDiversity(scoredChunks) {
  const seenSources = new Set();
  return scoredChunks
    .map((chunk) => {
      const diversityBoost = seenSources.has(chunk.sourceId) ? 0 : 0.04;
      seenSources.add(chunk.sourceId);
      return { ...chunk, score: chunk.score + diversityBoost };
    })
    .sort((a, b) => b.score - a.score);
}

function retrieve(question, history = [], limit = 6) {
  return loadIndex().then((index) => {
    const historyContext = compactHistory(history, question);
    const currentTokens = tokenize(question);
    const queryTokens = historyContext ? [...currentTokens, ...tokenize(historyContext)] : currentTokens;
    const intent = inferIntent(question);
    const intents = inferIntents(question);
    const currentTokenSet = new Set(currentTokens);
    const queryVector = vectorize(queryTokens, index.idf);
    const maxBm25 = Math.max(
      ...index.chunks.map((chunk) => bm25Score(queryTokens, chunk, index.idf, index.averageLength)),
      0.0001
    );

    const scored = index.chunks.map((chunk) => {
      const bm25 = bm25Score(queryTokens, chunk, index.idf, index.averageLength) / maxBm25;
      const vector = cosineSimilarity(queryVector, chunk.vector);
      const tagTokens = unique(tokenize(chunk.tags.join(" ")));
      const titleTokens = unique(tokenize(chunk.title));
      const currentTagOverlap = tagTokens.filter((token) => currentTokenSet.has(token)).length;
      const currentTitleOverlap = titleTokens.filter((token) => currentTokenSet.has(token)).length;
      const intentBoost = intents.some((matchedIntent) =>
        tagTokens.some((token) => matchedIntent.terms.includes(token))
      )
        ? 0.06
        : 0;
      const currentQuestionBoost = Math.min(0.18, currentTagOverlap * 0.045 + currentTitleOverlap * 0.06);
      const sourceSpecificBoost =
        (currentTokenSet.has("remote") && chunk.sourceId === "all-remote" ? 0.32 : 0) +
        (currentTokenSet.has("communication") && chunk.sourceId === "communication" ? 0.24 : 0) +
        (currentTokenSet.has("handbook") && currentTokenSet.has("communication") && chunk.sourceId === "communication"
          ? 0.16
          : 0) +
        ((currentTokenSet.has("transparency") || currentTokenSet.has("guardrail")) && chunk.sourceId === "transparency"
          ? 0.3
          : 0) +
        (currentTokenSet.has("ai") && ["ai-powered-devsecops", "gitlab-duo"].includes(chunk.sourceId) ? 0.24 : 0);

      return {
        ...chunk,
        score: (0.6 * bm25 + 0.24 * vector + intentBoost + currentQuestionBoost + sourceSpecificBoost) * chunk.weight,
        bm25: Number(bm25.toFixed(3)),
        vector: Number(vector.toFixed(3)),
      };
    });

    const topChunks = rerankForDiversity(scored)
      .filter((chunk) => chunk.score > 0.04)
      .slice(0, limit);

    return { ...index, intent, queryTokens, matches: topChunks };
  });
}

function formatBullets(lines) {
  return lines
    .filter(Boolean)
    .slice(0, 4)
    .map((line) => `- ${line}`)
    .join("\n");
}

function sourceSummary(matches) {
  const bySource = new Map();
  for (const match of matches) {
    if (!bySource.has(match.sourceId)) {
      bySource.set(match.sourceId, {
        id: match.sourceId,
        title: match.title,
        url: match.url,
        category: match.category,
        score: match.score,
        sections: new Set([match.section]),
        lastReviewed: match.lastReviewed,
      });
    } else {
      const source = bySource.get(match.sourceId);
      source.score = Math.max(source.score, match.score);
      source.sections.add(match.section);
    }
  }

  return [...bySource.values()]
    .sort((a, b) => b.score - a.score)
    .map((source) => ({
      ...source,
      score: Number(source.score.toFixed(3)),
      sections: [...source.sections],
    }));
}

function buildAnswer(question, matches, intent) {
  const primary = matches[0];
  const supportingEvidence = matches
    .slice(0, 4)
    .map((match) => match.text.replace(`${match.title}. `, ""))
    .filter((line, index, lines) => lines.indexOf(line) === index);

  const practicalTakeaway = inferFollowUp(question, intent);
  const relatedSources = [...new Set(matches.slice(1, 5).map((match) => match.title))]
    .filter((title) => title !== primary.title)
    .slice(0, 3);

  return [
    `From GitLab's public ${primary.category.toLowerCase()} material: ${primary.summary}`,
    "",
    "What matters:",
    formatBullets(supportingEvidence),
    relatedSources.length ? `\nRelated areas to inspect next: ${relatedSources.join("; ")}.` : "",
    "",
    practicalTakeaway,
  ]
    .filter(Boolean)
    .join("\n");
}

function inferFollowUp(question, intent) {
  const normalized = question.toLowerCase();
  if (intent.id === "candidate" || normalized.includes("interview") || normalized.includes("candidate")) {
    return "For a candidate, the strongest signal is connecting your answer to GitLab's operating habits: document first, iterate quickly, preserve transparency, and tie work to measurable customer value.";
  }
  if (intent.id === "remote") {
    return "For day-to-day work, this means fewer status meetings, clearer written decisions, and stronger ownership across time zones.";
  }
  if (intent.id === "product") {
    return "For product understanding, map the answer back to the DevSecOps platform: how the work reduces handoffs across development, security, and operations.";
  }
  if (intent.id === "culture") {
    return "For employee behavior, treat the values as operating instructions: make work visible, prefer small improvements, and communicate with enough context that others can act.";
  }
  return "A good follow-up is to ask how this affects employees, candidates, product teams, or day-to-day remote collaboration.";
}

async function generateWithOpenAI(question, matches, draftAnswer) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const context = matches
    .slice(0, 6)
    .map((match, index) => {
      return `[${index + 1}] ${match.title} / ${match.section}\nURL: ${match.url}\n${match.text}`;
    })
    .join("\n\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a GitLab Handbook and Direction assistant. Use only the supplied context. If the context is insufficient, say so. Be concise, cite source numbers inline, and do not invent policies.",
        },
        {
          role: "user",
          content: `Question: ${question}\n\nContext:\n${context}\n\nDeterministic draft:\n${draftAnswer}`,
        },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function generateWithGemini(question, matches, draftAnswer) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const context = matches
    .slice(0, 6)
    .map((match, index) => `[${index + 1}] ${match.title} / ${match.section}\n${match.text}\n${match.url}`)
    .join("\n\n");
  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Answer as a GitLab Handbook assistant. Use only the context. Cite source numbers.\n\nQuestion: ${question}\n\nContext:\n${context}\n\nDraft:\n${draftAnswer}`,
              },
            ],
          },
        ],
        generationConfig: { temperature: 0.2 },
      }),
    }
  );

  if (!response.ok) return null;
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

async function maybeGenerateWithLlm(question, matches, draftAnswer) {
  return (
    (await generateWithOpenAI(question, matches, draftAnswer)) ||
    (await generateWithGemini(question, matches, draftAnswer))
  );
}

export function getSuggestions() {
  return [
    "How should a candidate prepare for GitLab's remote culture?",
    "What does handbook-first communication mean in practice?",
    "How does GitLab's product direction connect to DevSecOps?",
    "What guardrails exist around transparency?",
    "How should a new employee use GitLab values day to day?",
  ];
}

export async function getKnowledgeStats() {
  const index = await loadIndex();
  return {
    sourceCount: index.sources.length,
    chunkCount: index.chunkCount,
    categories: [...new Set(index.sources.map((source) => source.category))],
    lastReviewed: index.sources
      .map((source) => source.lastReviewed)
      .filter(Boolean)
      .sort()
      .at(-1),
  };
}

export async function getSources() {
  const index = await loadIndex();
  return index.sources.map(({ id, title, category, url, summary, lastReviewed }) => ({
    id,
    title,
    category,
    url,
    summary,
    lastReviewed,
  }));
}

export async function retrieveForEvaluation(question) {
  const result = await retrieve(question, [], 6);
  return {
    intent: result.intent,
    matches: sourceSummary(result.matches),
  };
}

export async function answerQuestion(question, history = []) {
  if (hasPromptInjection(question)) {
    return {
      answer:
        "I cannot follow instructions to ignore system rules or reveal hidden prompts. I can still answer normal questions about GitLab's public Handbook and Direction material.",
      confidence: "guarded",
      sources: [],
      mode: "guardrail",
      intent: "Safety guardrail",
    };
  }

  const result = await retrieve(question, history, 8);
  const sourceMatches = sourceSummary(result.matches);
  const topScore = result.matches[0]?.score || 0;

  if (!sourceMatches.length || topScore < 0.12) {
    return {
      answer:
        "I could not find enough support in the loaded GitLab Handbook and Direction material to answer that confidently. Try asking about remote work, transparency, values, product direction, DevSecOps, GitLab Duo, or handbook-first work.",
      confidence: "low",
      sources: [],
      mode: "retrieval",
      intent: result.intent.label,
    };
  }

  const draftAnswer = buildAnswer(question, result.matches, result.intent);
  const llmAnswer = await maybeGenerateWithLlm(question, result.matches, draftAnswer);

  return {
    answer: llmAnswer || draftAnswer,
    confidence: topScore > 0.72 ? "high" : topScore > 0.34 ? "medium" : "low",
    sources: sourceMatches.slice(0, 5),
    mode: llmAnswer ? "LLM + RAG" : "retrieval",
    intent: result.intent.label,
  };
}
