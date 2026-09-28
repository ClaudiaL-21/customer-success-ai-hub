import { createServer } from "node:http";
import { readFile, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;

// --- minimal .env loader (no dependency) --------------------------------
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const { default: analyzeHandler } = await import("./api/analyze.js");
const { default: approveActionHandler } = await import("./api/approve-action.js");
const { default: qbrExportHandler } = await import("./api/qbr-export.js");
const { default: accountsHandler } = await import("./api/accounts.js");
const API_ROUTES = {
  "/api/accounts": accountsHandler,
  "/api/analyze": analyzeHandler,
  "/api/approve-action": approveActionHandler,
  "/api/qbr-export": qbrExportHandler,
};

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  // Only published frontend assets are served. In particular, .env, .git,
  // migrations and backend source must never be retrievable through localhost
  // or a future demo tunnel.
  if (!/^\/(?:index\.html|favicon\.ico|src\/[A-Za-z0-9-]+\.(?:js|css)|assets\/(?:favicon-[0-9]+\.png|logo-[a-z-]+\.(?:png|jpg|svg)))$/.test(urlPath)) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const filePath = normalize(join(__dirname, urlPath));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
}

const server = createServer(async (req, res) => {
  const routePath = req.url.split("?")[0];
  const apiHandler = API_ROUTES[routePath];
  if (apiHandler) {
    let body = "";
    let tooLarge = false;
    req.on("data", chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 1_000_000) tooLarge = true;
    });
    req.on("end", async () => {
      if (tooLarge) { res.writeHead(413); res.end("Payload too large"); return; }
      try { req.body = body ? JSON.parse(body) : {}; }
      catch { res.writeHead(400); res.end("Invalid JSON"); return; }
      const shimRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        setHeader(k, v) { res.setHeader(k, v); },
        json(obj) { res.writeHead(this.statusCode, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); },
        // body is optional — QBR PPTX export uses this with a Buffer;
        // every other existing endpoint still calls end() with no args.
        end(body) { res.writeHead(this.statusCode); res.end(body); },
      };
      // local dev has no origin header from same-origin fetches in some browsers; default to allowed
      if (!req.headers.origin) req.headers.origin = `http://localhost:${PORT}`;
      try { await apiHandler(req, shimRes); }
      catch {
        if (!res.writableEnded) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Request failed" }));
        }
      }
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Account Health Copilot (local) — http://localhost:${PORT}`);
  console.log(`MOCK_AI=${process.env.MOCK_AI === "true" ? "on (no real API calls)" : "off"}`);
});
