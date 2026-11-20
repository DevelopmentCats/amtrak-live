// Amtrak Live — tiny proxy + static server.
// No dependencies: node:http, node:https, node:fs only.

import http from "node:http";
import https from "node:https";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const UPSTREAMS = {
  trains: "https://api.amtraker.com/v3/trains",
  stations: "https://api.amtraker.com/v3/stations",
};
const CACHE_TTL_MS = 20 * 1000; // upstream poll cadence
const STALE_MAX_MS = 10 * 60 * 1000; // serve stale up to 10 min if upstream fails

/** Simple TTL cache: { at, body } */
const cache = new Map();

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "amtrak-live/1.0", Accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`upstream ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => {
      req.destroy(new Error("upstream timeout"));
    });
  });
}

async function cachedJSON(key) {
  const entry = cache.get(key);
  const now = Date.now();
  if (entry && now - entry.at < CACHE_TTL_MS) return entry.body;
  try {
    const body = await fetchJSON(UPSTREAMS[key]);
    cache.set(key, { at: now, body, goodAt: now });
    return body;
  } catch (err) {
    if (entry && now - entry.goodAt < STALE_MAX_MS) return entry.body;
    throw err;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/api/trains" || url.pathname === "/api/stations") {
    const key = url.pathname.slice(5);
    try {
      const body = await cachedJSON(key);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" });
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  // static files from public/
  let p = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  if (p === "/" || p === "\\") p = "/index.html";
  const file = join(__dirname, "public", p);
  if (!file.startsWith(join(__dirname, "public"))) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  if (existsSync(file) && statSync(file).isFile()) {
    const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(readFileSync(file));
    return;
  }
  // SPA fallback
  const index = join(__dirname, "public", "index.html");
  if (existsSync(index)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(index));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => console.log(`amtrak-live listening on :${PORT}`));
