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
  {
    question: "How are decisions made at GitLab?",
    expectedSources: ["decision-making"],
    expectedTerms: ["ownership", "decision", "documented"],
  },
  {
    question: "How should new hires ramp up?",
    expectedSources: ["onboarding"],
    expectedTerms: ["onboarding", "handbook", "self-service"],
  },
  {
    question: "How does GitLab use merge requests?",
    expectedSources: ["merge-requests"],
    expectedTerms: ["merge requests", "code review", "collaboration"],
  },
  {
    question: "How do we add reviewers in the MR in GitLab?",
    expectedSources: ["merge-request-reviewers"],
    expectedTerms: ["reviewers", "merge request", "Reviewers field"],
  },
  {
    question: "How can we comment on the MR?",
    expectedSources: ["merge-request-comments"],
    expectedTerms: ["comment", "merge request", "thread"],
  },
  {
    question: "What is a comment in GitLab?",
    expectedSources: ["comments-discussions"],
    expectedTerms: ["comment", "discussion", "work"],
  },
  {
    question: "whta is gitlab?",
    expectedSources: ["gitlab-overview"],
    expectedTerms: ["DevSecOps", "platform", "software"],
  },
  {
    question: "Are we allowed to raise tickets in GitLab?",
    expectedSources: ["issues-work-items"],
    expectedTerms: ["Yes", "issues", "project"],
  },
  {
    question: "How does GitLab handle CI/CD?",
    expectedSources: ["ci-cd", "verify-stage"],
    expectedTerms: ["CI", "automation", "quality"],
  },
  {
    question: "How does GitLab think about security?",
    expectedSources: ["security-governance", "secure-stage"],
    expectedTerms: ["security", "risk", "workflow"],
  },
  {
    question: "How does GitLab prioritize product work?",
    expectedSources: ["planning-prioritization", "plan-stage"],
    expectedTerms: ["prioritization", "customer value", "ownership"],
  },
];

const negativeCases = [
  {
    question: "MR",
    expectedMode: "clarification",
  },
  {
    question: "What is MR",
    expectedMode: "clarification",
  },
  {
    question: "async",
    expectedMode: "clarification",
  },
  {
    question: "This sentence is intentionally random and only contains the word pipeline.",
    expectedMode: "clarification",
  },
  {
    question: "I am just writing random words with security included.",
    expectedMode: "clarification",
  },
  {
    question: "What is the cafeteria menu at GitLab today?",
    expectedMode: "retrieval",
    expectedConfidence: "low",
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

let negativePassed = 0;
const negativeRows = [];

for (const testCase of negativeCases) {
  const answer = await answerQuestion(testCase.question);
  const modePass = answer.mode === testCase.expectedMode;
  const confidencePass = testCase.expectedConfidence ? answer.confidence === testCase.expectedConfidence : true;
  const sourcesPass = testCase.expectedConfidence === "low" ? answer.sources.length === 0 : true;
  const pass = modePass && confidencePass && sourcesPass;

  if (pass) negativePassed += 1;

  negativeRows.push({
    question: testCase.question,
    pass,
    mode: answer.mode,
    confidence: answer.confidence,
    sources: answer.sources.map((source) => source.id).join(", "),
  });
}

console.table(rows);
console.log(`\nPositive evaluation: ${passed}/${cases.length} passed`);
console.table(negativeRows);
console.log(`\nNegative/guardrail evaluation: ${negativePassed}/${negativeCases.length} passed`);

if (passed !== cases.length || negativePassed !== negativeCases.length) {
  process.exitCode = 1;
}
