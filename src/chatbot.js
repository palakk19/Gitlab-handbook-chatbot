import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  analyzeQuery,
  buildClarificationAnswer,
  compactHistory,
  hasDomainSignal,
  hasPromptInjection,
  inferIntent,
  inferIntents,
  matchTopics,
  needsClarification,
} from "./queryAnalysis.js";
import { tokenize, unique } from "./textProcessing.js";

export { tokenize } from "./textProcessing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcesPath = join(__dirname, "..", "data", "sources.json");
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 12_000);

let cachedIndex;

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

function expandQueryTokens(question, historyContext) {
  const routedQuestion = historyContext ? `${question} ${historyContext}` : question;
  const topics = matchTopics(routedQuestion);
  const baseTokens = tokenize(routedQuestion);
  const expansionTokens = topics.flatMap((topic) => tokenize(topic.expansions.join(" ")));
  return {
    topics,
    tokens: [...baseTokens, ...expansionTokens],
  };
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
    const routedQuestion = historyContext ? `${question} ${historyContext}` : question;
    const queryProfile = analyzeQuery(routedQuestion);
    const currentTokens = tokenize(question);
    const expandedQuery = expandQueryTokens(question, historyContext);
    const queryTokens = expandedQuery.tokens;
    const intent = inferIntent(routedQuestion);
    const intents = inferIntents(routedQuestion);
    const currentTokenSet = new Set(currentTokens);
    const meaningfulTokenSet = new Set(queryProfile.nonDomainTokens);
    const queryVector = vectorize(queryTokens, index.idf);
    const maxBm25 = Math.max(
      ...index.chunks.map((chunk) => bm25Score(queryTokens, chunk, index.idf, index.averageLength)),
      0.0001
    );

    const scored = index.chunks.map((chunk) => {
      const chunkTokenSet = new Set(chunk.tokens);
      const bm25 = bm25Score(queryTokens, chunk, index.idf, index.averageLength) / maxBm25;
      const vector = cosineSimilarity(queryVector, chunk.vector);
      const tagTokens = unique(tokenize(chunk.tags.join(" ")));
      const titleTokens = unique(tokenize(chunk.title));
      const currentTagOverlap = tagTokens.filter((token) => currentTokenSet.has(token)).length;
      const currentTitleOverlap = titleTokens.filter((token) => currentTokenSet.has(token)).length;
      const meaningfulOverlap = [...meaningfulTokenSet].filter((token) => chunkTokenSet.has(token)).length;
      const intentBoost = intents.some((matchedIntent) =>
        tagTokens.some((token) => matchedIntent.terms.includes(token))
      )
        ? 0.06
        : 0;
      const currentQuestionBoost = Math.min(0.18, currentTagOverlap * 0.045 + currentTitleOverlap * 0.06);
      const fullQueryBoost = Math.min(0.12, meaningfulOverlap * 0.05);
      const topicBoost = expandedQuery.topics.reduce((sum, topic) => sum + (topic.boosts[chunk.sourceId] || 0), 0);
      const topicSupported = expandedQuery.topics.some((topic) => topic.boosts[chunk.sourceId]);

      return {
        ...chunk,
        score: (0.55 * bm25 + 0.22 * vector + intentBoost + currentQuestionBoost + fullQueryBoost + topicBoost) * chunk.weight,
        bm25: Number(bm25.toFixed(3)),
        vector: Number(vector.toFixed(3)),
        meaningfulOverlap,
        topicSupported,
      };
    });

    const topChunks = rerankForDiversity(scored)
      .filter((chunk) => chunk.score > 0.04)
      .slice(0, limit);

    return { ...index, intent, queryProfile, queryTokens, topics: expandedQuery.topics, matches: topChunks };
  });
}

function formatBullets(lines) {
  const seenNormalized = new Set();
  return lines
    .filter(Boolean)
    .filter((line) => {
      const normalized = line
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (seenNormalized.has(normalized)) return false;
      seenNormalized.add(normalized);
      return true;
    })
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

function isBroadMatch(matches, topics) {
  if (!topics?.length || !matches.length) return false;
  const boostedSourceIds = new Set(topics.flatMap((topic) => Object.keys(topic.boosts || {})));
  return !matches.slice(0, 3).some((match) => boostedSourceIds.has(match.sourceId));
}

function assessAnswerability(result) {
  const top = result.matches[0];
  if (!top) return { answerable: false, reason: "no retrieved evidence", supportScore: 0 };

  const topMatches = result.matches.slice(0, 3);
  const broadMatch = isBroadMatch(result.matches, result.topics);
  const topicSupported = topMatches.some((match) => match.topicSupported);
  const meaningfulOverlap = topMatches.reduce((sum, match) => sum + (match.meaningfulOverlap || 0), 0);
  const explicitContext = result.queryProfile.explicitGitLabContext;
  const supportScore =
    top.score +
    (topicSupported ? 0.12 : 0) +
    (meaningfulOverlap ? Math.min(0.1, meaningfulOverlap * 0.03) : 0) +
    (explicitContext ? 0.05 : 0) -
    (broadMatch ? 0.08 : 0);

  return {
    answerable: top.score >= 0.12 && (topicSupported || meaningfulOverlap > 0 || explicitContext || supportScore > 0.42),
    reason: broadMatch ? "broad related match" : topicSupported ? "topic-supported evidence" : "lexical evidence",
    supportScore: Number(supportScore.toFixed(3)),
    meaningfulOverlap,
    broadMatch,
  };
}

function readableCategory(category) {
  if (category === "GitLab Docs") return "docs";
  return String(category || "source").toLowerCase();
}

function buildAnswer(question, matches, intent, topics = []) {
  const primary = matches[0];
  const supportingEvidence = matches
    .filter((match) => match.section !== "Overview" || match.sourceId !== primary.sourceId)
    .slice(0, 5)
    .map((match) => match.text.replace(`${match.title}. `, ""))
    .filter((line) => line !== primary.summary)
    .filter((line, index, lines) => lines.indexOf(line) === index);

  const practicalTakeaway = inferFollowUp(question, intent, primary);
  const relatedSources = [...new Set(matches.slice(1, 5).map((match) => match.title))]
    .filter((title) => title !== primary.title)
    .slice(0, 3);

  const broadMatchNotice = isBroadMatch(matches, topics)
    ? "I found related GitLab material, but not a perfect source match for the exact wording. Here is the closest grounded answer."
    : "";

  return [
    broadMatchNotice,
    `From GitLab's public ${readableCategory(primary.category)} material: ${primary.summary}`,
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

function inferFollowUp(question, intent, primary) {
  const normalized = question.toLowerCase();
  if (primary?.sourceId === "issues-work-items" || /\b(ticket|tickets|issue|issues|work item|bug|task)\b/.test(normalized)) {
    return "So the short answer is yes, if you have access to the relevant project. In GitLab terminology, you usually create an issue or work item rather than saying you are raising a ticket.";
  }
  if (primary?.sourceId === "merge-request-reviewers") {
    return "So the short answer is yes: in a merge request, use the Reviewers field or sidebar to request review from the right people. Approvals can be a separate project rule.";
  }
  if (primary?.sourceId === "merge-request-comments") {
    return "So the short answer is yes: open the merge request, add a comment in the discussion area or on a changed line, and use threads to keep review feedback organized.";
  }
  if (primary?.sourceId === "comments-discussions") {
    return "In simple terms: a GitLab comment is how people discuss work directly where that work lives, instead of moving the context into a separate chat.";
  }
  if (intent.id === "candidate" || normalized.includes("interview") || normalized.includes("candidate")) {
    return "For a candidate, the strongest signal is connecting your answer to GitLab's operating habits: document first, iterate quickly, preserve transparency, and tie work to measurable customer value.";
  }
  if (normalized.includes("async") || normalized.includes("asynchronous")) {
    return "In practice, the answer is not just fewer meetings: it is writing decisions clearly enough that teammates can contribute later, across time zones, without losing context.";
  }
  if (intent.id === "remote") {
    return "For day-to-day work, this means fewer status meetings, clearer written decisions, and stronger ownership across time zones.";
  }
  if (intent.id === "product") {
    return "For product understanding, map the answer back to the DevSecOps platform: how the work reduces handoffs across development, security, and operations.";
  }
  if (intent.id === "overview") {
    return "For a candidate, the useful framing is: GitLab is both a DevSecOps product platform and a company that documents its operating model publicly.";
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
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
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
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    }
  );

  if (!response.ok) return null;
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

async function maybeGenerateWithLlm(question, matches, draftAnswer) {
  for (const generate of [generateWithOpenAI, generateWithGemini]) {
    try {
      const answer = await generate(question, matches, draftAnswer);
      if (answer) return answer;
    } catch {
      // Keep retrieval mode reliable even when an optional LLM provider fails.
    }
  }
  return null;
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
    query: {
      topics: result.queryProfile.topics.map((topic) => topic.id),
      domainTokens: result.queryProfile.domainTokens,
      ambiguousTokens: result.queryProfile.ambiguousTokens,
      enoughContext: result.queryProfile.enoughContext,
    },
    answerability: assessAnswerability(result),
    matches: sourceSummary(result.matches),
  };
}

export async function answerQuestion(question, history = []) {
  const historyContext = compactHistory(history, question);
  const routedQuestion = historyContext ? `${question} ${historyContext}` : question;

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

  if (needsClarification(routedQuestion)) {
    return {
      answer: buildClarificationAnswer(routedQuestion),
      confidence: "medium",
      sources: [],
      mode: "clarification",
      intent: "Clarification needed",
    };
  }

  if (!hasDomainSignal(routedQuestion)) {
    return {
      answer:
        "I could not find enough support in the loaded GitLab Handbook and Direction material to answer that confidently. Try asking about what GitLab is, remote work, transparency, values, product direction, DevSecOps, GitLab Duo, or handbook-first work.",
      confidence: "low",
      sources: [],
      mode: "retrieval",
      intent: "Out of scope",
    };
  }

  const result = await retrieve(question, history, 8);
  const sourceMatches = sourceSummary(result.matches);
  const topScore = result.matches[0]?.score || 0;
  const answerability = assessAnswerability(result);

  if (!sourceMatches.length || topScore < 0.12 || !answerability.answerable) {
    return {
      answer:
        "I could not find enough support in the loaded GitLab Handbook and Direction material to answer that confidently. Try asking about remote work, transparency, values, product direction, DevSecOps, GitLab Duo, or handbook-first work.",
      confidence: "low",
      sources: [],
      mode: "retrieval",
      intent: result.intent.label,
      diagnostics: {
        answerability,
        topics: result.queryProfile.topics.map((topic) => topic.id),
      },
    };
  }

  const draftAnswer = buildAnswer(question, result.matches, result.intent, result.topics);
  const llmAnswer = await maybeGenerateWithLlm(question, result.matches, draftAnswer);
  const broadMatch = isBroadMatch(result.matches, result.topics);

  return {
    answer: llmAnswer || draftAnswer,
    confidence: broadMatch ? "medium" : topScore > 0.72 ? "high" : topScore > 0.34 ? "medium" : "low",
    sources: sourceMatches.slice(0, 5),
    mode: llmAnswer ? "LLM + RAG" : "retrieval",
    intent: result.intent.label,
    diagnostics: {
      answerability,
      topics: result.queryProfile.topics.map((topic) => topic.id),
    },
  };
}
