import { writeFile } from "node:fs/promises";

const pages = [
  "https://handbook.gitlab.com/",
  "https://handbook.gitlab.com/handbook/values/",
  "https://handbook.gitlab.com/handbook/company/culture/all-remote/",
  "https://handbook.gitlab.com/handbook/communication/",
  "https://about.gitlab.com/direction/",
];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 80 && sentence.length < 260)
    .slice(0, 4);
}

for (const url of pages) {
  console.log(`Fetching ${url}`);
}

const documents = [];
for (const url of pages) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  const html = await response.text();
  const text = stripHtml(html);
  const title = html.match(/<title>(.*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || url;
  const highlights = summarize(text);

  documents.push({
    title,
    category: url.includes("direction") ? "Direction" : "Handbook",
    url,
    summary: highlights[0]?.replace(/\.$/, ".") || text.slice(0, 220),
    highlights,
    tags: title.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 12) || [],
  });
}

await writeFile(new URL("../data/sources.generated.json", import.meta.url), JSON.stringify(documents, null, 2));
console.log("Wrote data/sources.generated.json. Review it, then copy selected entries into data/sources.json.");
