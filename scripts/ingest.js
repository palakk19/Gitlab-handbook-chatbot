import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const DEFAULT_SEEDS = ["https://handbook.gitlab.com/", "https://about.gitlab.com/"];
const DEFAULT_MAX_PAGES = 24;
const DEFAULT_DELAY_MS = 350;
const DEFAULT_TIMEOUT_MS = 15_000;
const ALLOWED_HOSTS = new Set(["handbook.gitlab.com", "about.gitlab.com"]);
const BINARY_EXTENSIONS = /\.(?:7z|avi|css|csv|docx?|eot|gif|gz|ico|jpeg|jpg|js|json|mov|mp3|mp4|pdf|png|pptx?|rar|svg|tar|tgz|ttf|webm|webp|woff2?|xlsx?|zip)$/i;
const BOILERPLATE_PATTERNS = [
  /^edit this page$/i,
  /^last modified/i,
  /^on this page$/i,
  /^skip to content$/i,
  /^sign in$/i,
  /^search$/i,
  /^table of contents$/i,
  /^view page source$/i,
  /^contribute to this page$/i,
  /^copy link$/i,
  /^gitlab handbook$/i,
  /^gitlab\.com$/i,
];

const STOP_WORDS = new Set([
  "a",
  "about",
  "also",
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
  "has",
  "have",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "we",
  "with",
  "you",
  "your",
]);

function printHelp() {
  console.log(`Usage: npm run ingest -- [options]

Generates reviewed candidate source cards from public GitLab pages.
It does not modify data/sources.json.

Options:
  --seed=<url>          Seed URL to crawl. Can be passed multiple times.
  --max-pages=<number>  Maximum pages to fetch. Default: ${DEFAULT_MAX_PAGES}
  --delay-ms=<number>   Delay between requests. Default: ${DEFAULT_DELAY_MS}
  --timeout-ms=<number> Fetch timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --output=<path>       Generated source file. Default: data/sources.generated.json
  --report=<path>       Ingestion report file. Default: data/ingestion-report.json
  --no-crawl            Fetch only seed URLs.
  --dry-run             Fetch and summarize, but do not write files.
  --help                Show this message.
`);
}

function parseArgs(argv) {
  const options = {
    seeds: [],
    maxPages: Number(process.env.INGEST_MAX_PAGES || DEFAULT_MAX_PAGES),
    delayMs: Number(process.env.INGEST_DELAY_MS || DEFAULT_DELAY_MS),
    timeoutMs: Number(process.env.INGEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    output: "data/sources.generated.json",
    report: "data/ingestion-report.json",
    crawl: true,
    dryRun: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-crawl") {
      options.crawl = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg.startsWith("--seed=")) {
      options.seeds.push(arg.slice("--seed=".length));
    } else if (arg.startsWith("--max-pages=")) {
      options.maxPages = Number(arg.slice("--max-pages=".length));
    } else if (arg.startsWith("--delay-ms=")) {
      options.delayMs = Number(arg.slice("--delay-ms=".length));
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg.startsWith("--report=")) {
      options.report = arg.slice("--report=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.seeds = options.seeds.length ? options.seeds : DEFAULT_SEEDS;

  if (!Number.isFinite(options.maxPages) || options.maxPages < 1) {
    throw new Error("--max-pages must be a positive number");
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error("--delay-ms must be zero or greater");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be at least 1000");
  }

  return options;
}

function resolveProjectPath(path) {
  return resolve(projectRoot, path);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function normalizeWhitespace(value) {
  return decodeEntities(value)
    .replace(/\s+/g, " ")
    .trim();
}

function removeTags(value) {
  return normalizeWhitespace(value.replace(/<[^>]+>/g, " "));
}

function extractBetween(html, tagName) {
  const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1] || "";
}

function extractMainHtml(html) {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");

  const main = extractBetween(withoutNoise, "main") || extractBetween(withoutNoise, "article") || extractBetween(withoutNoise, "body") || withoutNoise;

  return main
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ");
}

function extractTitle(html, mainHtml, url) {
  const h1 = mainHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const fallback = new URL(url).pathname.split("/").filter(Boolean).pop() || new URL(url).hostname;
  return removeTags(h1 || title || fallback)
    .replace(/\s+\|?\s*GitLab\s*$/i, "")
    .replace(/\s+\|?\s*The GitLab Handbook\s*$/i, "")
    .trim();
}

function htmlToBlocks(mainHtml) {
  const blockSeparated = mainHtml
    .replace(/<\/(?:h[1-6]|p|li|blockquote|tr|section|article|div)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, " - ");

  return blockSeparated
    .replace(/<[^>]+>/g, " ")
    .split(/\n+/)
    .map(normalizeWhitespace)
    .filter(Boolean);
}

function isUsefulBlock(block) {
  const words = block.split(/\s+/).length;
  if (words < 5 || block.length < 35) return false;
  if (block.length > 700) return false;
  if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(block))) return false;
  if (/^https?:\/\//i.test(block)) return false;
  return /[a-zA-Z]/.test(block);
}

function splitSentences(blocks) {
  return blocks.flatMap((block) => {
    const sentences = block.match(/[^.!?]+[.!?]+/g) || [block];
    return sentences.map(normalizeWhitespace);
  });
}

function uniqByNormalized(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function scoreSentence(sentence) {
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const term of [
    "gitlab",
    "handbook",
    "remote",
    "async",
    "asynchronous",
    "merge request",
    "issue",
    "ci/cd",
    "devsecops",
    "security",
    "direction",
    "value",
    "customer",
    "documentation",
    "team",
    "workflow",
  ]) {
    if (lower.includes(term)) score += 1;
  }
  if (sentence.length >= 80 && sentence.length <= 260) score += 1;
  return score;
}

function selectSummary(blocks) {
  return (
    blocks.find((block) => block.length >= 80 && block.length <= 320) ||
    blocks.find((block) => block.length >= 50 && block.length <= 450) ||
    blocks[0] ||
    ""
  ).replace(/\s+/g, " ");
}

function selectHighlights(blocks) {
  const sentences = splitSentences(blocks)
    .filter((sentence) => sentence.length >= 70 && sentence.length <= 280)
    .sort((a, b) => scoreSentence(b) - scoreSentence(a));

  const selected = uniqByNormalized(sentences).slice(0, 5);
  if (selected.length >= 3) return selected;

  return uniqByNormalized([...selected, ...blocks.filter((block) => block.length <= 300)]).slice(0, 5);
}

function tokenizeForTags(value) {
  return value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
}

function createTags(title, url, blocks) {
  const urlParts = new URL(url).pathname.split("/").filter(Boolean);
  const counts = new Map();

  for (const token of [...tokenizeForTags(title), ...urlParts.flatMap(tokenizeForTags), ...tokenizeForTags(blocks.slice(0, 6).join(" "))]) {
    if (STOP_WORDS.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token]) => token)
    .slice(0, 14);
}

function categoryForUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname === "handbook.gitlab.com") return "Handbook";
  if (parsed.pathname.startsWith("/direction")) return "Direction";
  return "Overview";
}

function idForUrl(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "").replace(/\W+/g, "-").replace(/-com$/, "");
  const path = parsed.pathname
    .replace(/\/$/, "")
    .split("/")
    .filter(Boolean)
    .join("-")
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
  return `generated-${host}${path ? `-${path}` : "-home"}`;
}

function employeeUseCaseFor(category, title) {
  if (category === "Direction") {
    return `Candidates and employees can use this page to understand how GitLab frames ${title.toLowerCase()} in its product direction and DevSecOps strategy.`;
  }
  if (category === "Handbook") {
    return `Employees and candidates can use this page to understand how ${title.toLowerCase()} shows up in GitLab's public operating model and day-to-day work.`;
  }
  return `Candidates can use this page to explain GitLab clearly and connect company context to product, operating model, and customer workflows.`;
}

export function extractDocument(html, url) {
  const mainHtml = extractMainHtml(html);
  const title = extractTitle(html, mainHtml, url);
  const blocks = uniqByNormalized(htmlToBlocks(mainHtml).filter(isUsefulBlock));
  const summary = selectSummary(blocks);
  const highlights = selectHighlights(blocks);
  const category = categoryForUrl(url);

  return {
    id: idForUrl(url),
    title,
    category,
    url,
    summary,
    employeeUseCase: employeeUseCaseFor(category, title),
    highlights,
    tags: createTags(title, url, blocks),
    lastReviewed: new Date().toISOString().slice(0, 10),
    ingestion: {
      needsReview: true,
      textBlocks: blocks.length,
      contentCharacters: blocks.join(" ").length,
    },
  };
}

function normalizeUrl(candidate, baseUrl) {
  try {
    const parsed = new URL(candidate, baseUrl);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase();

    if (parsed.protocol !== "https:") return null;
    if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;
    if (BINARY_EXTENSIONS.test(parsed.pathname)) return null;
    if (parsed.pathname.includes("/search")) return null;
    if (parsed.pathname.includes("/blog/")) return null;
    if (parsed.pathname.includes("/press/")) return null;
    if (parsed.pathname.includes("/jobs/")) return null;
    if (parsed.pathname.includes("/events/")) return null;
    if (parsed.pathname.includes("/company/contact/")) return null;
    if (parsed.hostname === "handbook.gitlab.com" && parsed.pathname !== "/" && !parsed.pathname.startsWith("/handbook/")) {
      return null;
    }
    if (
      parsed.hostname === "about.gitlab.com" &&
      parsed.pathname !== "/" &&
      !parsed.pathname.startsWith("/direction/") &&
      !parsed.pathname.startsWith("/company/")
    ) {
      return null;
    }

    if (!parsed.pathname.endsWith("/")) {
      const lastSegment = parsed.pathname.split("/").pop() || "";
      if (!lastSegment.includes(".")) parsed.pathname = `${parsed.pathname}/`;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export function discoverLinks(html, baseUrl) {
  const links = [];
  const linkHtml = extractMainHtml(html);
  const linkRegex = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1/gi;
  let match;

  while ((match = linkRegex.exec(linkHtml))) {
    const normalized = normalizeUrl(match[2], baseUrl);
    if (normalized) links.push(normalized);
  }

  return uniqByNormalized(links);
}

function urlPriority(url) {
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();
  let priority = 50;

  if (DEFAULT_SEEDS.includes(url)) priority -= 30;
  if (path === "/") priority -= 20;
  if (path.includes("/direction")) priority -= 10;
  if (path.includes("/handbook/values")) priority -= 9;
  if (path.includes("communication")) priority -= 8;
  if (path.includes("all-remote")) priority -= 8;
  if (path.includes("onboarding")) priority -= 6;
  if (path.includes("directly-responsible")) priority -= 6;
  if (path.includes("security")) priority -= 4;
  if (path.includes("merge-request")) priority -= 4;
  if (path.includes("devsecops")) priority -= 4;

  priority += path.split("/").filter(Boolean).length;
  return priority;
}

function enqueue(queue, queued, urls, limit) {
  for (const url of urls.sort((a, b) => urlPriority(a) - urlPriority(b) || a.localeCompare(b))) {
    if (queued.has(url)) continue;
    if (queued.size >= limit * 12) break;
    queued.add(url);
    queue.push(url);
  }
  queue.sort((a, b) => urlPriority(a) - urlPriority(b) || a.localeCompare(b));
}

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "gitlab-handbook-chatbot-ingester/1.0 (+reviewed candidate project)",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function createReport(options, documents, fetched, skipped, failures) {
  return {
    generatedAt: new Date().toISOString(),
    seeds: options.seeds,
    maxPages: options.maxPages,
    crawlEnabled: options.crawl,
    output: options.output,
    sourceCount: documents.length,
    fetched,
    skipped,
    failures,
    reviewInstructions: [
      "Open data/sources.generated.json and inspect each generated source card.",
      "Keep only pages with clean summaries, useful highlights, and official GitLab context.",
      "Copy reviewed cards into data/sources.json manually, then run npm run verify.",
      "Do not merge the generated file directly into production without review.",
    ],
  };
}

export async function runIngestion(options) {
  const fetched = [];
  const skipped = [];
  const failures = [];
  const documents = [];
  const queue = [];
  const queued = new Set();
  const visited = new Set();

  enqueue(queue, queued, options.seeds.map((seed) => normalizeUrl(seed, seed)).filter(Boolean), options.maxPages);

  while (queue.length && fetched.length < options.maxPages) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    console.log(`Fetching ${url}`);

    try {
      const html = await fetchHtml(url, options.timeoutMs);
      fetched.push(url);

      const document = extractDocument(html, url);
      if (!document.summary || document.ingestion.contentCharacters < 500 || document.highlights.length < 2) {
        skipped.push({
          url,
          reason: "Not enough clean page content after boilerplate removal",
          contentCharacters: document.ingestion.contentCharacters,
          highlights: document.highlights.length,
        });
      } else {
        documents.push(document);
      }

      if (options.crawl) {
        enqueue(queue, queued, discoverLinks(html, url), options.maxPages);
      }
    } catch (error) {
      failures.push({ url, error: error.message });
      console.warn(`Skipped ${url}: ${error.message}`);
    }

    if (queue.length && fetched.length < options.maxPages && options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  const report = createReport(options, documents, fetched, skipped, failures);

  if (options.dryRun) {
    console.log(JSON.stringify(report, null, 2));
    return { documents, report };
  }

  await writeFile(resolveProjectPath(options.output), JSON.stringify(documents, null, 2));
  await writeFile(resolveProjectPath(options.report), JSON.stringify(report, null, 2));

  console.log(`Wrote ${options.output} with ${documents.length} generated source cards.`);
  console.log(`Wrote ${options.report}. Review generated cards before editing data/sources.json.`);

  return { documents, report };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await runIngestion(options);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
