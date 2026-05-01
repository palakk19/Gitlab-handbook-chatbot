const messages = document.querySelector("#messages");
const form = document.querySelector("#chatForm");
const input = document.querySelector("#questionInput");
const suggestions = document.querySelector("#suggestions");
const suggestionToggle = document.querySelector("#suggestionToggle");
const sourceList = document.querySelector("#sourceList");
const catalogList = document.querySelector("#catalogList");
const modeLabel = document.querySelector("#modeLabel");
const confidenceLabel = document.querySelector("#confidenceLabel");
const sourceCount = document.querySelector("#sourceCount");
const chunkCount = document.querySelector("#chunkCount");
const clearButton = document.querySelector("#clearButton");

let history = [];

function markdownToHtml(text) {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("- ")) return `<li>${escapeHtml(line.slice(2))}</li>`;
      if (!line.trim()) return "";
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("")
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>");
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char];
  });
}

function createAnswerLabel(mode, sources = []) {
  if (mode === "guardrail") return "Safety guardrail";
  if (mode === "clarification") return "Clarification needed";
  if (mode === "LLM + RAG") return "Answered using LLM + RAG";
  if (!sources.length) return "Retrieval fallback";

  const topSource = sources[0];
  const category = topSource.category || "GitLab source";
  if (category === "Overview") return "Retrieved from GitLab public overview";
  if (category === "Handbook") return "Retrieved from GitLab public handbook";
  if (category === "Direction") return "Retrieved from GitLab public direction";
  if (category === "GitLab Docs") return "Retrieved from GitLab public docs";
  return `Retrieved from GitLab public ${category.toLowerCase()}`;
}

function addMessage(role, content, sources = [], meta = {}) {
  const node = document.createElement("article");
  node.className = `message ${role}`;

  if (role === "assistant") {
    const label = document.createElement("div");
    label.className = "answer-label";
    label.textContent = createAnswerLabel(meta.mode, sources);
    node.append(label);
  }

  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = markdownToHtml(content);
  node.append(body);

  if (sources.length) {
    const sourceBlock = document.createElement("div");
    sourceBlock.className = "sources";
    sourceBlock.innerHTML = sources
      .map((source) => {
        const sections = source.sections?.length ? ` · ${escapeHtml(source.sections.join(", "))}` : "";
        return `<div><a href="${source.url}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a><span>${escapeHtml(source.category)} · relevance ${source.score}${sections}</span></div>`;
      })
      .join("");
    node.append(sourceBlock);
  }

  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}

async function ask(question) {
  const priorHistory = [...history];
  addMessage("user", question);
  history.push({ role: "user", content: question });
  input.value = "";

  const pending = addMessage("assistant pending", "Searching GitLab Handbook and Direction sources...");
  form.querySelector("button").disabled = true;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history: priorHistory }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Request failed.");

    pending.remove();
    addMessage("assistant", payload.answer, payload.sources, { mode: payload.mode });
    history.push({ role: "assistant", content: payload.answer });
    renderSources(payload.sources);
    modeLabel.textContent = payload.mode;
    confidenceLabel.textContent = payload.confidence;
  } catch (error) {
    pending.remove();
    addMessage("assistant", error.message || "I could not answer that right now.");
  } finally {
    form.querySelector("button").disabled = false;
    input.focus();
  }
}

function renderSources(sources) {
  sourceList.innerHTML = "";
  if (!sources.length) {
    const item = document.createElement("li");
    item.textContent = "No source passed the confidence threshold.";
    sourceList.append(item);
    return;
  }
  for (const source of sources) {
    const item = document.createElement("li");
    const sections = source.sections?.length ? `<span>${escapeHtml(source.sections.join(", "))}</span>` : "";
    item.innerHTML = `<a href="${source.url}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a>${escapeHtml(source.category)} · score ${source.score}${sections}`;
    sourceList.append(item);
  }
}

async function boot() {
  addMessage(
    "assistant",
    "Ask a question about GitLab's handbook, remote operating model, values, or product direction. I will answer with the evidence used."
  );

  const [suggestionResponse, healthResponse, sourcesResponse] = await Promise.all([
    fetch("/api/suggestions"),
    fetch("/api/health"),
    fetch("/api/sources"),
  ]);
  const suggestionPayload = await suggestionResponse.json();
  const healthPayload = await healthResponse.json();
  const sourcesPayload = await sourcesResponse.json();

  sourceCount.textContent = String(healthPayload.sourceCount || 0);
  chunkCount.textContent = String(healthPayload.chunkCount || 0);
  renderCatalog(sourcesPayload.sources || []);
  suggestions.innerHTML = "";
  for (const suggestion of suggestionPayload.suggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = suggestion;
    button.addEventListener("click", () => {
      closeSuggestions();
      ask(suggestion);
    });
    suggestions.append(button);
  }
}

function renderCatalog(sources) {
  catalogList.innerHTML = "";
  for (const source of sources.slice(0, 7)) {
    const item = document.createElement("li");
    item.innerHTML = `<a href="${source.url}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a>${escapeHtml(source.category)}`;
    catalogList.append(item);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = input.value.trim();
  if (question) ask(question);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

function closeSuggestions() {
  suggestions.hidden = true;
  suggestionToggle.setAttribute("aria-expanded", "false");
}

suggestionToggle.addEventListener("click", () => {
  const willOpen = suggestions.hidden;
  suggestions.hidden = !willOpen;
  suggestionToggle.setAttribute("aria-expanded", String(willOpen));
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".suggestion-menu")) closeSuggestions();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSuggestions();
});

clearButton.addEventListener("click", () => {
  history = [];
  messages.innerHTML = "";
  sourceList.innerHTML = "";
  confidenceLabel.textContent = "Ready";
  modeLabel.textContent = "Retrieval";
  boot();
});

boot();
