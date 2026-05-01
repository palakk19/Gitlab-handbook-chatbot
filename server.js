import http from "node:http";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { answerQuestion, getKnowledgeStats, getSources, getSuggestions } from "./src/chatbot.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((message) => ["user", "assistant"].includes(message?.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").slice(0, 4_000),
    }))
    .filter((message) => message.content.trim())
    .slice(-8);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function parseJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1_000_000) {
      throw new Error("Request body is too large.");
    }
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(req, res) {
  const requestedPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safePath = requestedPath === "/" ? "/index.html" : requestedPath;
  const filePath = normalize(join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const fileStats = await stat(filePath).catch(() => null);
  if (!fileStats?.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const extension = extname(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      sendJson(res, 200, { status: "ok", ...(await getKnowledgeStats()) });
      return;
    }

    if (req.method === "GET" && req.url === "/api/suggestions") {
      sendJson(res, 200, { suggestions: getSuggestions() });
      return;
    }

    if (req.method === "GET" && req.url === "/api/sources") {
      sendJson(res, 200, { sources: await getSources() });
      return;
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      const body = await parseJsonBody(req);
      const question = String(body.question || "").trim();
      const history = sanitizeHistory(body.history);

      if (question.length < 2) {
        sendJson(res, 400, { error: "Ask a question with at least two characters." });
        return;
      }

      if (question.length > 2_000) {
        sendJson(res, 400, { error: "Please ask a shorter question under 2,000 characters." });
        return;
      }

      const answer = await answerQuestion(question, history);
      sendJson(res, 200, answer);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      error: "Something went wrong while answering. Try again in a moment.",
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    console.error(`Open http://127.0.0.1:${port} if the app is already running, or start another port:`);
    console.error(`PORT=${port + 1} npm run dev`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`GitLab Handbook Chatbot running at http://${host}:${port}`);
});
