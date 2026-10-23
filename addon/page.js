// Runs on the hotel sites. It only looks at what is already on the screen and hands the text to
// your Hotel Search web app on the NAS, which does all the reading (hotels, prices, points, sign-in).
// That way fixes for a changed hotel site only need a web app update, not a new add-on.
//  1. On the search tabs the add-on opened: scroll through the results and send the page to the NAS
//     until the NAS says the list is complete.
//  2. On any other page of the site: send the page header so the NAS can see whether you're signed in.
(async () => {
  // Which site this is; the NAS knows the chains by their web address.
  const CHAIN = location.hostname.replace(/^www\./, "");
  const B = typeof browser !== "undefined" && browser.runtime ? browser : chrome;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = () => (document.body ? document.body.innerText : "");
  // Works whether the browser answers messages with a promise (Chrome) or only a callback (Orion).
  const ask = (msg, ms = 8000) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v === undefined ? null : v); } };
    setTimeout(() => finish(null), ms);
    try {
      const p = B.runtime.sendMessage(msg, (r) => finish(r));
      if (p && p.then) p.then(finish, () => finish(null));
    } catch (e) { finish(null); }
  });
  const tell = (msg) => { try { const p = B.runtime.sendMessage(msg); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } };

  // Amex: only the Membership Rewards points line (and whether you're signed in) ever leaves this page —
  // nothing else from your bank account is read or sent.
  if (/americanexpress\.com$/.test(location.hostname)) {
    let last = "";
    const started = Date.now();
    while (Date.now() - started < 600000) {
      await sleep(Date.now() - started < 20000 ? 3000 : 8000);
      if (document.hidden) continue;
      const lines = text().split("\n").map((l) => l.trim()).filter(Boolean);
      const keep = [];
      lines.forEach((l, i) => {
        if (/Membership Rewards|Punkte|\bpoints\b/i.test(l)) keep.push(lines[i - 1] || "", l, lines[i + 1] || "");
        else if (/^(Abmelden|Log ?out|Sign ?out|Anmelden|Log ?in|Sign ?in)$/i.test(l)) keep.push(l);
      });
      const snippet = keep.filter((l) => l.length < 80).slice(0, 30).join("\n");
      if (snippet && snippet !== last) { last = snippet; tell({ type: "accountPage", chain: CHAIN, text: snippet }); }
    }
    return;
  }

  let task = null;
  for (let i = 0; i < 3 && !task; i++) {
    task = await ask({ type: "whoAmI", chain: CHAIN, url: location.href }, 4000);
    if (task && task.retry) { location.replace(task.retry); return; }
    if (!task && i < 2) await sleep(1500);
  }
  tell({ type: "log", where: "page", chain: CHAIN, url: location.href.slice(0, 160), task: task ? task.key : "none", visible: !document.hidden });

  if (!task) {
    // Job 2: sign-in state. Some sites (IHG) sign you in without reloading, so keep an eye on it for a while.
    let lastHead = "";
    const started = Date.now();
    while (Date.now() - started < 600000) {
      await sleep(Date.now() - started < 20000 ? 3000 : 6000);
      if (document.hidden) continue;
      const head = text().slice(0, 4000);
      if (head && head.slice(0, 1500) !== lastHead) {
        lastHead = head.slice(0, 1500);
        tell({ type: "accountPage", chain: CHAIN, text: head });
      }
    }
    return;
  }

  // Job 1: a results page. Scroll down a screen at a time like a reader would, and let the NAS
  // say how many hotels it can see, until the list stops growing.
  const started = Date.now();
  let last = -1, stable = 0, reply = null;
  while (Date.now() - started < 110000) {
    await sleep(2500);
    tell({ type: "tick", key: task.key }); // lets the add-on bring the next tab forward
    reply = await ask({ type: "read", key: task.key, chain: CHAIN, text: text(), final: false });
    if (reply && reply.blocked) break;
    const n = reply ? reply.hotels : 0;
    if (reply && reply.expected && n >= reply.expected) break;
    if (!document.hidden) window.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" });
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 50;
    if (n > 0 && n === last) stable++; else stable = 0;
    last = n;
    if (n > 0 && stable >= (reply && reply.expected ? 5 : 3) && atBottom) break;
  }
  tell({ type: "read", key: task.key, chain: CHAIN, text: text(), links: links(), final: true });

  // The booking links on the page, each with the text of the hotel card around it, so the NAS can
  // give every hotel in your list its own direct link.
  function links() {
    const out = [];
    const distRe = /from destination|\d+(?:[.,]\d+)?\s*(?:miles?|km)\b/i;
    const cardOf = (el) => { let c = el; for (let i = 0; i < 14 && c; i++, c = c.parentElement) if (distRe.test(c.innerText || "")) return c; return null; };
    for (const a of document.querySelectorAll("a[href]")) {
      if (out.length >= 300) break;
      const label = (a.innerText || "").trim().slice(0, 160);
      if (!label || /^javascript:/.test(a.href)) continue;
      if (/View Rates|Select Hotel|Book now|See rates|View hotel/i.test(label)) {
        const card = cardOf(a);
        if (card) out.push({ href: a.href, label, card: (card.innerText || "").slice(0, 1500) });
      } else if (label.length > 8 && label.length < 120 && !label.includes("\n")) {
        out.push({ href: a.href, label });
      }
    }
    return out;
  }
})();
