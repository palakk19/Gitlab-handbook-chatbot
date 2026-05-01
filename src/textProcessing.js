import { STOP_WORDS, SYNONYMS } from "./ragConfig.js";

export function unique(tokens) {
  return [...new Set(tokens)];
}

export function normalizeToken(token) {
  if (token === "allremote") return "remote";
  if (token === "devsecops") return "devsecops";
  if (token === "kubernetes") return "kubernetes";
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("sions") && token.length > 7) return token.slice(0, -1);
  if (token.endsWith("ests") && token.length > 6) return token.slice(0, -1);
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

export function canonicalizeText(text) {
  return String(text)
    .toLowerCase()
    .replace(/\bwhta\b/g, "what")
    .replace(/\bwaht\b/g, "what")
    .replace(/\bwhats\b/g, "what is")
    .replace(/\bgit\s+lab\b/g, "gitlab")
    .replace(/\bmerge requests?\b/g, (match) => match)
    .trim();
}

export function rawTokens(text) {
  return (
    canonicalizeText(text)
      .replace(/all[- ]remote/g, "allremote")
      .replace(/ci\/cd/g, "cicd")
      .replace(/devsecops/g, "devsecops")
      .match(/[a-z0-9]+/g)
      ?.map(normalizeToken)
      .filter((token) => (token.length > 2 || ["ai", "ci", "cd", "mr"].includes(token)) && !STOP_WORDS.has(token)) ||
    []
  );
}

export function tokenize(text) {
  const baseTokens = rawTokens(text).filter((token) => token !== "mr" || /\bmr\b/i.test(text));

  const expanded = [];
  for (const token of baseTokens) {
    expanded.push(token);
    if (SYNONYMS[token]) expanded.push(...SYNONYMS[token]);
  }
  return expanded;
}
