const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? "" : Math.round(n).toLocaleString("de-AT"));
const eur = (n) => (n == null ? "" : "€" + Math.round(n).toLocaleString("de-AT"));
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
const STATUS = { waiting: "waiting…", loading: "reading…", done: "done", empty: "no results found", timeout: "took too long", blocked: "site refused", manual: "open to check" };
const CHAINS = {
  Marriott: { program: "Bonvoy", login: "https://www.marriott.com/en-gb/sign-in.mi" },
  Hilton: { program: "Honors", login: "https://www.hilton.com/en/hilton-honors/login/" },
  IHG: { program: "One Rewards", login: "https://www.ihg.com/rewardsclub/us/en/sign-in" },
};
const MANUAL = ["Amex Membership Rewards", "ALL Accor", "Radisson Rewards", "MeliáRewards", "GHA DISCOVERY"];
const TIERS = {
  Marriott: ["Member", "Silver Elite", "Gold Elite", "Platinum Elite", "Titanium Elite", "Ambassador Elite"],
  Hilton: ["Member", "Silver", "Gold", "Diamond", "Lifetime Diamond"],
  IHG: ["Club Member", "Silver Elite", "Gold Elite", "Platinum Elite", "Diamond Elite"],
  "ALL Accor": ["Classic", "Silver", "Gold", "Platinum", "Diamond", "Limitless"],
  "Radisson Rewards": ["Club", "Premium", "VIP"],
  "MeliáRewards": ["Member", "Silver", "Gold", "Platinum", "Ambassador"],
  "GHA DISCOVERY": ["Bronze", "Silver", "Gold", "Platinum", "Titanium"],
};
const AIRPORT = /airport|a[ée]roport|aeroporto|flughafen|aeropuerto|lotnisko|\bCDG\b|orly|roissy|schiphol|heathrow|gatwick|stansted|luton|fiumicino|malpensa|barajas|el prat|tegel|brandenburg|\bBER\b|schwechat|\bVIE\b|\bJFK\b|\bLAX\b|\bLHR\b/i;

// ---------- Add-on handshake ----------
let addonReady = false, addonVersion = "", addonBroken = false;
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.source !== "hs-addon") return;
  if (e.data.type === "ready") {
    addonReady = e.data.working !== false;
    addonVersion = e.data.version || "";
    addonBroken = e.data.working === false;
    showAddon();
  }
  if (e.data.type === "started" && !e.data.ok) {
    $("place").textContent = "The add-on received the search but couldn't open the hotel pages" +
      (e.data.details && e.data.details.error ? ` (${e.data.details.error})` : "") + ". Use the open links below.";
  }
});
function showAddon() {
  $("addon").className = "pill " + (addonReady ? "ok" : "no");
  $("addon").textContent = addonReady ? `Reader add-on working · ${addonVersion}`
    : addonBroken ? `Add-on ${addonVersion} found, but not responding`
    : "No reader add-on in this browser";
}
window.postMessage({ source: "hs-page", type: "ping" }, "*");
setTimeout(showAddon, 1500);

// ---------- Form ----------
(() => {
  const d = new Date(); d.setDate(d.getDate() + ((11 - d.getDay()) % 7 || 7));
  const iso = (x) => x.toISOString().slice(0, 10);
  $("checkIn").value = iso(d); d.setDate(d.getDate() + 2); $("checkOut").value = iso(d);
})();

let suggest = [], suggestTimer;
$("city").addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = $("city").value.split(",")[0].trim();
  if (q.length < 2) return;
  suggestTimer = setTimeout(async () => {
    suggest = await api("/api/geocode?q=" + encodeURIComponent(q)).catch(() => []);
    $("citylist").innerHTML = suggest.map((g) => `<option value="${esc(label(g))}">`).join("");
  }, 300);
});
const label = (g) => [g.city, g.region, g.country].filter(Boolean).join(", ");

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
  $("go").disabled = true;
  try {
    const place = await resolvePlace($("city").value.trim());
    const params = { ...place, checkIn, checkOut, adults: Number($("adults").value) };
    const { id } = await api("/api/searches", { method: "POST", body: JSON.stringify(params) });
    $("place").textContent = `${place.city}, ${place.country} · ${HotelUrls.nights(checkIn, checkOut)} nights · ` +
      (addonReady ? "opening the hotel sites — they flip through for about half a minute, then you're brought back here…" : "open each site below to check prices.");
    if (addonReady) window.postMessage({ source: "hs-page", type: "start", searchId: id, params, jobs: HotelUrls.build(params), apiBase: location.origin }, "*");
    await loadSearch(id, true);
    loadHistory();
  } catch (err) {
    $("place").textContent = err.message;
  } finally {
    $("go").disabled = false;
  }
});

// ---------- Search results ----------
let current = null, pollTimer = null, chainOn = "All";
async function loadSearch(id, live = false) {
  clearTimeout(pollTimer);
  const s = await api("/api/searches/" + id);
  current = s;
  render();
  if (live) tripInfo(s.params);
  const started = s.created * 1000;
  const keys = HotelUrls.build(s.params).map((j) => j.key);
  const done = keys.every((k) => s.results.some((r) => r.key === k && r.status !== "loading"));
  if (addonReady && !done && Date.now() - started < 180000) pollTimer = setTimeout(() => loadSearch(id), 2000);
}

function render() {
  const s = current; if (!s) return;
  const jobs = HotelUrls.build(s.params);
  const byKey = Object.fromEntries(s.results.map((r) => [r.key, r]));
  const tooOld = Date.now() - s.created * 1000 > 180000;
  const fresh = !tooOld;
  $("resultsTitle").hidden = false;
  $("resultsTitle").innerHTML = `${fresh ? "Current search" : "Last search"}: ${esc(s.params.city)} · ${fmtDates(s.params)} · ${s.params.adults} guests <span class="muted">· ${ago(s.created)}</span>`;

  $("sources").hidden = false;
  $("sources").innerHTML = jobs.map((j) => {
    const r = byKey[j.key];
    const st = r ? r.status : (!addonReady || tooOld ? "manual" : "waiting");
    const n = r && r.status === "done" ? ` (${(r.hotels || []).length})` : "";
    return `<span class="chip ${st}"><span class="dot"></span>${j.chain}${j.kind === "cash+points" ? "" : " " + j.kind} · ${STATUS[st] || st}${n}
      · <a href="${esc(j.url)}" target="_blank" rel="noopener">open</a></span>`;
  }).join("");

  const out = [...new Set(s.results.filter((r) => r.signedIn === false).map((r) => r.chain))];
  $("warn").hidden = !out.length;
  $("warn").textContent = out.length ? `Not signed in at ${out.join(" and ")} during this search, so those prices may be public rates and points may be missing. Sign in under “Points & accounts”, then search again.` : "";

  const nights = HotelUrls.nights(s.params.checkIn, s.params.checkOut);
  const map = new Map();
  for (const r of s.results) for (const h of r.hotels || []) {
    if (!h.name) continue;
    const key = r.chain + "|" + h.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const row = map.get(key) || { name: h.name, chain: r.chain, url: r.url };
    if (h.link && (!row.link || r.kind !== "points")) row.link = h.link;
    if (h.distanceKm != null) row.dist = h.distanceKm;
    if (h.cashPerNight != null && r.kind !== "points") row.cash = h.cashPerNight;
    if (h.cashTotal != null && r.kind !== "points") row.total = h.cashTotal;
    if (h.points != null && r.kind !== "cash") { row.points = h.points; row.unit = h.pointsUnit; }
    if (h.soldOut) row.soldOut = true;
    if (h.pointsLimited && r.kind !== "cash") row.pointsLimited = true;
    map.set(key, row);
  }
  let rows = [...map.values()].filter((r) => r.cash != null || r.points != null || r.soldOut);
  for (const r of rows) if (r.total == null && r.cash != null) r.total = r.cash * nights;
  const chains = ["All", ...new Set(rows.map((r) => r.chain))];
  if (!chains.includes(chainOn)) chainOn = "All";
  $("chainFilter").innerHTML = chains.map((c) => `<button type="button" class="${c === chainOn ? "on" : ""}" data-c="${esc(c)}">${esc(c)}</button>`).join("");
  $("chainFilter").querySelectorAll("button").forEach((b) => b.onclick = () => { chainOn = b.dataset.c; render(); });
  if (chainOn !== "All") rows = rows.filter((r) => r.chain === chainOn);
  const maxKm = Number($("maxKm").value) || null;
  if (maxKm) rows = rows.filter((r) => r.dist == null || r.dist <= maxKm);
  if ($("noAirport").checked) rows = rows.filter((r) => !AIRPORT.test(r.name));
  const big = Number.MAX_SAFE_INTEGER, by = $("sort").value;
  rows.sort((a, b) => by === "points" ? (a.points ?? big) - (b.points ?? big)
    : by === "dist" ? (a.dist ?? big) - (b.dist ?? big)
    : by === "chain" ? a.chain.localeCompare(b.chain) || (a.cash ?? big) - (b.cash ?? big)
    : (a.soldOut ? 1 : 0) - (b.soldOut ? 1 : 0) || (a.cash ?? big) - (b.cash ?? big));

  $("resultsWrap").hidden = !map.size;
  $("count").textContent = `${rows.length} hotels · ${s.params.city} · ${nights} nights · ${fmtDates(s.params)}`;
  $("rows").innerHTML = rows.map((r) => `
    <tr>
      <td class="name"><a href="${esc(r.link || r.url || "#")}" target="_blank" rel="noopener" title="${r.link ? "Open this hotel's offer" : "Open the search page"}">${esc(r.name)}</a>${r.soldOut ? ' <span class="tag">sold out</span>' : ""}</td>
      <td><span class="tag">${esc(r.chain)}</span></td>
      <td class="num">${r.dist != null ? r.dist.toLocaleString("de-AT") + " km" : ""}</td>
      <td class="num">${eur(r.cash)}</td>
      <td class="num">${eur(r.total)}</td>
      <td class="num">${r.points != null ? fmt(r.points) + ` <span class="muted">/ ${esc(r.unit)}</span>` : ""}${r.pointsLimited ? ' <span class="muted">(not all nights)</span>' : ""}</td>
    </tr>`).join("");
}
for (const id of ["sort", "maxKm", "noAirport"]) $(id).addEventListener("change", () => { saveFilters(); render(); });
function saveFilters() { try { localStorage.setItem("hs-filters", JSON.stringify({ sort: $("sort").value, maxKm: $("maxKm").value, noAirport: $("noAirport").checked })); } catch (e) {} }
try { const f = JSON.parse(localStorage.getItem("hs-filters") || "{}"); if (f.sort) $("sort").value = f.sort; if (f.maxKm != null) $("maxKm").value = f.maxKm; $("noAirport").checked = !!f.noAirport; } catch (e) {}
const fmtDates = (p) => {
  const f = (d) => new Date(d + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${f(p.checkIn)} – ${f(p.checkOut)}`;
};

// ---------- Weather, holidays, flights ----------
async function tripInfo(p) {
  $("trip").hidden = false;
  $("weather").innerHTML = `<h3>Weather in ${esc(p.city)}</h3><p class="muted">Loading…</p>`;
  renderExtras(p, null);
  api(`/api/weather?lat=${p.lat}&lon=${p.lon}&start=${p.checkIn}&end=${p.checkOut}`).then((w) => {
    const title = w.mode === "forecast" ? `Forecast for ${esc(p.city)}` : `${esc(p.city)} on these dates last year`;
    const note = w.mode === "forecast" ? "" : `<p class="muted">The real forecast appears from ${new Date(w.available_from + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}.</p>`;
    $("weather").innerHTML = `<h3>${title}</h3><div class="days">${w.days.map((d) => `
      <div class="day"><div class="d">${new Date(d.date + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })}</div>
      <div class="i" title="${esc(d.text)}">${d.icon}</div><div class="t">${Math.round(d.max)}°</div>
      <div class="r">${Math.round(d.min)}° · ${d.rain ? d.rain.toFixed(1) + " mm" : "dry"}</div></div>`).join("")}</div>${note}`;
  }).catch(() => { $("weather").innerHTML = `<h3>Weather</h3><p class="muted">Not available right now.</p>`; });
  api(`/api/holidays?cc=${p.countryCode}&start=${p.checkIn}&end=${p.checkOut}`).then((h) => renderExtras(p, h)).catch(() => renderExtras(p, []));
}
function renderExtras(p, hol) {
  const from = localStorage.getItem("hs-from") || "Vienna";
  const q = encodeURIComponent(`Flights from ${from} to ${p.city} on ${p.checkIn} through ${p.checkOut}`);
  $("extras").innerHTML = `<h3>For this trip</h3>
    <div class="row">✈️ <a href="https://www.google.com/travel/flights?q=${q}" target="_blank" rel="noopener">Google Flights from</a>
      <input id="from" value="${esc(from)}" aria-label="Flying from"></div>
    <div>${hol == null ? '<p class="muted">Checking public holidays…</p>'
      : hol.length ? `🗓️ Public holidays during your stay:<ul>${hol.map((x) => `<li>${new Date(x.date + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}: ${esc(x.name)}</li>`).join("")}</ul>`
      : '<p class="muted">🗓️ No public holidays during your stay.</p>'}</div>`;
  $("from").onchange = () => { localStorage.setItem("hs-from", $("from").value.trim() || "Vienna"); renderExtras(p, hol); };
}

// ---------- Points ----------
async function loadPoints() {
  const { latest, history, accounts, status = {} } = await api("/api/points").catch(() => ({ latest: {}, history: {}, accounts: {}, status: {} }));
  const tierHtml = (p) => {
    const st = status[p];
    const opts = TIERS[p];
    if (!opts) return "";
    return `<div class="tier">${st ? esc(st.tier) : ""}</div>
      <select data-tier="${esc(p)}" aria-label="${esc(p)} status"><option value="">${st ? "Change status…" : "Set your status…"}</option>${opts.map((o) => `<option ${st && st.tier === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  };
  const auto = Object.entries(CHAINS).map(([chain, c]) => {
    const l = latest[chain], a = accounts[chain] || {};
    const prev = (history[chain] || [])[1];
    // A sign-in only counts if it was seen recently: logins expire, and each browser has its own.
    const fresh = a.checked && Date.now() / 1000 - a.checked < 3600;
    const signedNow = a.signedIn === true && fresh;
    const state = signedNow ? `<span class="meta ok">Signed in · checked ${ago(a.checked)}</span>`
      : a.signedIn === false && fresh ? `<span class="meta no">Not signed in</span>`
      : `<span class="meta">Sign in before searching</span>`;
    return `<div class="pt"><div class="name">${chain} <span class="muted">${c.program}</span></div>
      <div class="bal">${l ? fmt(l.balance) : "–"}</div>
      ${prev ? `<span class="delta">${l.balance >= prev.balance ? "+" : ""}${fmt(l.balance - prev.balance)} since ${ago(l.ts)}</span>` : l ? `<span class="delta">updated ${ago(l.ts)}</span>` : ""}
      ${tierHtml(chain)}
      ${state}
      <div><button class="ghost" data-login="${c.login}">${signedNow ? "Open site" : "Sign in"}</button></div></div>`;
  });
  const manual = MANUAL.map((p) => {
    const l = latest[p];
    return `<div class="pt manual" data-program="${esc(p)}"><div class="name">${esc(p)}</div>
      <div class="bal">${l ? fmt(l.balance) : "–"}</div>
      <span class="meta">${l ? "updated " + ago(l.ts) : "Tap to enter your balance"}</span>${tierHtml(p)}</div>`;
  });
  $("points").innerHTML = auto.concat(manual).join("");
  $("points").querySelectorAll("[data-login]").forEach((b) => b.onclick = () => window.open(b.dataset.login, "_blank"));
  $("points").querySelectorAll("select[data-tier]").forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = async () => { await api("/api/status", { method: "POST", body: JSON.stringify({ program: sel.dataset.tier, tier: sel.value }) }); loadPoints(); };
  });
  $("points").querySelectorAll("[data-program]").forEach((el) => el.onclick = async (ev) => {
    if (ev.target.closest("select")) return;
    const v = prompt(`Current ${el.dataset.program} balance:`);
    if (v == null) return;
    const n = Number(String(v).replace(/[^\d]/g, ""));
    if (!Number.isFinite(n) || String(v).replace(/[^\d]/g, "") === "") return;
    await api("/api/points", { method: "POST", body: JSON.stringify({ program: el.dataset.program, balance: n }) });
    loadPoints();
  });
}

// ---------- History ----------
async function loadHistory() {
  const list = await api("/api/searches?limit=10").catch(() => []);
  $("history").innerHTML = list.length ? list.map((s) => `
    <button type="button" data-id="${s.id}"><span>${esc(s.params.city)}, ${esc(s.params.country)} · ${fmtDates(s.params)} · ${s.params.adults} guests</span>
    <span class="muted">${ago(s.created)}</span></button>`).join("") : '<div class="empty-note">Your searches will appear here.</div>';
  $("history").querySelectorAll("button[data-id]").forEach((b) => b.onclick = () => { loadSearch(Number(b.dataset.id), true); window.scrollTo({ top: 0, behavior: "smooth" }); });
}

loadPoints();
loadHistory();
// The page starts empty: points and recent searches only. Open a recent search to see it again.
setInterval(() => { if (!document.hidden) loadPoints(); }, 8000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadPoints(); });

// ---------- Settings & updates ----------
$("gear").onclick = () => { $("settings").hidden = !$("settings").hidden; };
api("/api/health").then((h) => { $("version").textContent = h.version || "0.3"; }).catch(() => {});
// The newest add-on that this web app version ships (the add-on rarely changes now).
const ADDON_LATEST = "0.6.0";
const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

async function checkUpdates() {
  try {
    const u = await api("/api/admin/update-status");
    $("keyBox").open = !u.hasKey;
    if (!u.hasKey) { $("latestInfo").textContent = "add your GitHub key below to get one-tap updates"; $("ghGo").hidden = true; }
    else if (u.error) { $("latestInfo").textContent = u.error; $("ghGo").hidden = true; }
    else if (newer(u.latest, u.current)) { $("latestInfo").innerHTML = `<b>version ${u.latest} is ready</b>`; $("ghGo").hidden = false; $("gear").classList.add("dot"); }
    else { $("latestInfo").textContent = "up to date"; $("ghGo").hidden = true; }
  } catch (e) { $("latestInfo").textContent = "couldn't check for updates"; }
  if (addonVersion && newer(ADDON_LATEST, addonVersion))
    $("addonAdvice").innerHTML = `<b>Your add-on (${addonVersion}) is older than ${ADDON_LATEST} — please reinstall it.</b>`;
}
checkUpdates();
setTimeout(checkUpdates, 3000); // again once the add-on has said hello
$("ghGo").onclick = async () => {
  $("ghGo").disabled = true; $("ghMsg").textContent = "Downloading and installing…";
  try {
    await api("/api/admin/update-from-github", { method: "POST", body: "{}" });
    $("ghMsg").textContent = "Installed. Restarting… the page reloads in a few seconds.";
    setTimeout(() => location.reload(), 6000);
  } catch (e) { $("ghMsg").textContent = e.message; $("ghGo").disabled = false; }
};
$("ghKeyGo").onclick = async () => {
  const key = $("ghKey").value.trim();
  if (!key) return;
  $("ghMsg").textContent = "Checking the key…";
  try {
    const r = await api("/api/admin/key", { method: "POST", body: JSON.stringify({ key }) });
    $("ghKey").value = "";
    $("ghMsg").textContent = r.ok ? "Key saved — it works." : "Key saved, but: " + r.error;
    checkUpdates();
  } catch (e) { $("ghMsg").textContent = e.message; }
};
$("updGo").onclick = async () => {
  const f = $("updFile").files[0];
  if (!f) { $("updMsg").textContent = "Choose the update file first."; return; }
  $("updGo").disabled = true; $("updMsg").textContent = "Installing…";
  try {
    const r = await fetch("/api/admin/update", { method: "POST", headers: { "Content-Type": "application/gzip" }, body: await f.arrayBuffer() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Update failed");
    $("updMsg").textContent = "Installed. Restarting… the page reloads in a few seconds.";
    setTimeout(() => location.reload(), 5000);
  } catch (e) { $("updMsg").textContent = e.message; $("updGo").disabled = false; }
};
