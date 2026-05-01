# GitLab Handbook Chatbot

A GenAI/RAG chatbot for answering employee and candidate questions from GitLab's public Handbook and Direction material.

It is designed to stand out in a crowded candidate pool by combining a polished chat UI, transparent source citations, measurable evaluation, guardrails, and optional LLM generation.

## Features

- **Hybrid retrieval** over curated GitLab Handbook and Direction sources.
- **Query understanding layer** that separates real GitLab questions from vague keyword-only prompts.
- **Chunk-level scoring** using BM25, TF-IDF cosine similarity, tag overlap, source weights, intent boosts, and full-query overlap.
- **Answerability checks** that refuse or clarify when retrieved evidence is too weak.
- **Conversation-aware follow-ups** using recent chat history.
- **Transparency UI** with confidence, mode, relevant source sections, and source links.
- **Guardrails** for unsupported questions and prompt-injection attempts.
- **Optional LLM mode** with OpenAI or Gemini.
- **Evaluation harness** with `npm run eval`.
- **Zero runtime dependencies**, so it is simple to run and deploy.

## Quick Start

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:3000
```

If port `3000` is busy:

```bash
PORT=3001 npm run dev
```

## Quality Checks

```bash
npm test
npm run eval
```

Or run the complete verification command:

```bash
npm run verify
```

Expected evaluation result:

```text
Positive evaluation: 16/16 passed
Negative/guardrail evaluation: 6/6 passed
```

## Optional LLM Mode

The app works without any API key. To enable generated final wording, set either provider:

```bash
cp .env.example .env
export OPENAI_API_KEY="your_key"
npm run dev
```

or:

```bash
export GEMINI_API_KEY="your_key"
export GEMINI_MODEL="gemini-2.5-flash"
npm run dev
```

The model only receives retrieved source context and is instructed not to invent unsupported policies. If the optional LLM provider fails or times out, the app falls back to deterministic retrieval mode.

## Data Refresh

The curated source set lives in `data/sources.json`.

To fetch controlled public GitLab pages into a review file:

```bash
npm run ingest
```

This writes `data/sources.generated.json` and `data/ingestion-report.json`. The production chatbot does not read generated files automatically; review the generated source cards before copying selected entries into `data/sources.json`.

Useful options:

```bash
npm run ingest -- --max-pages=10
npm run ingest -- --no-crawl
npm run ingest -- --dry-run --max-pages=6
```

See `docs/DATA_REFRESH.md` for the full review workflow.

## Project Structure

```text
.
├── data/sources.json        # Curated GitLab Handbook and Direction knowledge base
├── docs/                    # Architecture, diagrams, data refresh, and deployment notes
├── public/                  # Browser UI
├── scripts/evaluate.js      # Retrieval/answer quality evaluation
├── scripts/ingest.js        # Controlled public page ingestion pipeline
├── src/chatbot.js           # RAG orchestration, ranking, answer generation
├── src/queryAnalysis.js     # Query intent, ambiguity, and clarification policy
├── src/ragConfig.js         # Domain rules, synonyms, topics, and intents
├── src/textProcessing.js    # Tokenization and normalization
├── test/chatbot.test.js     # Node test suite
├── server.js                # Dependency-free Node HTTP server
└── PROJECT_WRITEUP.md       # Submission write-up
```

## Deployment

See `docs/DEPLOYMENT.md`.

Fastest path:

1. Push to GitHub.
2. Deploy on Render using `render.yaml`.
3. Optional: add `GEMINI_API_KEY` or `OPENAI_API_KEY`.
4. Run the smoke-test questions in `SUBMISSION_CHECKLIST.md`.
5. Submit the deployed URL.

## Submission

See `SUBMISSION_CHECKLIST.md` for the exact final steps.
