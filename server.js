// Amtrak Live — proxy + static server + SSE live push.
// Node builtins only. Upstream is polled continuously; connected clients
// get an instant push whenever the data actually changes.

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
const POLL_MS = 8000;        // upstream refresher cadence
const CACHE_TTL_MS = 8000;
const STALE_MAX_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 15000;

/** { at, goodAt, body } */
const cache = new Map();
/** SSE subscribers: { res, num } */
const subs = new Set();
let lastHash = null;

/** breadcrumb trail per leg "A|B" — real track geometry, learned from live GPS fixes */
const legPts = new Map();
function recordLegs(all) {
  for (const inst of Object.values(all)) {
    for (const t of inst) {
      if (!t.lat || !t.lon || !Array.isArray(t.stations)) continue;
      const st = t.stations;
      let i = -1;
      st.forEach((s, k) => { if (/^departed$/i.test(s.status || "")) i = k; });
      if (i < 0) st.forEach((s, k) => { if (/^arrived$/i.test(s.status || "")) i = k; });
      const a = st[i] && st[i].code, b = st[i + 1] && st[i + 1].code;
      if (!a || !b) continue;
      const key = a + "|" + b;
      let arr = legPts.get(key);
      if (!arr) { arr = []; legPts.set(key, arr); }
      const la = +t.lat, lo = +t.lon;
      const last = arr[arr.length - 1];
      if (!last || Math.abs(last.la - la) + Math.abs(last.lo - lo) > 0.0005) {
        arr.push({ la, lo });
        if (arr.length > 4000) arr.splice(0, arr.length - 4000);
      }
    }
  }
}

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

/** slim a full payload down to one train number's instances */
function slimTrain(all, num) {
  const key = Object.keys(all).find(k => k === String(num) || k.split("-")[0] === String(num));
  if (!key) return null;
  return { [key]: all[key].map(t => {
    const { alerts, dataSource, provider, providerShort, onlyOfTrainNum, trainNumRaw, iconColor, textColor, ...rest } = t;
    rest.stations = (t.stations || []).map(s => {
      const { stopIconColor, ...rs } = s;
      return rs;
    });
    return rest;
  }) };
}

/* ---------------- background refresher + SSE broadcast ---------------- */
async function refreshUpstream() {
  let body;
  try {
    body = await fetchJSON(UPSTREAMS.trains);
  } catch {
    return; // keep serving stale from cache; subscribers just don't get pushes
  }
  const now = Date.now();
    cache.set("trains", { at: now, goodAt: now, body });
  recordLegs(body);
  if (subs.size === 0) return;
  const hash = crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex");
  if (hash === lastHash) return;
  lastHash = hash;
  for (const sub of subs) {
    const slim = slimTrain(body, sub.num);
    try {
      if (!slim) sub.res.write(`event: gone\ndata: {}\n\n`);
      else sub.res.write(`data: ${JSON.stringify(slim)}\n\n`);
    } catch { /* closed; cleanup happens on 'close' */ }
  }
}
setInterval(refreshUpstream, POLL_MS).unref?.();
refreshUpstream();

setInterval(() => {
  for (const sub of subs) {
    try { sub.res.write(`: hb\n\n`); } catch {}
  }
}, HEARTBEAT_MS).unref?.();

/* ---------------- http ---------------- */
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
      if (err) { res.writeHead(200, headers); res.end(raw); return; }
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
      sendJSON(req, res, await cachedJSON(p.slice(5)), p === "/api/stations" ? 3600 : 5);
      return;
    }

    // tiny index for the picker (~KBs): one row per running instance
    if (p === "/api/list") {
      const all = await cachedJSON("trains");
      const list = [];
      for (const inst of Object.values(all)) {
        for (const t of inst) {
          const st = t.stations || [];
          let i = -1;
          st.forEach((s, k) => { if (/^departed$/i.test(s.status || "")) i = k; });
          if (i < 0) st.forEach((s, k) => { if (/^arrived$/i.test(s.status || "")) i = k; });
          const nx = st[i + 1];
          const late = nx && nx.arr && nx.schArr ? Math.round((new Date(nx.arr) - new Date(nx.schArr)) / 60000) : null;
          list.push({ n: +t.trainNum, id: t.trainID, r: t.routeName || "", d: t.destName || "", o: t.origName || "", late });
        }
      }
      sendJSON(req, res, list, 10);
      return;
    }

    // learned track geometry: GPS breadcrumbs accumulated per leg
    const mTrace = p.match(/^\/api\/trace\/(\d+)$/);
    if (mTrace) {
      const slim = slimTrain(await cachedJSON("trains"), mTrace[1]);
      const legs = {};
      if (slim) for (const inst of Object.values(slim)) for (const t of inst) {
        const st = t.stations || [];
        for (let i = 0; i < st.length - 1; i++) {
          const a = st[i].code, b = st[i + 1].code;
          const k = a + "|" + b;
          if (!a || !b || legs[k]) continue;
          const arr = legPts.get(k);
          if (!arr || arr.length < 2) continue;
          const out = [];
          for (const q of arr) {
            const l = out[out.length - 1];
            if (!l || Math.abs(l[0] - q.la) + Math.abs(l[1] - q.lo) > 0.001) out.push([+q.la.toFixed(4), +q.lo.toFixed(4)]);
          }
          if (out.length > 1) legs[k] = out;
        }
      }
      sendJSON(req, res, { legs: legs }, 30);
      return;
    }

    const mTrain = p.match(/^\/api\/train\/(\d+)$/);
    if (mTrain) {
      const slim = slimTrain(await cachedJSON("trains"), mTrain[1]);
      if (!slim) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "train not running" }));
        return;
      }
      sendJSON(req, res, slim, 5);
      return;
    }

    // SSE: /api/stream/train/<num> — initial snapshot, then a push per upstream change
    const mStream = p.match(/^\/api\/stream\/train\/(\d+)$/);
    if (mStream) {
      const num = mStream[1];
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      const sub = { res, num };
      subs.add(sub);
      req.on("close", () => subs.delete(sub));
      try {
        const slim = slimTrain(await cachedJSON("trains"), num);
        if (slim) res.write(`data: ${JSON.stringify(slim)}\n\n`);
        else res.write(`event: gone\ndata: {}\n\n`);
      } catch { /* initial snapshot failed; pushes will follow */ }
      return;
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    } else {
      try { res.end(); } catch {}
    }
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
    let body = readFileSync(file);
    if (type.startsWith("text/html")) {
      // app-level config: CARTO_API_KEY env var baked into the page at serve time
      body = Buffer.from(body.toString("utf8").replaceAll("__CARTO_KEY__", process.env.CARTO_API_KEY || ""));
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(body);
    return;
  }
  // SPA fallback
  const index = join(__dirname, "public", "index.html");
  if (existsSync(index)) {
    const body = Buffer.from(readFileSync(index, "utf8").replaceAll("__CARTO_KEY__", process.env.CARTO_API_KEY || ""));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, () => console.log(`amtrak-live listening on :${PORT}`));
