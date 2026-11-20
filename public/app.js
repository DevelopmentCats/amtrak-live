/* Amtrak Live — client. No framework, no build step. */
"use strict";

const $ = (s) => document.querySelector(s);
const SMOKE_MIN = 20; // minutes dwell to count as a smoke break
const POLL_MS = 20000;

let trains = null;           // latest /api/trains payload
let stationsMeta = null;     // /api/stations (codes -> meta), cached in LS
let current = null;          // active train object
let pollTimer = null;
let map = null, marker = null, trackLine = null;

// ---------- data ----------
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function loadTrains() {
  trains = await getJSON("/api/trains");
  renderConn(true);
}
async function loadStations() {
  try {
    const cached = JSON.parse(localStorage.getItem("stn_meta") || "null");
    if (cached && Date.now() - cached.at < 864e5) { stationsMeta = cached.v; return; }
  } catch {}
  stationsMeta = await getJSON("/api/stations");
  localStorage.setItem("stn_meta", JSON.stringify({ at: Date.now(), v: stationsMeta }));
}

// ---------- helpers ----------
const fmtT = iso => !iso ? "–" : new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const mins = ms => Math.round(ms / 60000);
function deltaCls(m){ return m > 4 ? "delta-late" : m < -4 ? "delta-early" : "delta-ok"; }
function deltaTxt(m){ return m == null ? "–" : (m > 0 ? `+${m}` : `${m}`) + "m"; }

/** normalize a station row: actuals fall back to schedule */
function norm(s) {
  const aA = s.arr || s.schArr, aD = s.dep || s.schDep;
  let dwell = null;
  if (aA && aD) dwell = Math.max(0, mins(new Date(aD) - new Date(aA)));
  let late = null;
  if (s.arr && s.schArr) late = mins(new Date(s.arr) - new Date(s.schArr));
  return { ...s, effArr: aA, effDep: aD, dwell, late };
}

/** index of the stop the train is at / just left; -1 before start */
function activeIndex(stops) {
  let idx = -1;
  stops.forEach((s, i) => { if (/^departed$/i.test(s.status || "")) idx = i; });
  if (idx < 0) stops.forEach((s, i) => { if (/^arrived$/i.test(s.status || "")) idx = i; });
  return idx;
}

function findTrain(key) {
  if (!trains) return null;
  // key = trainID ("1-18") or bare number ("449")
  if (trains[key]) {
    const list = trains[key];
    if (list.length === 1) return list[0];
    const now = Date.now();
    const live = list.find(t => {
      const st = t.stations || [];
      const f = st[0], l = st[st.length - 1];
      return f && l && new Date(norm(f).effDep) - 36e5 < now && now < new Date(norm(l).effArr) + 36e5;
    });
    return live || list[0];
  }
  return null;
}

function resolveKey(raw) {
  raw = (raw || "").trim().replace(/\D/g, "");
  if (!raw) return null;
  if (trains[raw]) return raw;
  const hit = Object.keys(trains).find(k => k.split("-")[0] === raw);
  return hit || null;
}

// ---------- picker ----------
function renderPicker() {
  const listEl = $("#trainList");
  if (!trains) return;
  const rows = [];
  for (const inst of Object.values(trains)) {
    for (const t of inst) {
      const st = t.stations || [];
      const idx = activeIndex(st.map(norm));
      const next = st[idx + 1] ? norm(st[idx + 1]) : null;
      const late = next ? next.late : null;
      const cls = late == null ? "b-ok" : late > 15 ? "b-late" : "b-ok";
      const lbl = late == null ? "" : late > 15 ? `${late}m late` : "on time";
      rows.push(`<div class="trow" data-id="${esc(t.trainID)}">
        <span class="tnum">${esc(t.trainNum)}</span>
        <span class="troute">${esc(t.routeName || "")}<br><span class="dim small">to ${esc(t.destName || "")}</span></span>
        <span class="badge ${cls}">${lbl}</span>
      </div>`);
    }
  }
  rows.sort((a, b) => (a.match(/data-id="([^"]+)/)?.[1] || "").localeCompare(b.match(/data-id="([^"]+)/)?.[1] || "", undefined, { numeric: true }));
  listEl.innerHTML = rows.join("") || "<div class='dim'>no trains right now?</div>";
  listEl.querySelectorAll(".trow").forEach(el =>
    el.addEventListener("click", () => pick(el.dataset.id)));
}

function renderRecent() {
  const rec = JSON.parse(localStorage.getItem("recent") || "[]");
  const box = $("#recent");
  if (!rec.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="hint">recent:</div>` +
    rec.map(r => `<button class="linklike" data-id="${esc(r.id)}">${esc(r.label)}</button>`).join(" ");
  box.querySelectorAll("button").forEach(b => b.addEventListener("click", () => pick(b.dataset.id)));
}

// ---------- ride view ----------
function pick(id) {
  const t = findTrain(id);
  if (!t) { alert("Train not found — it may have completed its run. Try the list."); return; }
  current = t;
  location.hash = "t=" + encodeURIComponent(t.trainID);
  localStorage.setItem("recent", JSON.stringify(
    [{ id: t.trainID, label: `#${t.trainNum} ${t.routeName || ""}` },
     ...JSON.parse(localStorage.getItem("recent") || "[]").filter(r => r.id !== t.trainID)].slice(0, 4)));
  $("#picker").hidden = true;
  $("#ride").hidden = false;
  renderRide(true);
  startPolling();
}

function back() {
  stopPolling();
  $("#ride").hidden = true;
  $("#picker").hidden = false;
  current = null;
  history.replaceState(null, "", location.pathname);
}

function renderRide(full) {
  if (!current || !trains) return;
  const t = findTrain(current.trainID) || current;
  current = t;
  const stops = (t.stations || []).map(norm);
  const idx = activeIndex(stops);

  $("#rideTitle").textContent = `#${t.trainNum} — ${t.routeName || ""}`;
  $("#rideMeta").innerHTML =
    `${esc(t.origName || "")} → ${esc(t.destName || "")} · ` +
    `<span id="lateness"></span>`;
  const next = stops[idx + 1];
  const lat = next && next.late != null ? next.late : null;
  $("#lateness").innerHTML = lat == null ? `<span class="dim">status unknown</span>`
    : lat > 4 ? `<span class="delta-late">≈${lat} min late</span>`
    : lat < -4 ? `<span class="delta-early">${-lat} min early</span>`
    : `<span class="delta-ok">on time</span>`;
  if (t.statusMsg) $("#lateness").innerHTML += ` <span class="dim small">· ${esc(t.statusMsg)}</span>`;

  // next stop card
  if (next) {
    $("#nextStop").innerHTML =
      `<div class="st">${esc(next.name)} <span class="dim small">(${esc(next.code)})</span></div>
       <div>arr <b>${fmtT(next.effArr)}</b> · dep <b>${fmtT(next.effDep)}</b>
       ${next.late != null ? `<span class="${deltaCls(next.late)}">(${deltaTxt(next.late)})</span>` : ""}</div>
       ${next.dwell != null ? `<div class="dim small">scheduled dwell ${next.dwell} min</div>` : ""}`;
  } else {
    $("#nextStop").innerHTML = `<div class="dim">${idx < 0 ? "Not started yet." : "Run complete."}</div>`;
  }

  // smoking stops
  const upcoming = stops.slice(idx + 1).filter(s => s.dwell != null && !s.bus);
  const smoke = upcoming.filter(s => s.dwell >= SMOKE_MIN).slice(0, 3);
  $("#smokeNext").innerHTML = smoke.length
    ? `<div class="stoplist">` + smoke.map(s => {
        const until = s.effArr ? mins(new Date(s.effArr) - Date.now()) : null;
        const when = until == null || until <= 0 ? "now" : `in ${fmtIn(until)}`;
        return `<div class="stopitem"><span><span class="who">${esc(s.name)}</span> <span class="dim small">${when}</span></span>
          <span class="gap">${s.dwell} min</span></div>`;
      }).join("") + `</div>`
    : `<div class="dim">No ${SMOKE_MIN}+ min stops coming up — stay seated ${idx < 0 ? "" : "for now"}.</div>`;

  // stops table
  $("#stops").innerHTML = stops.map((s, i) => {
    const past = i <= idx, isNext = i === idx + 1;
    return `<div class="row stop ${past ? "past" : ""} ${isNext ? "next" : ""}">
      <span class="dim">${i + 1}</span>
      <span class="stname">${esc(s.name)}${s.bus ? " 🚌" : ""}</span>
      <span class="mono dim">${fmtT(s.schArr)}${s.schDep !== s.schArr ? "→" + fmtT(s.schDep) : ""}</span>
      <span class="mono">${fmtT(s.effArr)}${s.effDep && s.effDep !== s.effArr ? "→" + fmtT(s.effDep) : ""}</span>
      <span class="${deltaCls(s.late)}">${deltaTxt(s.late)}</span>
      <span class="gap hide-sm">${s.dwell != null ? s.dwell + "m" : "–"}</span>
      <span class="dim small hide-sm">${esc(s.status || (isNext ? "en route" : ""))}</span>
    </div>`;
  }).join("");
  $("#updAt").textContent = `· updated ${new Date(t.updatedAt || Date.now()).toLocaleTimeString()}`;

  // map
  renderMap(t, stops, idx);
}

function fmtIn(m) {
  if (m >= 1440) return Math.floor(m / 1440) + "d " + Math.round((m % 1440) / 60) + "h";
  if (m >= 90) return Math.floor(m / 60) + "h " + (m % 60) + "m";
  return m + "m";
}

// ---------- map ----------
function initMap(center) {
  if (typeof L === "undefined") return false;
  map = L.map("map", { zoomControl: true, attributionControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: "© OpenStreetMap",
  }).addTo(map);
  map.setView(center, 7);
  return true;
}

function renderMap(t, stops, idx) {
  if (!t.lat || !t.lon) { $("#coords").textContent = ""; return; }
  $("#coords").textContent = `${t.lat.toFixed(4)}, ${t.lon.toFixed(4)} · ${t.velocity ?? "?"} mph`;
  const g = `https://www.google.com/maps/@?api=1&map_action=map&center=${t.lat},${t.lon}&zoom=12`;
  $("#gmaps").href = g;

  if (!map) {
    if (!initMap([t.lat, t.lon])) {
      // leaflet failed to load -> plain OSM iframe
      document.querySelector(".mapwrap").innerHTML =
        `<iframe src="https://www.openstreetmap.org/export/embed.html?bbox=${t.lon - 1},${t.lat - 0.6},${t.lon + 1},${t.lat + 0.6}&layer=mapnik&marker=${t.lat},${t.lon}"></iframe>`;
      return;
    }
  } else if (document.getElementById("map").tagName !== "DIV") {
    return; // iframe fallback already in place
  }
  const ll = [t.lat, t.lon];
  if (!marker) {
    marker = L.circleMarker(ll, { radius: 7, color: "#3fb950", weight: 3, fillOpacity: 0.9 }).addTo(map);
  } else { marker.setLatLng(ll); }

  const pts = stops.filter(s => s.lat || stationsMeta?.[s.code]).map(s =>
    s.lat && s.lon ? [s.lat, s.lon] : stationsMeta[s.code] ? [stationsMeta[s.code].lat, stationsMeta[s.code].lon] : null
  ).filter(Boolean);
  if (pts.length > 1) {
    if (trackLine) map.removeLayer(trackLine);
    trackLine = L.polyline(pts, { color: "#58a6ff", weight: 3, opacity: 0.6 }).addTo(map);
  }
  // follow: keep marker centered while riding
  map.panTo(ll, { animate: true, duration: 0.5 });
}

// ---------- polling / conn ----------
function renderConn(ok, msg) {
  const el = $("#conn");
  if (!ok) { el.className = "conn err"; el.textContent = msg || "connection error"; return; }
  el.className = "conn ok";
  el.textContent = `live · refreshed ${new Date().toLocaleTimeString()}`;
}

async function tick() {
  try {
    await loadTrains();
    if (current) renderRide(false);
  } catch (e) {
    renderConn(false, e.message);
  }
}
function startPolling() {
  stopPolling();
  pollTimer = setInterval(tick, POLL_MS);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
document.addEventListener("visibilitychange", () => {
  if (!current) return;
  if (document.hidden) stopPolling(); else { tick(); startPolling(); }
});

// ---------- misc ----------
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------- boot ----------
(async function boot() {
  $("#pickBtn").addEventListener("click", () => { const k = resolveKey($("#trainNum").value); if (k) pick(k); else alert("Enter a train number, e.g. 449"); });
  $("#trainNum").addEventListener("keydown", e => { if (e.key === "Enter") $("#pickBtn").click(); });
  $("#backBtn").addEventListener("click", back);
  $("#browseBtn").addEventListener("click", () => { const el = $("#trainList"); el.hidden = !el.hidden; });
  $("#copyLink").addEventListener("click", () => { navigator.clipboard?.writeText(location.href); $("#copyLink").textContent = "copied ✓"; setTimeout(() => ($("#copyLink").textContent = "copy link"), 1500); });

  renderRecent();
  try {
    await Promise.all([loadTrains(), loadStations()]);
    renderPicker();
    const m = location.hash.match(/t=([\w-]+)/);
    if (m) pick(decodeURIComponent(m[1]));
  } catch (e) {
    renderConn(false, e.message);
    $("#pickHint").textContent = "Could not load train data: " + e.message;
  }
})();
