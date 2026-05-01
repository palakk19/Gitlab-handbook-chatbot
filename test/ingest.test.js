import assert from "node:assert/strict";
import test from "node:test";
import { discoverLinks, extractDocument } from "../scripts/ingest.js";

const sampleHtml = `
<!doctype html>
<html>
  <head><title>Merge request reviews | GitLab</title></head>
  <body>
    <nav><a href="/handbook/noise/">Navigation should not become content</a></nav>
    <main>
      <h1>Merge request reviews</h1>
      <p>GitLab merge requests support code review workflows where reviewers can discuss proposed changes, ask questions, and keep implementation context near the code.</p>
      <p>Review conversations are useful when feedback is specific, actionable, and connected to the changed line or file being discussed.</p>
      <p>Teams can resolve discussions after feedback is handled so the merge request shows what work is still open.</p>
      <a href="/handbook/engineering/workflow/code-review/">Code review</a>
      <a href="https://about.gitlab.com/direction/create/source_code_management/">Direction</a>
      <a href="https://example.com/not-allowed/">External</a>
      <a href="/assets/logo.svg">Asset</a>
    </main>
  </body>
</html>
`;

test("extractDocument creates a reviewable source card from useful page content", () => {
  const document = extractDocument(sampleHtml, "https://handbook.gitlab.com/handbook/engineering/workflow/merge-request-reviews/");

  assert.equal(document.id, "generated-handbook-gitlab-handbook-engineering-workflow-merge-request-reviews");
  assert.equal(document.title, "Merge request reviews");
  assert.equal(document.category, "Handbook");
  assert.match(document.summary, /merge requests support code review/i);
  assert.ok(document.highlights.length >= 3);
  assert.ok(document.tags.includes("merge"));
  assert.equal(document.ingestion.needsReview, true);
});

test("discoverLinks keeps only allowed GitLab HTML pages", () => {
  const links = discoverLinks(sampleHtml, "https://handbook.gitlab.com/handbook/engineering/workflow/merge-request-reviews/");

  assert.deepEqual(links, [
    "https://handbook.gitlab.com/handbook/engineering/workflow/code-review/",
    "https://about.gitlab.com/direction/create/source_code_management/",
  ]);
});
