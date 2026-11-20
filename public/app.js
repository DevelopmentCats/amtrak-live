/* Amtrak Live — HUD client. No framework, no build. */
"use strict";

const $ = (s) => document.querySelector(s);
const SMOKE_MIN = 20;
const POLL_MS = 10000;   // data refresh
const TICK_MS = 1000;    // local clock/countdown

let trainsList = null;   // full list for the picker (lazy)
let stationsMeta = null;
let cur = null;          // { numKey, train }  active train
let pollT = null, tickT = null;
let map = null, marker = null, halo = null, track = null;

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
  trainsList = await getJSON("/api/trains");
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
  $("#sSpeed").textContent = t.velocity ?? "–";
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
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "© OSM © CARTO", maxZoom: 18, subdomains: "abcd",
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

/* ---------------- data loop ---------------- */
async function refresh() {
  try {
    if (cur) {
      const d = await getJSON(`/api/train/${cur.numKey}`);
      const key = Object.keys(d)[0];
      const t = pickInstance(d[key]);
      if (t) cur = { numKey: key, train: t };
      render();
    } else if (trainsList) {
      renderPicker(); // keep picker fresh
    }
    conn(true);
  } catch (e) { conn(false, e.message); }
}
function conn(ok, msg) {
  const el = $("#conn");
  el.className = "conn small " + (ok ? "ok" : "err");
  el.textContent = ok ? `live ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : (msg || "error");
}
function startLoops() {
  stopLoops();
  pollT = setInterval(refresh, POLL_MS);
  tickT = setInterval(tickClock, TICK_MS);
}
function stopLoops() { clearInterval(pollT); clearInterval(tickT); pollT = tickT = null; }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLoops();
  else { refresh(); startLoops(); }
});

/* ---------------- picker ---------------- */
function renderPicker() {
  if (!trainsList) return;
  const rows = [];
  for (const inst of Object.values(trainsList)) {
    for (const t of inst) {
      const st = (t.stations || []).map(norm);
      const i = activeIdx(st);
      const late = st[i + 1] ? st[i + 1].late : null;
      rows.push(`<div class="trow" data-id="${esc(t.trainID)}" data-num="${esc(t.trainNum)}">
        <span class="tnum">#${esc(t.trainNum)}</span>
        <span class="troute">${esc(t.routeName || "")}<br><span class="dim">to ${esc(t.destName || "")}</span></span>
        <span class="badge ${late != null && late > 15 ? "b-late" : "b-ok"}">${late == null ? "" : late > 15 ? late + "m late" : "on time"}</span>
      </div>`);
    }
  }
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
    render();
    if (!pollT) startLoops(); else refresh();
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
    try { await loadStations(); } catch {}
    trackTrain(num, m[1]); // deep link: straight into the HUD
  } else {
    showPicker();
  }
})();
