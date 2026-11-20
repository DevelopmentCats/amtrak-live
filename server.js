// Amtrak Live — tiny proxy + static server.
// No dependencies: node builtins only. gzip + ETag + per-train endpoint.

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import crypto from "node:crypto";
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
const CACHE_TTL_MS = 15 * 1000;
const STALE_MAX_MS = 10 * 60 * 1000;

/** { at, goodAt, body } */
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
    req.setTimeout(12000, () => req.destroy(new Error("upstream timeout")));
  });
}

async function cachedJSON(key) {
  const entry = cache.get(key);
  const now = Date.now();
  if (entry && now - entry.at < CACHE_TTL_MS) return entry.body;
  try {
    const body = await fetchJSON(UPSTREAMS[key]);
    cache.set(key, { at: now, goodAt: now, body });
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

/** gzip + ETag + 304 support for a JSON object */
function sendJSON(req, res, obj, sMaxAge = 10) {
  const raw = Buffer.from(JSON.stringify(obj));
  const etag = `"${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16)}"`;
  const headers = { "Content-Type": "application/json", "Cache-Control": `public, max-age=${sMaxAge}`, ETag: etag };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  if ((req.headers["accept-encoding"] || "").includes("gzip")) {
    zlib.gzip(raw, { level: 6 }, (err, buf) => {
      if (err) {
        res.writeHead(200, headers);
        res.end(raw);
        return;
      }
      res.writeHead(200, { ...headers, "Content-Encoding": "gzip", "Content-Length": buf.length });
      res.end(buf);
    });
  } else {
    res.writeHead(200, { ...headers, "Content-Length": raw.length });
    res.end(raw);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  try {
    if (p === "/api/trains" || p === "/api/stations") {
      sendJSON(req, res, await cachedJSON(p.slice(5)), p === "/api/stations" ? 3600 : 10);
      return;
    }

    // /api/train/<number> -> just that train's instances (~KBs instead of 1.3 MB)
    const m = p.match(/^\/api\/train\/(\d+)$/);
    if (m) {
      const all = await cachedJSON("trains");
      const key = Object.keys(all).find(k => k === m[1] || k.split("-")[0] === m[1]);
      if (!key) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "train not running" }));
        return;
      }
      // slim the payload: drop fields the HUD never reads
      const slim = { [key]: all[key].map(t => {
        const { alerts, dataSource, provider, providerShort, onlyOfTrainNum, trainNumRaw, iconColor, textColor, stopIconColor, ...rest } = t;
        rest.stations = t.stations.map(s => {
          const { stopIconColor, ...rs } = s;
          return rs;
        });
        return rest;
      }) };
      sendJSON(req, res, slim, 10);
      return;
    }
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
    return;
  }

  // static files from public/
  let fp = normalize(p).replace(/^(\.[/\\])+/, "");
  if (fp === "/" || fp === "\\") fp = "/index.html";
  const file = join(__dirname, "public", fp);
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
