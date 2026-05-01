import { AMBIGUOUS_KEYWORD_TERMS, DOMAIN_TERMS, INTENTS, TOPIC_RULES } from "./ragConfig.js";
import { canonicalizeText, rawTokens, tokenize, unique } from "./textProcessing.js";

const ACTION_OR_QUESTION_PATTERN =
  /\?|^\s*(how|what|why|when|where|can|could|should|would|do|does|is|are)\b|\b(tell|explain|define|describe|give|show|use|create|add|assign|raise|open|make|handle|prioritize|prepare|mean|connect|fit|allowed|review|approve|merge|track|plan|comment|discuss|reply|mention|resolve|suggest)\b/;

export function matchTopics(question) {
  const normalized = canonicalizeText(question);
  return TOPIC_RULES.filter((topic) => topic.pattern.test(normalized));
}

export function inferIntent(question) {
  const routedTopic = matchTopics(question)[0];
  if (routedTopic?.id === "overview") return INTENTS.find((intent) => intent.id === "overview");
  if (["async", "remote"].includes(routedTopic?.id)) return INTENTS.find((intent) => intent.id === "remote");
  if (
    [
      "ai",
      "product",
      "ci-cd",
      "security",
      "planning",
      "comments",
      "merge-request",
      "merge-request-reviewers",
      "merge-request-comments",
      "issues",
    ].includes(routedTopic?.id)
  ) {
    return INTENTS.find((intent) => intent.id === "product");
  }
  if (["handbook-first", "decision", "onboarding"].includes(routedTopic?.id)) {
    return INTENTS.find((intent) => intent.id === "process");
  }
  if (routedTopic?.id === "values") return INTENTS.find((intent) => intent.id === "culture");

  const tokens = tokenize(question);
  const scores = INTENTS.map((intent) => ({
    ...intent,
    score: intent.terms.reduce((sum, term) => sum + tokens.filter((token) => token === term).length, 0),
  })).sort((a, b) => b.score - a.score || a.terms.length - b.terms.length);

  return scores[0]?.score ? scores[0] : { id: "general", label: "General handbook search", score: 0 };
}

export function inferIntents(question) {
  const tokens = tokenize(question);
  return INTENTS.map((intent) => ({
    ...intent,
    score: intent.terms.reduce((sum, term) => sum + tokens.filter((token) => token === term).length, 0),
  }))
    .filter((intent) => intent.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function hasPromptInjection(question) {
  return /ignore (all|the|previous)|system prompt|developer message|reveal.*instruction|jailbreak/i.test(question);
}

export function hasDomainSignal(question) {
  return matchTopics(question).length > 0;
}

export function hasQuestionIntent(question) {
  return ACTION_OR_QUESTION_PATTERN.test(canonicalizeText(question));
}

export function hasExplicitGitLabContext(question) {
  return /\b(gitlab|devsecops|handbook|merge request|merge requests|work item|work items|ci\/cd|cicd|gitlab duo|all[- ]remote)\b/i.test(
    canonicalizeText(question)
  );
}

export function analyzeQuery(question) {
  const tokens = unique(rawTokens(question));
  const topics = matchTopics(question);
  const domainTokens = tokens.filter((token) => DOMAIN_TERMS.has(token));
  const ambiguousTokens = tokens.filter((token) => AMBIGUOUS_KEYWORD_TERMS.has(token));
  const nonDomainTokens = tokens.filter((token) => !DOMAIN_TERMS.has(token));
  const questionIntent = hasQuestionIntent(question);
  const explicitGitLabContext = hasExplicitGitLabContext(question);
  const keywordOnly =
    tokens.length > 0 && tokens.length <= 2 && domainTokens.length > 0 && !ACTION_OR_QUESTION_PATTERN.test(question);

  const enoughContext =
    topics.some((topic) => topic.id === "overview") ||
    (topics.some((topic) => topic.id === "comments") && (questionIntent || explicitGitLabContext)) ||
    (explicitGitLabContext && questionIntent) ||
    (!keywordOnly && questionIntent && nonDomainTokens.length >= 1) ||
    (!keywordOnly && explicitGitLabContext && nonDomainTokens.length >= 1) ||
    (!keywordOnly && domainTokens.length >= 2 && nonDomainTokens.length >= 2);

  return {
    tokens,
    topics,
    domainTokens,
    ambiguousTokens,
    nonDomainTokens,
    questionIntent,
    explicitGitLabContext,
    keywordOnly,
    enoughContext,
  };
}

export function shouldUseHistory(question) {
  const normalized = canonicalizeText(question);
  const tokenCount = tokenize(question).length;
  const topics = matchTopics(question);
  if (topics.some((topic) => topic.id === "overview")) return false;
  if (/^\s*(what|who|define|tell me about)\s+is?\s+gitlab\b/.test(normalized)) return false;

  return (
    tokenCount <= 4 ||
    /\b(that|this|it|they|them|those|same|above|earlier|previous|you mentioned)\b/.test(normalized) ||
    /^(what about|how about|why|can you explain|tell me more|expand on)\b/.test(normalized)
  );
}

export function compactHistory(history, question) {
  if (!shouldUseHistory(question)) return "";

  return history
    .filter((message) => message?.role === "user")
    .map((message) => String(message.content || "").trim())
    .filter((content) => content && content.toLowerCase() !== question.toLowerCase().trim())
    .slice(-2)
    .join(" ");
}

export function needsClarification(question) {
  const profile = analyzeQuery(question);
  if (!profile.topics.length) return profile.ambiguousTokens.length > 0 && !profile.explicitGitLabContext;
  return !profile.enoughContext;
}

export function buildClarificationAnswer(question) {
  if (/\bmr\b/i.test(question)) {
    return "MR usually means Merge Request in GitLab. Do you want to know what an MR is, how to create one, how to add reviewers, how review/approval works, or how it connects to CI/CD?";
  }

  const topics = matchTopics(question).map((topic) => topic.label.toLowerCase());
  const topicHint = topics.length ? ` I noticed ${topics.slice(0, 2).join(" and ")}, but the request is too vague.` : "";
  return `I need a little more GitLab-specific context before I retrieve an answer.${topicHint} Try asking a complete question, such as "How does GitLab use this?", "Can I create this?", or "What steps should I follow?"`;
}
