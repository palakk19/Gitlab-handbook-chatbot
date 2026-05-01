# Data Refresh

The chatbot uses a curated production knowledge base at `data/sources.json`.

The ingestion pipeline is intentionally review-first. It can crawl selected public GitLab pages and generate candidate source cards, but it never edits the production knowledge base automatically.

## Why Review-First

Public websites contain navigation text, repeated page chrome, legal pages, marketing pages, and pages that are too broad for a focused RAG answer. A strong submission should show that generated knowledge is reviewed before it is used for answers.

## Generate Candidate Sources

```bash
npm run ingest
```

This fetches a controlled set of pages from:

- `https://handbook.gitlab.com/`
- `https://about.gitlab.com/`

It writes:

- `data/sources.generated.json`
- `data/ingestion-report.json`

Both files are ignored by Git because they are generated review artifacts.

## Useful Options

```bash
npm run ingest -- --max-pages=10
npm run ingest -- --no-crawl
npm run ingest -- --seed=https://handbook.gitlab.com/handbook/values/ --max-pages=5
npm run ingest -- --dry-run --max-pages=6
```

## Review Workflow

1. Run `npm run ingest`.
2. Open `data/ingestion-report.json` and check failures/skipped pages.
3. Open `data/sources.generated.json`.
4. Keep only generated cards with clean summaries, useful highlights, and official GitLab context.
5. Copy selected reviewed cards into `data/sources.json`.
6. Add or adjust topic rules in `src/ragConfig.js` only when the new source introduces a real new topic.
7. Add evaluation cases in `scripts/evaluate.js` for the questions the new source should answer.
8. Run:

```bash
npm run verify
```

Do not merge generated cards directly into production without review.

## Safe Defaults

- Only `handbook.gitlab.com` and `about.gitlab.com` are allowed.
- Binary files, search pages, blog pages, job pages, event pages, and unrelated external links are skipped.
- Requests are rate-limited with a short delay.
- Each generated source card includes `ingestion.needsReview: true`.
- The production chatbot still reads only `data/sources.json`.
