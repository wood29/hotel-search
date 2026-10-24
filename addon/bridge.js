// Runs only on your Hotel Search web app. It lets the web app's Search button hand the search
// over to this add-on, and reports whether the add-on's background part is really working.
(() => {
  const B = typeof browser !== "undefined" && browser.runtime ? browser : chrome;
  const version = B.runtime.getManifest().version;
  const send = (msg, ms = 3000) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), ms);
    try {
      const p = B.runtime.sendMessage(msg, (r) => finish(r === undefined ? null : r));
      if (p && p.then) p.then(finish, () => finish(null));
    } catch (e) { finish(null); }
  });
  const post = (data) => window.postMessage({ source: "hs-addon", version, ...data }, "*");

  async function hello() {
    send({ type: "hello", apiBase: location.origin });
    const r = await send({ type: "ping" });
    post({ type: "ready", working: !!(r && r.ok), details: r || null });
  }
  hello();
  window.addEventListener("message", async (e) => {
    if (e.source !== window || !e.data || e.data.source !== "hs-page") return;
    if (e.data.type === "ping") hello();
    if (e.data.type === "open") {
      // Sign-in pages opened by the add-on load in this browser, not in the hotel's own app.
      const r = await send({ type: "openTab", url: e.data.url });
      post({ type: "opened", ok: !!(r && r.ok), url: e.data.url });
    }
    if (e.data.type === "start") {
      const r = await send({ type: "start", searchId: e.data.searchId, params: e.data.params, jobs: e.data.jobs, apiBase: location.origin }, 30000);
      post({ type: "started", ok: !!(r && r.ok), details: r || null });
    }
  });
})();
