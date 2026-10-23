// Hotel Search — the page. Talks to the NAS (/api/…) and to the reader add-on (window messages).
const $ = (id) => document.getElementById(id);
const LOCALE = "de-AT";
const fmt = (n) => (n == null ? "" : Math.round(n).toLocaleString(LOCALE));
const eur = (n) => (n == null ? "" : "€" + Math.round(n).toLocaleString(LOCALE));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};
const ago = (ts) => {
  if (!ts) return "";
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const day = (iso, o) => new Date(iso + "T12:00").toLocaleDateString("en-GB", o);
const fmtDates = (p) => `${day(p.checkIn, { day: "numeric", month: "short" })} – ${day(p.checkOut, { day: "numeric", month: "short" })}`;
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
                set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } } };
const AIRPORT = /airport|a[ée]roport|aeroporto|flughafen|aeropuerto|\bCDG\b|orly|roissy|schiphol|heathrow|gatwick|stansted|luton|fiumicino|malpensa|barajas|el prat|brandenburg|\bBER\b|schwechat|\bVIE\b|\bJFK\b|\bLAX\b|\bLHR\b/i;
const P = Object.fromEntries(PROGRAMS.map((p) => [p.id, p]));
const STATUS = { waiting: "Waiting", loading: "Reading", done: "Done", empty: "Nothing read", none: "No hotels offered",
                 timeout: "Took too long", blocked: "Site refused", manual: "Open to check" };

// ---------- Views ----------
function show(view) {
  for (const v of ["search", "members"]) $("view-" + v).hidden = v !== view;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  if (view === "members") loadPoints();
  if (view === "search" && mapObj) setTimeout(() => mapObj.invalidateSize(), 50);
  history.replaceState(null, "", view === "members" ? "#memberships" : location.pathname);
}
document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => show(b.dataset.view));

// ---------- Add-on handshake ----------
let addonReady = false, addonVersion = "", addonBroken = false;
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.source !== "hs-addon") return;
  if (e.data.type === "ready") {
    addonReady = e.data.working !== false; addonVersion = e.data.version || ""; addonBroken = e.data.working === false;
    showAddon();
  }
  if (e.data.type === "started" && !e.data.ok)
    $("place").textContent = "The add-on couldn't open the hotel pages" + (e.data.details && e.data.details.error ? ` (${e.data.details.error})` : "") + ". Use the site links below.";
});
function showAddon() {
  const el = $("addon");
  el.className = "addon " + (addonReady ? "ok" : addonBroken ? "bad" : "no");
  $("addonText").textContent = addonReady ? "Reader on" : addonBroken ? "Reader stuck" : "No reader";
  el.title = addonReady ? `Reader add-on ${addonVersion} is working in this browser`
    : addonBroken ? `Add-on ${addonVersion} found, but not responding` : "No reader add-on in this browser — open the hotel sites yourself, or install it in Settings";
  $("addonState").textContent = addonReady ? `Version ${addonVersion}, working in this browser.` : addonBroken ? `Version ${addonVersion} found but not responding.` : "Not installed in this browser.";
  checkAddonAge();
}
window.postMessage({ source: "hs-page", type: "ping" }, "*");
setTimeout(showAddon, 1500);

// ---------- Search form ----------
(() => {
  const d = new Date(); d.setDate(d.getDate() + ((11 - d.getDay()) % 7 || 7)); // next Thursday
  const iso = (x) => x.toISOString().slice(0, 10);
  $("checkIn").value = iso(d); d.setDate(d.getDate() + 2); $("checkOut").value = iso(d);
})();
$("checkIn").addEventListener("change", () => {
  if ($("checkOut").value <= $("checkIn").value) {
    const d = new Date($("checkIn").value + "T12:00"); d.setDate(d.getDate() + 1); $("checkOut").value = d.toISOString().slice(0, 10);
  }
});
let suggest = [], suggestTimer;
const label = (g) => [g.city, g.region, g.country].filter(Boolean).join(", ");
$("city").addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = $("city").value.split(",")[0].trim();
  if (q.length < 2) return;
  suggestTimer = setTimeout(async () => {
    suggest = await api("/api/geocode?q=" + encodeURIComponent(q)).catch(() => []);
    $("citylist").innerHTML = suggest.map((g) => `<option value="${esc(label(g))}">`).join("");
  }, 250);
});
async function resolvePlace(text) {
  const exact = suggest.find((g) => label(g) === text);
  if (exact) return exact;
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  const res = await api("/api/geocode?q=" + encodeURIComponent(parts[0]));
  if (!res.length) throw new Error("Couldn't find that city.");
  const want = parts.slice(1).join(" ").toLowerCase();
  return res.find((g) => want && (want.includes(g.country.toLowerCase()) || want.includes((g.region || "").toLowerCase()))) || res[0];
}
$("search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const checkIn = $("checkIn").value, checkOut = $("checkOut").value;
  if (checkOut <= checkIn) { $("place").textContent = "Check-out must be after check-in."; return; }
  $("go").disabled = true; $("place").textContent = "";
  try {
    const place = await resolvePlace($("city").value.trim());
    const params = { ...place, checkIn, checkOut, adults: Number($("adults").value) };
    const { id } = await api("/api/searches", { method: "POST", body: JSON.stringify(params) });
    $("place").textContent = addonReady ? "Opening the hotel sites — they flip through for about half a minute, then bring you back here."
      : "No reader add-on in this browser — open each site from the list below.";
    if (addonReady) window.postMessage({ source: "hs-page", type: "start", searchId: id, params, jobs: HotelUrls.build(params), apiBase: location.origin }, "*");
    await loadSearch(id, true);
    loadHistory();
  } catch (err) { $("place").textContent = err.message; }
  finally { $("go").disabled = false; }
});

// ---------- Results ----------
let current = null, pollTimer = null, chainOn = "All", rowsNow = [], hoverKey = null;
async function loadSearch(id, live = false) {
  clearTimeout(pollTimer);
  const s = await api("/api/searches/" + id);
  const fresh = !current || current.id !== s.id;
  current = s;
  render();
  if (fresh) {
    tripInfo(s.params); locate(true); whatsOn(s.params);
    // Show what was searched in the search bar, so a tweak and search again is one step.
    $("city").value = [s.params.city, s.params.country].filter(Boolean).join(", ");
    $("checkIn").value = s.params.checkIn; $("checkOut").value = s.params.checkOut; $("adults").value = String(s.params.adults);
    suggest = [{ ...s.params }];
  }
  const keys = HotelUrls.build(s.params).map((j) => j.key);
  const done = keys.every((k) => s.results.some((r) => r.key === k && !["loading", "waiting"].includes(r.status)));
  if (addonReady && !done && Date.now() - s.created * 1000 < 180000) pollTimer = setTimeout(() => loadSearch(id), 2000);
  else if (!fresh) locate(true);
}

// One row per hotel: cash from the cash pages, points from the points pages, and what a point is worth here.
function buildRows(s) {
  const nights = HotelUrls.nights(s.params.checkIn, s.params.checkOut);
  const map = new Map();
  for (const r of s.results) for (const h of r.hotels || []) {
    if (!h.name) continue;
    const key = r.chain + "|" + h.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const row = map.get(key) || { key, name: h.name, chain: r.chain, url: r.url };
    if (h.link && (!row.link || r.kind !== "points")) row.link = h.link;
    if (h.distanceKm != null) row.dist = h.distanceKm;
    if (h.cashPerNight != null && r.kind !== "points") row.cash = h.cashPerNight;
    if (h.cashTotal != null && r.kind !== "points") row.total = h.cashTotal;
    if (h.rate && r.kind !== "points") row.rate = h.rate;
    if (h.points != null && r.kind !== "cash") { row.points = h.points; row.unit = h.pointsUnit; }
    if (h.soldOut) row.soldOut = true;
    if (h.pointsLimited && r.kind !== "cash") row.pointsLimited = true;
    map.set(key, row);
  }
  const rows = [...map.values()].filter((r) => r.cash != null || r.points != null || r.soldOut);
  for (const r of rows) {
    if (r.total == null && r.cash != null) r.total = r.cash * nights;
    if (r.points != null) r.pointsTotal = r.unit === "stay" ? r.points : r.points * nights;
    r.airport = AIRPORT.test(r.name);
    r.brand = brandOf(r.name, r.chain);
    const typical = P[r.chain] && P[r.chain].centsPerPoint;
    if (r.total && r.pointsTotal) {
      r.cpp = (r.total * 100) / r.pointsTotal; // euro cents per point
      r.verdict = typical ? (r.cpp >= typical * 1.25 ? "great" : r.cpp >= typical * 0.85 ? "fair" : "poor") : null;
    }
  }
  const bookable = rows.filter((r) => !r.soldOut && r.cash != null);
  const cheapest = bookable.reduce((a, b) => (a && a.cash <= b.cash ? a : b), null);
  const bestValue = rows.filter((r) => r.verdict === "great").reduce((a, b) => (a && a.cpp >= b.cpp ? a : b), null);
  if (cheapest) cheapest.best = "Lowest price";
  if (bestValue) bestValue.bestPts = "Best use of points";
  return { rows, nights };
}

function render() {
  const s = current; if (!s) return;
  $("intro").hidden = true; $("results").hidden = false;
  const jobs = HotelUrls.build(s.params);
  const byKey = Object.fromEntries(s.results.map((r) => [r.key, r]));
  const tooOld = Date.now() - s.created * 1000 > 180000;
  const { rows: all, nights } = buildRows(s);

  $("rTitle").textContent = s.params.city;
  $("rMeta").textContent = `${fmtDates(s.params)} · ${nights} night${nights > 1 ? "s" : ""} · ${s.params.adults} guest${s.params.adults > 1 ? "s" : ""}` + (tooOld ? ` · searched ${ago(s.created)}` : "");

  // Which sites were read
  const states = jobs.map((j) => ({ j, st: byKey[j.key] ? byKey[j.key].status : (!addonReady || tooOld ? "manual" : "waiting"), r: byKey[j.key] }));
  const busy = states.filter((x) => ["waiting", "loading"].includes(x.st)).length;
  $("sources").innerHTML = `<span class="src-sum">${busy ? `<span class="spin"></span>Reading ${jobs.length - busy} of ${jobs.length} sites…` : `${jobs.length} sites`}</span>` +
    states.map(({ j, st, r }) => `<a class="src ${st}" href="${esc(j.url)}" target="_blank" rel="noopener" title="${esc(STATUS[st] || st)} — open ${esc(j.chain)}">
      <i class="c-${j.chain.toLowerCase()}"></i>${esc(j.chain)}${j.kind === "cash+points" ? "" : `<em>${j.kind}</em>`}
      <b>${st === "done" ? (r.hotels || []).length : esc(STATUS[st] || st)}</b></a>`).join("");

  const out = [...new Set(s.results.filter((r) => r.signedIn === false).map((r) => r.chain))];
  $("warn").hidden = !out.length;
  $("warn").textContent = out.length ? `Not signed in at ${out.join(" and ")} — those prices may be public rates and points may be missing. Sign in under Memberships, then search again.` : "";

  const chains = ["All", ...new Set(all.map((r) => r.chain))];
  if (!chains.includes(chainOn)) chainOn = "All";
  $("chainFilter").innerHTML = chains.map((c) => `<button type="button" class="${c === chainOn ? "on" : ""}" data-c="${esc(c)}">${c === "All" ? "All" : `<i class="c-${c.toLowerCase()}"></i>${esc(c)}`}</button>`).join("");
  $("chainFilter").querySelectorAll("button").forEach((b) => b.onclick = () => { chainOn = b.dataset.c; render(); });

  let rows = all.slice();
  if (chainOn !== "All") rows = rows.filter((r) => r.chain === chainOn);
  const maxKm = Number($("maxKm").value) || null;
  if (maxKm) rows = rows.filter((r) => r.dist == null || r.dist <= maxKm);
  if ($("noAirport").checked) rows = rows.filter((r) => !r.airport);
  const big = Number.MAX_SAFE_INTEGER, by = $("sort").value;
  rows.sort((a, b) => (a.soldOut ? 1 : 0) - (b.soldOut ? 1 : 0) || (
    by === "points" ? (a.pointsTotal ?? big) - (b.pointsTotal ?? big)
    : by === "value" ? (b.cpp ?? -1) - (a.cpp ?? -1)
    : by === "dist" ? (a.dist ?? big) - (b.dist ?? big)
    : (a.cash ?? big) - (b.cash ?? big)));
  rowsNow = rows;

  const hidden = all.length - rows.length;
  $("list").innerHTML = (rows.length ? rows.map(card).join("") : `<div class="empty">${all.length ? "No hotels match these filters." : busy ? "Hotels appear here as each site is read." : "No hotels were read for this search. Open the sites above to check."}</div>`)
    + (hidden && rows.length ? `<p class="list-foot">${hidden} more hidden by filters</p>` : "");
  $("list").querySelectorAll(".hotel").forEach((el) => {
    el.onmouseenter = () => highlight(el.dataset.k, false);
    el.onmouseleave = () => highlight(null, false);
  });
  drawMarkers();
}

const badge = (r) => `<span class="brand b-${r.chain.toLowerCase()}" title="${esc(r.brand.label)}">${esc(r.brand.code)}</span>`;
function rateTag(r) {
  const x = r.rate; if (!x) return "";
  const extra = x.breakfast ? " · breakfast" : "";
  if (x.prepaid) return `<div class="rate warn" title="${esc(x.name)}">Prepaid, non-refundable${extra}</div>`;
  if (x.member) return `<div class="rate ok" title="${esc(x.name)}">Member rate${extra}</div>`;
  return `<div class="rate" title="${esc(x.name)}: the site's standard rate — the member rate may be lower">Standard rate${extra}</div>`;
}
function card(r) {
  const unit = r.unit === "stay" ? "for the stay" : r.unit === "first night" ? "first night" : "per night";
  const v = r.cpp != null ? `<span class="cpp ${r.verdict || ""}" title="What one point is worth here, in euro cents. Typical for ${esc(r.chain)}: ${P[r.chain] ? P[r.chain].centsPerPoint : "?"} ¢">${r.cpp.toFixed(2).replace(".", ",")} ¢/pt</span>` : "";
  const sub = [r.dist != null ? `${r.dist.toLocaleString(LOCALE)} km from centre` : null, r.airport ? "airport" : null].filter(Boolean).join(" · ");
  return `<article class="hotel${r.soldOut ? " sold" : ""}" data-k="${esc(r.key)}">
    <div class="h-main">
      <div class="h-flags">${r.best ? `<span class="flag">${r.best}</span>` : ""}${r.bestPts ? `<span class="flag brass">${r.bestPts}</span>` : ""}</div>
      <div class="h-title">${badge(r)}<a class="h-name" href="${esc(r.link || r.url || "#")}" target="_blank" rel="noopener" title="${r.link ? "Open this hotel's offer" : "Open the search on the hotel site"}">${esc(r.name)}</a></div>
      <div class="h-sub"><span class="chain"><i class="c-${r.chain.toLowerCase()}"></i>${esc(r.chain)}</span>${sub ? `<span>${esc(sub)}</span>` : ""}</div>
    </div>
    <div class="h-cash">${r.soldOut ? `<span class="sold-label">Sold out</span>` : r.cash != null
      ? `<div class="amt">${eur(r.cash)}<small> / night</small></div><div class="sub">${eur(r.total)} total</div>${rateTag(r)}` : `<div class="none" title="No cash rate read">—</div>`}</div>
    <div class="h-pts">${r.points != null
      ? `<div class="amt">${fmt(r.points)}<small> pts</small></div><div class="sub">${unit}${r.pointsLimited ? " · not all nights" : ""} ${v}</div>`
      : r.soldOut ? "" : `<div class="none" title="No points rate read">—</div>`}</div>
  </article>`;
}
for (const id of ["sort", "maxKm", "noAirport"]) $(id).addEventListener("change", () => { store.set("hs-filters", { sort: $("sort").value, maxKm: $("maxKm").value, noAirport: $("noAirport").checked }); render(); });
(() => { const f = store.get("hs-filters", {}); if (f.sort) $("sort").value = f.sort; if (f.maxKm != null) $("maxKm").value = f.maxKm; $("noAirport").checked = !!f.noAirport; })();
document.querySelectorAll("#viewSwitch button").forEach((b) => b.onclick = () => {
  document.querySelectorAll("#viewSwitch button").forEach((x) => x.classList.toggle("on", x === b));
  $("split").classList.toggle("show-map", b.dataset.v === "map");
  if (mapObj) setTimeout(() => { mapObj.invalidateSize(); fitMap(); }, 60);
});

// ---------- Map ----------
let mapObj = null, markers = {}, coords = {}, locateTimer = null, tileLayer = null, locateTries = 0;
const dark = () => window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
function ensureMap() {
  if (mapObj || typeof L === "undefined") return mapObj;
  mapObj = L.map("map", { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  setTiles();
  if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", setTiles);
  return mapObj;
}
// Esri's quiet grey basemap: no key needed (CARTO's now asks for one). Street names come as a second layer.
let labelLayer = null;
function setTiles() {
  if (!mapObj) return;
  if (tileLayer) tileLayer.remove();
  if (labelLayer) labelLayer.remove();
  const tone = dark() ? "Dark_Gray" : "Light_Gray";
  const base = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_" + tone;
  tileLayer = L.tileLayer(base + "_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16,
    attribution: 'Tiles © <a href="https://www.esri.com">Esri</a> — Esri, HERE, Garmin, © OpenStreetMap contributors' }).addTo(mapObj);
  labelLayer = L.tileLayer(base + "_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16 }).addTo(mapObj);
}
async function locate(again, first = true) {
  clearTimeout(locateTimer);
  if (first) locateTries = 0;
  if (!current) return;
  const names = buildRows(current).rows.map((r) => r.name);
  if (!names.length) { drawMarkers(); return; }
  try {
    const r = await api("/api/hotel-geo", { method: "POST", body: JSON.stringify({ search: current.id, names }) });
    Object.assign(coords, r.locations);
    drawMarkers();
    $("mapNote").textContent = r.pending ? `Placing ${r.pending} more hotel${r.pending > 1 ? "s" : ""} on the map…` : "";
    if (r.pending && again && ++locateTries < 40) locateTimer = setTimeout(() => locate(true, false), 3000);
  } catch (e) { $("mapNote").textContent = "Map locations unavailable right now."; }
}
function drawMarkers() {
  if (!ensureMap() || !current) return;
  for (const m of Object.values(markers)) m.remove();
  markers = {};
  const centre = [current.params.lat, current.params.lon];
  const pin = L.divIcon({ className: "centre-pin", html: "<i></i>", iconSize: [14, 14] });
  markers.__centre = L.marker(centre, { icon: pin, interactive: false, keyboard: false }).addTo(mapObj);
  for (const r of rowsNow) {
    const c = coords[r.name]; if (!c) continue;
    const text = r.soldOut ? "Sold out" : r.cash != null ? eur(r.cash) : r.points != null ? kpts(r.points) : "";
    const icon = L.divIcon({ className: "", html: `<span class="mk ${r.soldOut ? "sold" : ""} ${r.bestPts ? "brass" : ""}" data-k="${esc(r.key)}">${badge(r)}${text}</span>`, iconSize: null });
    const m = L.marker(c, { icon, riseOnHover: true }).addTo(mapObj);
    m.bindTooltip(`<b>${esc(r.name)}</b><br>${esc(r.chain)}${r.points != null ? " · " + fmt(r.points) + " pts" : ""}`, { direction: "top", offset: [0, -14] });
    m.on("click", () => { const el = document.querySelector(`.hotel[data-k="${CSS.escape(r.key)}"]`); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); highlight(r.key, true); } });
    m.on("mouseover", () => highlight(r.key, false));
    m.on("mouseout", () => highlight(null, false));
    markers[r.key] = m;
  }
  fitMap();
}
const kpts = (n) => n >= 1e6 ? (n / 1e6).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + "M pts" : Math.round(n / 1000) + "k pts";
function fitMap() {
  if (!mapObj || !current) return;
  const pts = Object.entries(markers).filter(([k]) => k !== "__centre").map(([, m]) => m.getLatLng());
  const near = pts.filter((p) => mapObj.distance(p, [current.params.lat, current.params.lon]) < 15000);
  if (near.length) mapObj.fitBounds(L.latLngBounds(near.concat([[current.params.lat, current.params.lon]])).pad(0.15), { maxZoom: 16 });
  else mapObj.setView([current.params.lat, current.params.lon], 13);
}
function highlight(key, sticky) {
  if (hoverKey === key && !sticky) return;
  hoverKey = key;
  document.querySelectorAll(".hotel.hl").forEach((e) => e.classList.remove("hl"));
  document.querySelectorAll(".mk.hl").forEach((e) => e.classList.remove("hl"));
  if (!key) return;
  const el = document.querySelector(`.hotel[data-k="${CSS.escape(key)}"]`); if (el) el.classList.add("hl");
  const mk = document.querySelector(`.mk[data-k="${CSS.escape(key)}"]`); if (mk) mk.classList.add("hl");
  if (markers[key]) markers[key].setZIndexOffset(1000);
}

// ---------- Weather, holidays, flights ----------
// ---------- What's on ----------
let woEvents = [], woKind = "All";
async function whatsOn(p) {
  const sid = current && current.id;
  $("woTitle").textContent = `What's on in ${p.city}`;
  const month = day(p.checkIn, { month: "long", year: "numeric" });
  const g = (q) => "https://www.google.com/search?q=" + encodeURIComponent(q);
  $("woLinks").innerHTML = [
    [`Google events`, g(`events in ${p.city} ${fmtDates(p)} ${p.checkIn.slice(0, 4)}`) + "&ibp=htl;events"],
    [`Exhibitions`, g(`exhibitions ${p.city} ${month}`)],
    [`Trade fairs`, g(`trade fair congress ${p.city} ${month}`)],
  ].map(([t, u]) => `<a class="t-item link" href="${esc(u)}" target="_blank" rel="noopener">${t} ↗</a>`).join("");
  $("woList").innerHTML = `<div class="empty small">Looking for events…</div>`;
  $("woFilter").hidden = true;
  const r = await api(`/api/events?lat=${p.lat}&lon=${p.lon}&start=${p.checkIn}&end=${p.checkOut}`).catch(() => ({ events: [], error: "Couldn't load events." }));
  if (!current || current.id !== sid) return;
  woEvents = r.events || []; woKind = "All";
  if (!r.hasKey && !r.error) {
    $("woList").innerHTML = `<div class="empty small">Add a free Ticketmaster key in <button class="text-btn inline-link" type="button" data-open-settings>Settings</button> to list concerts, shows and sports here. The links above work without it.</div>`;
    $("woList").querySelector("[data-open-settings]").onclick = () => { $("settings").hidden = false; $("evBox").open = true; checkUpdates(); };
    eventsChip(null); return;
  }
  if (r.error) { $("woList").innerHTML = `<div class="empty small">${esc(r.error)}</div>`; eventsChip(null); return; }
  eventsChip(woEvents.length);
  drawEvents();
}
function drawEvents() {
  const kinds = ["All", ...new Set(woEvents.map((e) => e.segment).filter((k) => k && k !== "Undefined"))];
  $("woFilter").hidden = kinds.length < 3;
  $("woFilter").innerHTML = kinds.map((k) => `<button type="button" class="${k === woKind ? "on" : ""}" data-k="${esc(k)}">${esc(k === "Arts & Theatre" ? "Arts & theatre" : k)}</button>`).join("");
  $("woFilter").querySelectorAll("button").forEach((b) => b.onclick = () => { woKind = b.dataset.k; drawEvents(); });
  const list = woEvents.filter((e) => woKind === "All" || e.segment === woKind);
  $("woList").innerHTML = list.length ? list.map((e) => `<a class="ev" href="${esc(e.url || "#")}" target="_blank" rel="noopener">
      <div class="ev-img">${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : ""}</div>
      <div class="ev-body"><div class="ev-when">${e.date ? day(e.date, { weekday: "short", day: "numeric", month: "short" }) : ""}${e.time ? " · " + esc(e.time) : ""}</div>
        <div class="ev-name">${esc(e.name)}</div><div class="ev-where">${esc([e.kind, e.venue].filter(Boolean).join(" · "))}</div></div></a>`).join("")
    : `<div class="empty small">No listed events on these dates — try the links above for exhibitions and fairs.</div>`;
}
function eventsChip(n) {
  const el = document.querySelector(".t-item.events");
  if (el) el.remove();
  if (!n) return;
  const a = document.createElement("a");
  a.className = "t-item link events"; a.href = "#whatson"; a.textContent = `${n} event${n > 1 ? "s" : ""} on ↓`;
  a.onclick = (ev) => { ev.preventDefault(); $("whatson").scrollIntoView({ behavior: "smooth", block: "start" }); };
  $("trip").appendChild(a);
}

async function tripInfo(p) {
  const from = store.get("hs-from", "Vienna");
  const q = encodeURIComponent(`Flights from ${from} to ${p.city} on ${p.checkIn} through ${p.checkOut}`);
  const parts = { weather: `<span class="t-item muted">Weather…</span>`, hol: "",
    flights: `<a class="t-item link" href="https://www.google.com/travel/flights?q=${q}" target="_blank" rel="noopener">Flights from ${esc(from)} ↗</a>` };
  const draw = () => { const ev = document.querySelector(".t-item.events"); $("trip").innerHTML = parts.weather + parts.hol + parts.flights; if (ev) $("trip").appendChild(ev); };
  draw();
  api(`/api/weather?lat=${p.lat}&lon=${p.lon}&start=${p.checkIn}&end=${p.checkOut}`).then((w) => {
    const days = w.days.slice(0, 5).map((d) => `<span class="wd" title="${esc(d.text)} · ${Math.round(d.min)}–${Math.round(d.max)}°${d.rain ? " · " + d.rain.toFixed(1) + " mm" : ""}">
      <span class="wd-d">${day(d.date, { weekday: "short" })}</span><span class="wd-i">${d.icon}</span><span class="wd-t">${Math.round(d.max)}°</span></span>`).join("");
    parts.weather = `<span class="t-item weather" title="${w.mode === "forecast" ? "Forecast" : "Last year on these dates — the forecast appears closer to the trip"}">${days}${w.mode === "forecast" ? "" : '<span class="wd-note">last year</span>'}</span>`;
    draw();
  }).catch(() => { parts.weather = ""; draw(); });
  api(`/api/holidays?cc=${p.countryCode}&start=${p.checkIn}&end=${p.checkOut}`).then((h) => {
    parts.hol = h.length ? `<span class="t-item hol" title="${esc(h.map((x) => day(x.date, { weekday: "short", day: "numeric", month: "short" }) + ": " + x.name).join("\n"))}">Holiday · ${esc(h[0].name)}${h.length > 1 ? ` +${h.length - 1}` : ""}</span>` : "";
    draw();
  }).catch(() => {});
}

// ---------- Recent searches ----------
let histEditing = false;
async function loadHistory() {
  const list = await api("/api/searches?limit=30").catch(() => []);
  $("histEdit").hidden = !list.length;
  if (!list.length) { histEditing = false; $("histBar").hidden = true; }
  $("history").innerHTML = list.length ? list.map((s) => `
    <div class="hist-row">
      ${histEditing ? `<input type="checkbox" class="hist-pick" data-id="${s.id}" aria-label="Select this search">` : ""}
      <button type="button" data-id="${s.id}"><span class="h-city">${esc(s.params.city)}<span class="muted">, ${esc(s.params.country)}</span></span>
        <span class="h-when">${fmtDates(s.params)} · ${s.params.adults} guest${s.params.adults > 1 ? "s" : ""}</span><span class="muted h-ago">${ago(s.created)}</span></button>
    </div>`).join("") : '<div class="empty small">Your searches will appear here.</div>';
  $("history").querySelectorAll("button[data-id]").forEach((b) => b.onclick = () => {
    if (histEditing) { const c = b.parentElement.querySelector(".hist-pick"); c.checked = !c.checked; histPicked(); return; }
    loadSearch(Number(b.dataset.id), true); window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("history").querySelectorAll(".hist-pick").forEach((c) => c.onchange = histPicked);
  histPicked();
}
function histPicked() {
  const picks = [...document.querySelectorAll(".hist-pick")];
  const n = picks.filter((c) => c.checked).length;
  $("histDel").disabled = !n;
  $("histDel").textContent = n ? `Delete ${n}` : "Delete";
  $("histAll").checked = picks.length > 0 && n === picks.length;
}
$("histEdit").onclick = () => {
  histEditing = !histEditing;
  $("histEdit").textContent = histEditing ? "Done" : "Edit";
  $("histBar").hidden = !histEditing;
  loadHistory();
};
$("histAll").onchange = () => { document.querySelectorAll(".hist-pick").forEach((c) => c.checked = $("histAll").checked); histPicked(); };
$("histDel").onclick = async () => {
  const ids = [...document.querySelectorAll(".hist-pick:checked")].map((c) => Number(c.dataset.id));
  if (!ids.length || !confirm(`Delete ${ids.length} search${ids.length > 1 ? "es" : ""}? This can't be undone.`)) return;
  await api("/api/searches/delete", { method: "POST", body: JSON.stringify({ ids }) }).catch((e) => alert(e.message));
  if (current && ids.includes(current.id)) { current = null; $("results").hidden = true; $("intro").hidden = false; }
  loadHistory();
};

// ---------- Memberships ----------
let pointsData = null;
async function loadPoints() {
  pointsData = await api("/api/points").catch(() => ({ latest: {}, history: {}, accounts: {}, status: {} }));
  const { latest, history: hist, accounts, status = {} } = pointsData;
  let total = 0, counted = 0;
  for (const p of PROGRAMS) {
    const l = latest[p.id];
    if (l && p.centsPerPoint) { total += (l.balance * p.centsPerPoint) / 100; counted++; }
  }
  $("mTotal").textContent = counted ? "≈ " + eur(total) : "Add your balances";
  $("mSub").textContent = counted ? `across ${counted} programme${counted > 1 ? "s" : ""}, at typical point values` : "Marriott, Hilton and IHG fill in by themselves when you search while signed in.";

  const card = (p) => {
    const l = latest[p.id], a = accounts[p.id] || {}, st = status[p.id];
    const prev = (hist[p.id] || [])[1];
    const tierName = st ? st.tier : null;
    const ti = tierName ? p.tiers.findIndex((t) => t.name === tierName) : -1;
    const tier = ti >= 0 ? p.tiers[ti] : null, next = ti >= 0 ? p.tiers[ti + 1] : null;
    const fresh = a.checked && Date.now() / 1000 - a.checked < 3600;
    const signedNow = a.signedIn === true && fresh;
    const state = !p.auto ? "" : signedNow ? `<span class="state ok">Signed in</span>` : a.signedIn === false && fresh ? `<span class="state no">Signed out</span>` : `<span class="state">Sign in before searching</span>`;
    const value = l && p.centsPerPoint ? `≈ ${eur((l.balance * p.centsPerPoint) / 100)}` : "";
    const delta = prev && l ? `${l.balance >= prev.balance ? "+" : "−"}${fmt(Math.abs(l.balance - prev.balance))} since ${ago(prev.ts)}` : l ? `updated ${ago(l.ts)}` : "";
    return `<article class="prog${p.auto ? "" : " compact"}" data-p="${esc(p.id)}">
      <header><div><h3>${esc(p.name)}</h3>${state}</div>
        <button class="tier-badge ${tier ? "t" + Math.min(ti, 5) : "none"}" data-tier-edit="${esc(p.id)}" type="button" title="Change status">${tier ? esc(tier.name) : "Set status"}</button></header>
      <div class="bal-row">
        <button class="bal" type="button" data-bal="${esc(p.id)}" title="${p.auto ? "Fills in when you search signed in — tap to correct" : "Tap to update"}">${l ? fmt(l.balance) : "—"}<small>${l ? " " + (p.unit || "pts") : ""}</small></button>
        <span class="bal-val">${value}</span>
      </div>
      <p class="meta">${esc(delta)}</p>
      ${tier && tier.benefits.length ? `<ul class="perks">${tier.benefits.slice(0, 4).map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : p.auto && !tier ? `<p class="meta">Set your status to see what it gets you.</p>` : ""}
      ${next ? `<p class="next"><span>Next: ${esc(next.name)}</span>${esc(next.qualify || "")}</p>` : ""}
      <footer>${p.login ? `<a class="btn small" href="${esc(signedNow ? p.site : p.login)}" target="_blank" rel="noopener">${signedNow ? "Open site" : "Sign in"}</a>` : ""}
        <select class="tier-select" data-tier="${esc(p.id)}" aria-label="${esc(p.name)} status" hidden>
          <option value="">No status</option>${p.tiers.map((t) => `<option ${tierName === t.name ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></footer>
    </article>`;
  };
  const main = PROGRAMS.filter((p) => p.auto), other = PROGRAMS.filter((p) => !p.auto && p.kind !== "bank");
  $("programs").innerHTML = `<div class="prog-grid">${main.map(card).join("")}</div>
    <h2 class="sub-head">Other programmes</h2><div class="prog-grid small">${other.map(card).join("")}</div>`;
  $("programs").querySelectorAll("[data-tier-edit]").forEach((b) => b.onclick = () => {
    const sel = b.closest(".prog").querySelector(".tier-select"); sel.hidden = false; sel.focus();
  });
  $("programs").querySelectorAll(".tier-select").forEach((sel) => sel.onchange = async () => {
    await api("/api/status", { method: "POST", body: JSON.stringify({ program: sel.dataset.tier, tier: sel.value }) }); loadPoints();
  });
  $("programs").querySelectorAll("[data-bal]").forEach((b) => b.onclick = () => askBalance(b.dataset.bal));
  renderAmex();
}
async function askBalance(id) {
  const v = prompt(`Current ${P[id] ? P[id].name : id} balance:`);
  if (v == null) return;
  const digits = String(v).replace(/[^\d]/g, "");
  if (!digits) return;
  await api("/api/points", { method: "POST", body: JSON.stringify({ program: id, balance: Number(digits) }) });
  loadPoints();
}
function renderAmex() {
  const amex = PROGRAMS.find((p) => p.kind === "bank");
  if (!amex) { $("amex").innerHTML = ""; return; }
  const l = pointsData.latest[amex.id];
  const bal = l ? l.balance : null;
  $("amex").innerHTML = `<div class="amex-head"><div><p class="eyebrow">${esc(amex.name)}</p>
      <button class="bal big" type="button" data-bal="${esc(amex.id)}">${bal != null ? fmt(bal) : "Add balance"}<small>${bal != null ? " pts" : ""}</small></button>
      <p class="meta">${l ? "updated " + ago(l.ts) : "Enter it from your Amex app — it isn't read automatically."}</p></div>
      <p class="note">${esc(amex.note || "")}</p></div>
    <div class="xfers"><p class="eyebrow">Transfer to hotel points</p>${amex.transfers.map((t) => {
      const to = P[t.to], got = bal != null ? Math.floor((bal / t.from) * t.get) : null;
      const val = got != null && to && to.centsPerPoint ? (got * to.centsPerPoint) / 100 : null;
      return `<div class="xfer"><span class="x-to"><i class="c-${esc(t.to.toLowerCase().replace(/[^a-z]/g, ""))}"></i>${esc(to ? to.name : t.to)}</span>
        <span class="x-rate">${fmt(t.from)} → ${fmt(t.get)}</span>
        <span class="x-got">${got != null ? fmt(got) + " pts" : ""}</span><span class="x-val">${val != null ? "≈ " + eur(val) : ""}</span></div>`;
    }).join("")}</div>`;
  $("amex").querySelectorAll("[data-bal]").forEach((b) => b.onclick = () => askBalance(b.dataset.bal));
}

// ---------- Settings & updates ----------
const ADDON_LATEST = "0.6.1";
const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
$("gear").onclick = () => { $("settings").hidden = false; checkUpdates(); };
$("setClose").onclick = () => { $("settings").hidden = true; };
$("settings").onclick = (e) => { if (e.target === $("settings")) $("settings").hidden = true; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("settings").hidden = true; });
$("addonLink").href = "/static/hotel-search-addon.zip?v=" + ADDON_LATEST;
$("fromCity").value = store.get("hs-from", "Vienna");
$("fromCity").onchange = () => { store.set("hs-from", $("fromCity").value.trim() || "Vienna"); if (current) tripInfo(current.params); };
api("/api/health").then((h) => { $("version").textContent = h.version; }).catch(() => {});
function checkAddonAge() {
  $("addonAdvice").innerHTML = addonVersion && newer(ADDON_LATEST, addonVersion) ? `<b>Version ${ADDON_LATEST} is available — reinstall it.</b>` : "";
}
async function checkUpdates() {
  try {
    const u = await api("/api/admin/update-status");
    $("keyBox").open = !u.hasKey;
    $("evBox").querySelector("summary").textContent = u.hasEventsKey ? `Ticketmaster key for "What's on" — saved ✓` : `Ticketmaster key for "What's on"`;
    const ready = u.hasKey && !u.error && newer(u.latest, u.current);
    $("latestInfo").textContent = !u.hasKey ? "add your GitHub key for one-tap updates" : u.error ? u.error : ready ? `version ${u.latest} is ready` : "up to date";
    $("ghGo").hidden = !ready;
    $("gear").classList.toggle("dot", !!ready);
  } catch (e) { $("latestInfo").textContent = "couldn't check for updates"; }
  checkAddonAge();
}
$("ghGo").onclick = async () => {
  $("ghGo").disabled = true; $("ghMsg").textContent = "Downloading and installing…";
  try {
    await api("/api/admin/update-from-github", { method: "POST", body: "{}" });
    $("ghMsg").textContent = "Installed. Restarting — the page reloads in a few seconds.";
    setTimeout(() => location.reload(), 6000);
  } catch (e) { $("ghMsg").textContent = e.message; $("ghGo").disabled = false; }
};
$("evKeyGo").onclick = async () => {
  const key = $("evKey").value.trim(); if (!key) return;
  try {
    await api("/api/admin/events-key", { method: "POST", body: JSON.stringify({ key }) });
    $("evKey").value = ""; $("ghMsg").textContent = "Ticketmaster key saved."; $("evBox").open = false;
    if (current) whatsOn(current.params);
  } catch (e) { $("ghMsg").textContent = e.message; }
};
$("ghKeyGo").onclick = async () => {
  const key = $("ghKey").value.trim(); if (!key) return;
  $("ghMsg").textContent = "Checking the key…";
  try {
    const r = await api("/api/admin/key", { method: "POST", body: JSON.stringify({ key }) });
    $("ghKey").value = ""; $("ghMsg").textContent = r.ok ? "Key saved — it works." : "Key saved, but: " + r.error; checkUpdates();
  } catch (e) { $("ghMsg").textContent = e.message; }
};
$("updGo").onclick = async () => {
  const f = $("updFile").files[0];
  if (!f) { $("updMsg").textContent = "Choose the update file first."; return; }
  $("updGo").disabled = true; $("updMsg").textContent = "Installing…";
  try {
    const r = await fetch("/api/admin/update", { method: "POST", headers: { "Content-Type": "application/gzip" }, body: await f.arrayBuffer() });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || "Update failed");
    $("updMsg").textContent = "Installed. Restarting — the page reloads in a few seconds.";
    setTimeout(() => location.reload(), 5000);
  } catch (e) { $("updMsg").textContent = e.message; $("updGo").disabled = false; }
};

// ---------- Start ----------
loadHistory();
checkUpdates();
setTimeout(checkUpdates, 3000);
show(location.hash === "#memberships" ? "members" : "search");
setInterval(() => { if (!document.hidden && !$("view-members").hidden) loadPoints(); }, 15000);
