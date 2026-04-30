import { answerQuestion, retrieveForEvaluation } from "../src/chatbot.js";

const cases = [
  {
    question: "How does GitLab make remote work effective?",
    expectedSources: ["all-remote", "communication"],
    expectedTerms: ["asynchronous", "documentation", "time zones"],
  },
  {
    question: "What should a candidate know about GitLab values?",
    expectedSources: ["values"],
    expectedTerms: ["transparency", "iteration", "candidate"],
  },
  {
    question: "How does GitLab product direction connect to DevSecOps?",
    expectedSources: ["direction-home", "devsecops-platform"],
    expectedTerms: ["DevSecOps", "platform", "strategy"],
  },
  {
    question: "What guardrails exist around transparency?",
    expectedSources: ["transparency"],
    expectedTerms: ["guardrails", "sensitive", "information"],
  },
  {
    question: "How does AI fit into GitLab direction?",
    expectedSources: ["ai-powered-devsecops", "gitlab-duo"],
    expectedTerms: ["AI", "workflow", "DevSecOps"],
  },
];

function includesAnySource(actual, expected) {
  const ids = actual.map((source) => source.id);
  return expected.some((sourceId) => ids.includes(sourceId));
}

function includesTerms(answer, terms) {
  const normalized = answer.toLowerCase();
  return terms.filter((term) => normalized.includes(term.toLowerCase()));
}

let passed = 0;
const rows = [];

for (const testCase of cases) {
  const answer = await answerQuestion(testCase.question);
  const retrieval = await retrieveForEvaluation(testCase.question);
  const matchedTerms = includesTerms(answer.answer, testCase.expectedTerms);
  const sourcePass = includesAnySource(answer.sources, testCase.expectedSources);
  const termPass = matchedTerms.length >= Math.min(2, testCase.expectedTerms.length);
  const pass = sourcePass && termPass && answer.confidence !== "low";

  if (pass) passed += 1;

  rows.push({
    question: testCase.question,
    pass,
    confidence: answer.confidence,
    intent: answer.intent,
    topSources: answer.sources.map((source) => source.title).join(", "),
    matchedTerms,
    retrievalIntent: retrieval.intent.label,
  });
}

console.table(rows);
console.log(`\nEvaluation: ${passed}/${cases.length} passed`);

if (passed !== cases.length) {
  process.exitCode = 1;
}
