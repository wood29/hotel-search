// The add-on's background part: opens the hotel tabs for a search, keeps them moving, and passes
// what each page shows to your Hotel Search web app on the NAS. All reading happens on the NAS.

// Some browsers (e.g. Orion on iPad) only offer part of the add-on features.
// Everything optional is checked first, so a missing feature never stops the whole add-on.
const B = typeof browser !== "undefined" && browser.runtime ? browser : chrome;
const has = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), B) != null;
const VERSION = B.runtime.getManifest().version;
const DEFAULT_APP = "http://homeserver.taild317c2.ts.net:8095";
const TIMEOUT_MS = 150000;
let lastRotate = 0;
let timeoutTimer = null;
let rotateTimer = null;

const store = {
  async get(k) { try { return (await B.storage.local.get(k))[k]; } catch (e) { return memory[k]; } },
  async set(k, v) { memory[k] = v; try { await B.storage.local.set({ [k]: v }); } catch (e) { /* memory only */ } },
};
const memory = {};
const safe = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* not supported here */ } };

// Clicking the add-on's icon opens your Hotel Search web app (where the browser has an icon).
if (has("action.onClicked")) B.action.onClicked.addListener(async () => {
  B.tabs.create({ url: ((await store.get("apiBase")) || DEFAULT_APP) + "/" });
});

// One shared copy of the running search, so two hotel pages finishing at the same moment
// can't overwrite each other's progress.
let current = null;
const getState = async () => current || (current = (await store.get("search")) || null);
const setState = (s) => { current = s; return store.set("search", s); };

B.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      if (msg.type === "ping") reply({ ok: true, version: VERSION, windows: has("windows.create"), alarms: has("alarms.create") });
      else if (msg.type === "start") reply(await start(msg, sender.tab));
      else if (msg.type === "openTab") reply(await openTab(msg.url));
      else if (msg.type === "hello") { await store.set("apiBase", msg.apiBase); reply(true); }
      else if (msg.type === "whoAmI") reply(await claimTask(sender.tab && sender.tab.id, msg));
      else if (msg.type === "tick") { await rotate(); reply(true); }
      else if (msg.type === "read") reply(await readPage(sender.tab && sender.tab.id, msg));
      else if (msg.type === "accountPage") { await post("/api/account-page", { site: msg.chain, text: msg.text }); reply(true); }
      else if (msg.type === "log") { log({ ...msg, senderTab: sender.tab ? sender.tab.id : "none" }); reply(true); }
      else reply(null);
    } catch (e) {
      reply({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});

function log(entry) { post("/api/debug", { v: VERSION, ...entry }); }

async function post(path, body, apiBase) {
  const base = apiBase || (await store.get("apiBase"));
  if (!base) return null;
  try {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return null; /* web app unreachable */ }
}

// Waits for a browser call, but never longer than a few seconds (some browsers never answer).
const within = (p, ms = 4000) => Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);

// Only the hotel and Amex sites this add-on works with can be opened this way.
const OPENABLE = /^https:\/\/([a-z0-9-]+\.)*(marriott\.com|hilton\.com|ihg\.com|accor\.com|radissonhotels\.com|melia\.com|ghadiscovery\.com|nh-hotels\.com|americanexpress\.com)(\/|$)/i;
async function openTab(url) {
  if (!OPENABLE.test(String(url || ""))) return { ok: false, error: "not a hotel site" };
  const t = await within(B.tabs.create({ url, active: true }), 4000);
  return { ok: true, tab: t ? t.id : null };
}

async function start({ searchId, params, jobs: given, apiBase }, appTab) {
  const old = await getState();
  if (old && old.windowId && has("windows.remove")) safe(() => B.windows.remove(old.windowId));
  if (old && old.tasks) for (const t of Object.values(old.tasks)) if (t.status === "loading" && t.tabId) safe(() => B.tabs.remove(t.tabId));
  await store.set("apiBase", apiBase);
  // The web app says which pages to open (so new sites or changed links only need a web app update).
  const jobs = Array.isArray(given) && given.length ? given : [];
  if (!jobs.length) return { ok: false, error: "web app too old — update it from ⚙︎" };
  // Record the search first, so hotel pages can find their job however the tabs get opened.
  const state = { searchId, apiBase, params, startedAt: Date.now(), windowId: null,
                  appTabId: appTab ? appTab.id : null, appWindowId: appTab ? appTab.windowId : null, tasks: {} };
  jobs.forEach((j) => { state.tasks[j.key] = { ...j, tabId: null, status: "loading" }; });
  await setState(state);
  for (const t of Object.values(state.tasks)) post(`/api/searches/${searchId}/results`, { key: t.key, chain: t.chain, kind: t.kind, url: t.url, status: "loading" }, apiBase);
  if (has("alarms.create")) safe(() => B.alarms.create("timeout", { when: Date.now() + TIMEOUT_MS }));
  clearTimeout(timeoutTimer);
  timeoutTimer = setTimeout(onTimeout, TIMEOUT_MS + 2000);
  // Browsers only fully draw pages that are on screen, so the add-on brings each hotel tab
  // forward in turn while it loads — in its own window on a computer, as tabs on an iPad.
  let win = null, tabs = [], how = "tabs";
  if (has("windows.create")) {
    win = await within(B.windows.create({ url: jobs.map((j) => j.url), focused: true, width: 1200, height: 860, type: "normal" }), 6000);
    if (win) {
      how = "window";
      const list = win.tabs || [];
      // Orion on iPad puts the pages into your current window; then the tab numbers can't be trusted.
      if ((appTab && win.id === appTab.windowId) || list.length !== jobs.length) { how = "window-shared"; win = null; }
      else tabs = list;
    }
  }
  if (how === "tabs") {
    for (let i = 0; i < jobs.length; i++) tabs.push(await within(B.tabs.create({ url: jobs[i].url, active: i === 0 })));
  }
  const s = await getState();
  if (s && s.searchId === searchId) {
    s.windowId = win ? win.id : null;
    jobs.forEach((j, i) => { const t = s.tasks[j.key]; if (t && t.tabId == null && tabs[i] && tabs[i].id != null) t.tabId = tabs[i].id; });
    await setState(s);
  }
  clearInterval(rotateTimer);
  rotateTimer = setInterval(() => rotate(), 4000);
  log({ where: "start", search: searchId, how, tabIds: tabs.map((t) => t && t.id).join(",") });
  return { ok: true, tabs: jobs.length, window: !!win };
}

async function rotate() {
  if (Date.now() - lastRotate < 3500) return;
  lastRotate = Date.now();
  const s = await getState();
  if (!s || !s.tasks) return;
  const loading = Object.values(s.tasks).filter((t) => t.status === "loading" && t.tabId);
  if (!loading.length) return;
  s.rot = ((s.rot || 0) + 1) % loading.length;
  await setState(s);
  safe(() => B.tabs.update(loading[s.rot].tabId, { active: true }));
}

// Which search job is this hotel tab? Normally matched by tab number; some browsers (Orion on
// iPad) don't tell the add-on which tab a page is in, so fall back to the page's web address.
let claimQueue = Promise.resolve();
function claimTask(tabId, msg) { // one at a time, so two tabs never grab the same job
  const run = claimQueue.then(() => claimTaskNow(tabId, msg));
  claimQueue = run.catch(() => {});
  return run;
}
async function claimTaskNow(tabId, msg) {
  const s = await getState();
  if (!s || !s.tasks) return null;
  const open = Object.values(s.tasks).filter((t) => t.status === "loading");
  let t = tabId != null ? open.find((x) => x.tabId === tabId) : null;
  if (!t && msg.url && Date.now() - s.startedAt < TIMEOUT_MS) {
    const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
    const free = open.filter((x) => host(x.url) === host(msg.url) && !x.claimed);
    const href = msg.url;
    // Cash and points versions of the same site differ by one part of the address (the web app says which).
    const marker = (x) => !x.marker || (x.marker.startsWith("!") ? !href.includes(x.marker.slice(1)) : href.includes(x.marker));
    const onSearchPage = free.some((x) => x.searchPath && href.includes(x.searchPath));
    t = free.find((x) => x.url === href) || (onSearchPage ? free.find(marker) || free[0] : null);
    // The site sent our tab to its home page instead of the results (Marriott does this when its
    // session is new). Load the search address once more in that same tab.
    const path = (() => { try { return new URL(href).pathname; } catch (e) { return ""; } })();
    const isHome = /^\/([a-z]{2}(-[a-z]{2})?\/)?(default\.mi|index\.html)?$/i.test(path) || /expiredSession/i.test(path);
    if (!t && isHome && free.length && Date.now() - s.startedAt < 45000) {
      const again = free.find((x) => !x.retried);
      if (again) {
        again.retried = true;
        await setState(s);
        log({ where: "whoAmI", senderTab: tabId == null ? "none" : tabId, url: String(href).slice(0, 160), retry: again.key });
        return { retry: again.url };
      }
    }
  }
  log({ where: "whoAmI", senderTab: tabId == null ? "none" : tabId, chain: msg.chain, url: String(msg.url || "").slice(0, 160), got: t ? t.key : "none" });
  if (!t) return null;
  t.claimed = true;
  if (tabId != null) t.tabId = tabId;
  await setState(s);
  return { key: t.key, chain: t.chain, kind: t.kind };
}

// A hotel page sends its text here every few seconds; the NAS reads it and says how many hotels
// it sees. The last one ("final") is stored as the result for that site.
async function readPage(tabId, msg) {
  const s = await getState();
  const t = s && s.tasks && msg.key ? s.tasks[msg.key] : null;
  if (!t) return null;
  const r = await post("/api/read", { searchId: s.searchId, key: t.key, chain: t.chain, kind: t.kind, url: t.url,
                                      text: msg.text, links: msg.links || [], final: !!msg.final }, s.apiBase);
  if (!msg.final || t.status !== "loading") return r;
  t.status = (r && r.status) || "empty";
  await setState(s);
  log({ where: "result", key: t.key, status: t.status, hotels: r ? r.hotels : "no reply" });
  const closeId = tabId != null ? tabId : t.tabId;
  if (t.status === "done" && closeId != null) safe(() => B.tabs.remove(closeId));
  await finishIfDone(s);
  return r;
}

async function finishIfDone(s) {
  const open = Object.values(s.tasks).filter((t) => t.status === "loading");
  if (open.length) { lastRotate = 0; return rotate(); }
  clearTimeout(timeoutTimer);
  clearInterval(rotateTimer);
  if (s.windowId && has("windows.remove")) safe(() => B.windows.remove(s.windowId));
  if (s.appTabId) safe(() => B.tabs.update(s.appTabId, { active: true }));
  if (s.appWindowId && has("windows.update")) safe(() => B.windows.update(s.appWindowId, { focused: true }));
  s.windowId = null;
  await setState(s);
}


async function onTimeout() {
  const s = await getState();
  if (!s || !s.tasks) return;
  let changed = false;
  for (const t of Object.values(s.tasks)) if (t.status === "loading") {
    t.status = "timeout"; changed = true;
    await post(`/api/searches/${s.searchId}/results`, { key: t.key, chain: t.chain, kind: t.kind, url: t.url, status: "timeout" }, s.apiBase);
  }
  if (changed) { log({ where: "timeout", search: s.searchId }); await setState(s); }
  await finishIfDone(s);
}
if (has("alarms.onAlarm")) B.alarms.onAlarm.addListener((a) => { if (a.name === "timeout") onTimeout(); });
