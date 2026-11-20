/* Amtrak Live — HUD client. No framework, no build. */
"use strict";

const $ = (s) => document.querySelector(s);
const SMOKE_MIN = 20;
const POLL_MS = 10000;   // data refresh
const TICK_MS = 1000;    // local clock/countdown

let trainsList = null;   // full list for the picker (lazy)
let stationsMeta = null;
let cur = null;          // { numKey, train }  active train
let tickT = null;
let es = null;           // EventSource
let lastPush = 0;        // ts of last data (push or poll)
let lastMode = "";       // push | poll
let map = null, marker = null, halo = null, track = null;
let gps = null;         // last GPS fix {lat, lon, at, hdg} for dead reckoning

/* great-circle helpers: keep the dot gliding between GPS fixes */
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
function bearing(la1, lo1, la2, lo2) {
  const dLon = (lo2 - lo1) * D2R;
  const y = Math.sin(dLon) * Math.cos(la2 * D2R);
  const x = Math.cos(la1 * D2R) * Math.sin(la2 * D2R) -
    Math.sin(la1 * D2R) * Math.cos(la2 * D2R) * Math.cos(dLon);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}
function dest(la, lo, brng, km) {
  const d = km / 6371, b = brng * D2R, la1 = la * D2R, lo1 = lo * D2R;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [la2 * R2D, ((lo2 * R2D) + 540) % 360 - 180];
}
function updateGps(t) {
  if (!t.lat || !t.lon) return;
  const lat = +t.lat, lon = +t.lon;
  if (gps && gps.lat === lat && gps.lon === lon) { gps.at = Date.now(); return; }
  const hdg = gps ? bearing(gps.lat, gps.lon, lat, lon) : null;
  gps = { lat, lon, at: Date.now(), hdg: hdg ?? gps?.hdg ?? null };
}

/* ---------------- data ---------------- */
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadStations() {
  try {
    const c = JSON.parse(localStorage.getItem("stn") || "null");
    if (c && Date.now() - c.at < 7 * 864e5) { stationsMeta = c.v; return; }
  } catch {}
  stationsMeta = await getJSON("/api/stations");
  localStorage.setItem("stn", JSON.stringify({ at: Date.now(), v: stationsMeta }));
}

async function loadPickerList() {
  if (trainsList) return trainsList;
  trainsList = await getJSON("/api/list"); // tiny index, fast on train wifi
  return trainsList;
}

/* ---------------- helpers ---------------- */
const fmtT = iso => !iso ? "–" : new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const mins = ms => Math.round(ms / 60000);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function norm(s) {
  const aA = s.arr || s.schArr, aD = s.dep || s.schDep;
  return {
    ...s, effArr: aA, effDep: aD,
    dwell: aA && aD ? Math.max(0, mins(new Date(aD) - new Date(aA))) : null,
    late: s.arr && s.schArr ? mins(new Date(s.arr) - new Date(s.schArr)) : null,
  };
}
function activeIdx(stops) {
  let i = -1;
  stops.forEach((s, k) => { if (/^departed$/i.test(s.status || "")) i = k; });
  if (i < 0) stops.forEach((s, k) => { if (/^arrived$/i.test(s.status || "")) i = k; });
  return i;
}
function fmtIn(m) {
  if (m < 0) return "now";
  if (m < 1) return "arriving";
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.round((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m} min`;
}

/* pick the live instance among same-number trains */
function pickInstance(list) {
  if (!list?.length) return null;
  if (list.length === 1) return list[0];
  const now = Date.now();
  return list.find(t => {
    const st = t.stations || [];
    const f = st[0] && norm(st[0]), l = st[st.length - 1] && norm(st[st.length - 1]);
    return f && l && new Date(f.effDep) - 36e5 < now && now < new Date(l.effArr) + 36e5;
  }) || list[0];
}

/* ---------------- HUD render ---------------- */
function render() {
  if (!cur?.train) return;
  const t = cur.train;
  const stops = (t.stations || []).map(norm);
  const idx = activeIdx(stops);
  const next = stops[idx + 1] || null;
  const prev = stops[idx] || null;

  $("#hudNum").textContent = `#${t.trainNum}`;
  $("#hudRoute").textContent = t.routeName || "";
  $("#hudOd").textContent = `${t.origName ?? ""} → ${t.destName ?? ""}`;

  // status chip
  const lat = next ? next.late : (prev ? prev.late : null);
  const chip = $("#hudStatus");
  if (lat == null) { chip.className = "statuschip st-unk"; chip.textContent = "status?"; }
  else if (lat > 4) { chip.className = "statuschip st-late"; chip.textContent = `${lat} min late`; }
  else if (lat < -4) { chip.className = "statuschip st-early"; chip.textContent = `${-lat} early`; }
  else { chip.className = "statuschip st-ok"; chip.textContent = "on time"; }
  if (t.statusMsg) chip.title = t.statusMsg;

  // next stop
  if (next) {
    $("#nextName").textContent = next.name;
    $("#nextArr").textContent = `arr ${fmtT(next.effArr)}`;
    $("#nextSched").textContent = `sched ${fmtT(next.schArr)} · dep ${fmtT(next.effDep)}` +
      (next.late != null ? ` · (${next.late > 0 ? "+" : ""}${next.late}m)` : "");
  } else {
    $("#nextName").textContent = idx < 0 ? "not started" : "run complete";
    $("#nextArr").textContent = ""; $("#nextSched").textContent = ""; $("#nextIn").textContent = "";
  }

  // smoke stops
  const up = stops.slice(idx + 1).filter(s => s.dwell != null && !s.bus);
  const smoke = up.filter(s => s.dwell >= SMOKE_MIN).slice(0, 3);
  $("#smokeList").innerHTML = smoke.length
    ? smoke.map(s => {
        const until = mins(new Date(s.effArr) - Date.now());
        return `<div class="stopitem"><span><span class="who">${esc(s.name)}</span>
          <span class="when"> ${until > 0 ? "in " + fmtIn(until) : "now"}</span></span>
          <span class="gap">${s.dwell}′</span></div>`;
      }).join("")
    : `<div class="dim small">no ${SMOKE_MIN}+ min stops ahead — sit tight.</div>`;

  // stats
  $("#sSpeed").textContent = t.velocity == null || isNaN(+t.velocity) ? "–" : `${Math.round(+t.velocity)}`;
  $("#sDelay").textContent = lat == null ? "–" : `${lat > 0 ? "+" : ""}${lat}m`;
  $("#sPos").textContent = t.lat ? `${t.lat.toFixed(3)}, ${t.lon.toFixed(3)}` : "";
  $("#gmaps").href = t.lat ? `https://www.google.com/maps/@?api=1&map_action=map&center=${t.lat},${t.lon}&zoom=14` : "#";
  $("#updAt").textContent = `upd ${new Date(t.updatedAt || Date.now()).toLocaleTimeString()}`;

  // side drawer rows
  $("#sideRows").innerHTML = stops.map((s, i) => `
    <div class="row ${i <= idx ? "past" : ""} ${i === idx + 1 ? "next" : ""}">
      <span class="dim">${i + 1}</span>
      <span class="stname ${s.bus ? "busT" : ""}">${esc(s.name)}</span>
      <span class="mono">${fmtT(s.effArr)}</span>
      <span class="${dcls(s.late)}">${dlate(s.late)}</span>
      <span class="gapv">${s.dwell != null && s.dwell >= SMOKE_MIN ? s.dwell + "′" : ""}</span>
    </div>`).join("");

  drawMap(t, stops, idx);
  tickClock(); // eta now
}

const dcls = m => m == null ? "dim" : m > 4 ? "delta-late" : m < -4 ? "delta-early" : "delta-ok";
const dlate = m => m == null ? "–" : `${m > 0 ? "+" : ""}${m}m`;

/* map: dark tiles, train marker + halo, route polyline, follow-cam */
function drawMap(t, stops, idx) {
  if (!t.lat || !t.lon) return;
  if (!map) {
    if (typeof L === "undefined") return;
    map = L.map("map", { zoomControl: false, attributionControl: true, dragging: true });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    const key = (typeof window !== "undefined" && window.CARTO_KEY) || "";
    const tileUrl = `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${key ? `?key=${encodeURIComponent(key)}` : ""}`;
    L.tileLayer(tileUrl, {
      attribution: "© OSM © CARTO", maxZoom: 18, subdomains: "abcd",
    }).addTo(map);
    // real rail geometry: the station-to-station line is straight, tracks curve
    L.tileLayer("https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
      attribution: "rails © OpenRailwayMap CC-BY-SA", maxZoom: 19, subdomains: "ab", opacity: 0.85,
    }).addTo(map);
  }
  const ll = [t.lat, t.lon];
  if (!marker) {
    halo = L.circleMarker(ll, { radius: 16, color: "#43d17c", weight: 1, fillOpacity: 0.15, className: "pulse" }).addTo(map);
    marker = L.circleMarker(ll, { radius: 6, color: "#0b0f14", weight: 2, fillColor: "#43d17c", fillOpacity: 1 }).addTo(map);
    map.setView(ll, window.innerWidth < 700 ? 8 : 9, { animate: false });
  } else {
    marker.setLatLng(ll); halo.setLatLng(ll);
  }
  const pts = stops.map(s => (s.lat && s.lon) || (stationsMeta && stationsMeta[s.code])
    ? (s.lat ? [s.lat, s.lon] : [stationsMeta[s.code].lat, stationsMeta[s.code].lon]) : null).filter(Boolean);
  if (pts.length > 1) {
    if (track) track.setLatLngs(pts);
    else track = L.polyline(pts, { color: "#6cbcff", weight: 3, opacity: 0.55 }).addTo(map);
  }
  map.panTo(ll, { animate: true, duration: 0.6 });
}

/* per-second: clock + countdown to next arrival (no network) */
function tickClock() {
  const d = new Date();
  $("#clock").textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (!cur?.train) return;
  const stops = (cur.train.stations || []).map(norm);
  const idx = activeIdx(stops);
  const next = stops[idx + 1];
  if (!next || !next.effArr) { $("#nextIn").textContent = ""; return; }
  const sec = Math.max(0, Math.round((new Date(next.effArr) - Date.now()) / 1000));
  $("#nextIn").textContent = sec < 45 ? "arriving" : `in ${fmtIn(Math.floor(sec / 60))}`;
}

/* ---------------- live data: SSE push, poll fallback ---------------- */
function applyPayload(d) {
  const key = Object.keys(d || {})[0];
  if (!key) return false;
  const t = pickInstance(d[key]);
  if (!t) return false;
  const changed = JSON.stringify(t) !== JSON.stringify(cur?.train || null);
  cur = { numKey: key, train: t };
  updateGps(t);
  if (changed) render();
  return true;
}

function listen(num) {
  closeStream();
  try {
    es = new EventSource(`/api/stream/train/${num}`);
  } catch { es = null; }
  if (es) {
    es.onmessage = ev => {
      try {
        const d = JSON.parse(ev.data);
        lastPush = Date.now(); lastMode = "push";
        if (applyPayload(d)) conn();
      } catch {}
    };
    es.onerror = () => conn(false); // EventSource auto-reconnects
  }
}
function closeStream() { if (es) { es.close(); es = null; } }

function refresh() {
  if (!cur) return Promise.resolve();
  return getJSON(`/api/train/${cur.numKey}`).then(d => {
    lastPush = Date.now(); lastMode = "poll";
    applyPayload(d); conn();
  }).catch(() => conn(false, "poll failed"));
}

function conn(ok = true, msg) {
  const el = $("#conn");
  if (!ok) { el.className = "conn small err"; el.textContent = msg || "reconnecting…"; return; }
  if (!lastPush) { el.className = "conn small"; el.textContent = "…"; return; }
  const age = Date.now() - lastPush;
  const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  if (age < 25000) { el.className = "conn small ok"; el.style.color = ""; el.textContent = `live · ${lastMode} ${t}`; }
  else if (age < 60000) { el.className = "conn small"; el.style.color = "var(--amber)"; el.textContent = `syncing… ${t}`; }
  else { el.className = "conn small err"; el.style.color = ""; el.textContent = `stale ${Math.round(age / 1000)}s`; }
}

function startLoops() { stopLoops(); tickT = setInterval(tick, 1000); }
function stopLoops() { clearInterval(tickT); tickT = null; }

/* per-second: clock + countdown + staleness watchdog */
function tick() {
  const d = new Date();
  $("#clock").textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (!cur?.train) return;

  const stops = (cur.train.stations || []).map(norm);
  const idx = activeIdx(stops);
  const next = stops[idx + 1];
  if (!next || !next.effArr) { $("#nextIn").textContent = ""; }
  else {
    const sec = Math.max(0, Math.round((new Date(next.effArr) - Date.now()) / 1000));
    $("#nextIn").textContent = sec < 45 ? "arriving" : `in ${fmtIn(Math.floor(sec / 60))}`;
  }

  // never fall behind: stale? poll now. stream dead? reopen it.
  const age = Date.now() - lastPush;
  if (lastPush && age > 40000) {
    refresh();
    if (!es || es.readyState === 2) listen(cur.numKey); // 2 CLOSED
  } else if (lastPush && age > 20000) {
    conn();
  }
  // dead-reckon: glide the dot along the last heading at reported speed
  if (marker && gps && cur?.train) {
    const v = +cur.train.velocity || 0;
    const ageS = (Date.now() - gps.at) / 1000;
    if (v > 1 && gps.hdg != null && ageS > 0 && ageS < 90) {
      const p = dest(gps.lat, gps.lon, gps.hdg, (v * 1.60934 * ageS) / 3600);
      marker.setLatLng(p); halo.setLatLng(p);
    }
  }
}

// instant catch-up when the tab comes back or network returns
document.addEventListener("visibilitychange", () => { if (!document.hidden && cur) refresh(); });
addEventListener("online", () => { if (cur) { refresh(); if (!es || es.readyState === 2) listen(cur.numKey); } });

/* ---------------- picker ---------------- */
function renderPicker() {
  if (!trainsList) return;
  // /api/list rows: { n:num, id, r:route, d:dest, late }
  const rows = trainsList.map(t => {
    const late = t.late;
    return `<div class="trow" data-id="${esc(t.id)}" data-num="${t.n}">
      <span class="tnum">#${t.n}</span>
      <span class="troute">${esc(t.r || "")}<br><span class="dim">to ${esc(t.d || "")}</span></span>
      <span class="badge ${late != null && late > 15 ? "b-late" : "b-ok"}">${late == null ? "" : late > 15 ? late + "m late" : "on time"}</span>
    </div>`;
  });
  rows.sort((a, b) => (a.match(/#(\d+)/)?.[1] ?? 0) - (b.match(/#(\d+)/)?.[1] ?? 0));
  $("#trainList").innerHTML = rows.join("") || `<div class="dim">no trains found</div>`;
  $("#trainList").querySelectorAll(".trow").forEach(el =>
    el.addEventListener("click", () => trackTrain(+el.dataset.num, el.dataset.id)));
}

function trackTrain(num, preferID) {
  // fetch just this train; tiny payload
  getJSON(`/api/train/${num}`).then(d => {
    const key = Object.keys(d)[0];
    if (!key) throw new Error("not running");
    let t = preferID ? (d[key] || []).find(x => x.trainID === preferID) : null;
    t = t || pickInstance(d[key]);
    if (!t) throw new Error("not running");
    cur = { numKey: key, train: t };
    location.hash = `t=${t.trainID}`;
    remember(t);
    $("#picker").hidden = true;
    lastPush = Date.now(); lastMode = "poll";
    render();
    listen(key);        // live push from here on
    startLoops();       // 1 s tick: countdown + watchdog
  }).catch(e => { $("#pickHint").textContent = `#${num}: ${e.message}`; });
}

function remember(t) {
  const rec = [{ id: t.trainID, num: +t.trainNum, label: `#${t.trainNum} ${t.routeName || ""}` },
    ...JSON.parse(localStorage.getItem("recent") || "[]").filter(r => r.num !== +t.trainNum)].slice(0, 4);
  localStorage.setItem("recent", JSON.stringify(rec));
  renderRecent();
}
function renderRecent() {
  const rec = JSON.parse(localStorage.getItem("recent") || "[]");
  $("#recent").innerHTML = rec.length
    ? `<div class="hint">recent:</div>` + rec.map(r =>
        `<button data-num="${r.num}" data-id="${esc(r.id)}" class="ghost">${esc(r.label)}</button>`).join("")
    : "";
  $("#recent").querySelectorAll("button").forEach(b =>
    b.addEventListener("click", () => trackTrain(+b.dataset.num, b.dataset.id)));
}

function showPicker() {
  closeStream();
  stopLoops();
  $("#picker").hidden = false;
  loadPickerList().then(renderPicker).catch(e => { $("#pickHint").textContent = e.message; });
}

/* ---------------- boot ---------------- */
(async function boot() {
  $("#pickBtn").addEventListener("click", () => {
    const v = $("#trainNum").value.replace(/\D/g, "");
    if (v) trackTrain(+v); else $("#pickHint").textContent = "enter a train #";
  });
  $("#trainNum").addEventListener("keydown", e => { if (e.key === "Enter") $("#pickBtn").click(); });
  $("#backBtn").addEventListener("click", showPicker);
  $("#sideBtn").addEventListener("click", () => { $("#side").hidden = !$("#side").hidden; });
  $("#sideClose").addEventListener("click", () => { $("#side").hidden = true; });
  $("#copyLink").addEventListener("click", () => {
    navigator.clipboard?.writeText(location.href);
    $("#copyLink").textContent = "copied ✓";
    setTimeout(() => ($("#copyLink").textContent = "share"), 1400);
  });
  addEventListener("keydown", e => { if (e.key === "Escape") $("#side").hidden = true; });

  renderRecent();
  loadStations().catch(() => {}); // best-effort, needed only for the track line

  const m = location.hash.match(/t=([\w-]+)/);
  const num = m ? +m[1].split("-")[0] : null;
  if (num) {
    trackTrain(num, m[1]); // deep link: straight into the HUD, no waiting
    loadStations().catch(() => {}); // polyline only; fills in later
  } else {
    showPicker();
  }
})();
