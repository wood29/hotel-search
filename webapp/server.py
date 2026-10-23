"""Hotel Search web app — runs on the NAS.

Plain Python standard library only (no installs), SQLite for storage.
The browser add-on reads hotel results in Michael's own browser and posts them here;
this server stores searches, results and points history, and adds weather and holidays.
"""
import io, json, os, re, shutil, sqlite3, sys, tarfile, threading, time, urllib.parse, urllib.request
import urllib.error
import readers
from datetime import date, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DB_PATH = os.environ.get("DB_PATH", "/data/hotel-search.db")
PORT = int(os.environ.get("PORT", "8095"))
LOCK = threading.Lock()
try:
    with open(os.path.join(ROOT, "VERSION")) as _f:
        VERSION = _f.read().strip()
except OSError:
    VERSION = "0.6.0"
REPO = os.environ.get("UPDATE_REPO", "wood29/hotel-search")  # where one-tap updates come from
TOKEN_PATH = os.path.join(os.path.dirname(DB_PATH), "github-token")
# Hotel sites by web address (the add-on only says which site a page is from).
SITES = {"marriott.com": "Marriott", "hilton.com": "Hilton", "ihg.com": "IHG"}
APP_DIR = os.path.join(os.path.dirname(DB_PATH), "app")

TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".zip": "application/zip"}


def db():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with db() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS searches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created REAL NOT NULL,
            params TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS results (
            search_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            chain TEXT, kind TEXT, status TEXT,
            payload TEXT, updated REAL,
            PRIMARY KEY (search_id, key));
        CREATE TABLE IF NOT EXISTS points (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            program TEXT NOT NULL,
            balance INTEGER NOT NULL,
            source TEXT NOT NULL,
            ts REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts (
            chain TEXT PRIMARY KEY,
            signed_in INTEGER, checked REAL);
        CREATE TABLE IF NOT EXISTS pages (
            search_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            chain TEXT, text TEXT, links TEXT, updated REAL,
            PRIMARY KEY (search_id, key));
        CREATE TABLE IF NOT EXISTS status (
            program TEXT PRIMARY KEY,
            tier TEXT, source TEXT, updated REAL);
        """)


def fetch_json(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": "hotel-search-private/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def record_points(con, program, balance, source):
    last = con.execute("SELECT balance FROM points WHERE program=? ORDER BY ts DESC LIMIT 1", (program,)).fetchone()
    if last is None or last["balance"] != balance:
        con.execute("INSERT INTO points (program, balance, source, ts) VALUES (?,?,?,?)",
                    (program, int(balance), source, time.time()))


def record_account(con, chain, signed_in, balance, tier):
    if signed_in is not None:
        con.execute("INSERT INTO accounts (chain, signed_in, checked) VALUES (?,?,?) "
                    "ON CONFLICT(chain) DO UPDATE SET signed_in=excluded.signed_in, checked=excluded.checked",
                    (chain, 1 if signed_in else 0, time.time()))
    if signed_in and isinstance(balance, (int, float)):
        record_points(con, chain, balance, "auto")
    if signed_in and tier:
        row = con.execute("SELECT source FROM status WHERE program=?", (chain,)).fetchone()
        if not row or row["source"] != "manual":
            con.execute("INSERT INTO status (program, tier, source, updated) VALUES (?,?,?,?) "
                        "ON CONFLICT(program) DO UPDATE SET tier=excluded.tier, source=excluded.source, updated=excluded.updated",
                        (chain, str(tier)[:40], "auto", time.time()))


def install_update(data):
    """Install a new version of this app from an uploaded .tar.gz and restart."""
    tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    names = tf.getnames()
    norm = [n[2:] if n.startswith("./") else n for n in names]
    if "server.py" not in norm or "static/index.html" not in norm or "readers.py" not in norm:
        raise ValueError("This doesn't look like a Hotel Search update (server.py, readers.py or static/index.html missing).")
    for m in tf.getmembers():
        n = m.name[2:] if m.name.startswith("./") else m.name
        if n.startswith("/") or ".." in n.split("/") or not (m.isfile() or m.isdir()):
            raise ValueError("Unsafe file in update: " + m.name)
    tmp = APP_DIR + ".new"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    for m in tf.getmembers():
        n = m.name[2:] if m.name.startswith("./") else m.name
        if not n or n == ".":
            continue
        dest = os.path.join(tmp, n)
        if m.isdir():
            os.makedirs(dest, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with tf.extractfile(m) as src, open(dest, "wb") as out:
                out.write(src.read())
    shutil.rmtree(APP_DIR, ignore_errors=True)
    os.rename(tmp, APP_DIR)

    def restart():
        time.sleep(1)
        os.execv(sys.executable, [sys.executable, "-u", os.path.join(APP_DIR, "server.py")])
    threading.Thread(target=restart, daemon=True).start()


def github(path, raw=False, timeout=20):
    """Read from the app's private GitHub repository with the read-only key saved in ⚙︎."""
    try:
        with open(TOKEN_PATH) as f:
            token = f.read().strip()
    except OSError:
        raise ValueError("No GitHub key saved yet — add it in ⚙︎ first.")
    req = urllib.request.Request("https://api.github.com/repos/" + REPO + path, headers={
        "Authorization": "Bearer " + token, "User-Agent": "hotel-search-private/1.0",
        "Accept": "application/vnd.github.raw" if raw else "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise ValueError("GitHub didn't accept the key — check it hasn't expired and can read " + REPO + ".")
        if e.code == 404:
            raise ValueError("GitHub can't find " + REPO + " with this key — check the key includes that repository.")
        raise ValueError(f"GitHub answered {e.code}.")
    except OSError as e:
        raise ValueError("Couldn't reach GitHub from the NAS: " + str(e))


def latest_version():
    return github("/contents/webapp/VERSION?ref=main", raw=True).decode().strip()


def install_from_github():
    """Download the newest web app from GitHub and install it (same checks as a manual update)."""
    data = github("/tarball/main", timeout=60)
    src = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as dst:
        for m in src.getmembers():
            parts = m.name.split("/")
            if len(parts) < 3 or parts[1] != "webapp" or not m.isfile():
                continue
            rel = "/".join(parts[2:])
            info = tarfile.TarInfo(rel)
            info.size = m.size
            dst.addfile(info, src.extractfile(m))
    install_update(out.getvalue())


WMO = {0: ("Clear", "☀️"), 1: ("Mostly clear", "🌤️"), 2: ("Partly cloudy", "⛅"), 3: ("Overcast", "☁️"),
       45: ("Fog", "🌫️"), 48: ("Fog", "🌫️"), 51: ("Drizzle", "🌦️"), 53: ("Drizzle", "🌦️"), 55: ("Drizzle", "🌦️"),
       56: ("Freezing drizzle", "🌧️"), 57: ("Freezing drizzle", "🌧️"), 61: ("Light rain", "🌧️"),
       63: ("Rain", "🌧️"), 65: ("Heavy rain", "🌧️"), 66: ("Freezing rain", "🌧️"), 67: ("Freezing rain", "🌧️"),
       71: ("Light snow", "🌨️"), 73: ("Snow", "🌨️"), 75: ("Heavy snow", "❄️"), 77: ("Snow grains", "🌨️"),
       80: ("Showers", "🌦️"), 81: ("Showers", "🌦️"), 82: ("Heavy showers", "⛈️"), 85: ("Snow showers", "🌨️"),
       86: ("Snow showers", "🌨️"), 95: ("Thunderstorm", "⛈️"), 96: ("Thunderstorm", "⛈️"), 99: ("Thunderstorm", "⛈️")}


def weather(lat, lon, start, end):
    """Forecast if the dates are within 16 days, otherwise last year's actual weather for the same dates."""
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    today = date.today()
    fields = "weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum"
    if d1 <= today + timedelta(days=15):
        mode = "forecast"
        url = (f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily={fields}"
               f"&timezone=auto&start_date={max(d0, today)}&end_date={d1}")
    else:
        mode = "last year"
        try:
            l0, l1 = d0.replace(year=d0.year - 1), d1.replace(year=d1.year - 1)
        except ValueError:  # 29 February
            l0, l1 = d0 - timedelta(days=365), d1 - timedelta(days=365)
        url = (f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&daily={fields}"
               f"&timezone=auto&start_date={l0}&end_date={l1}")
    j = fetch_json(url)
    d = j.get("daily", {})
    days = []
    for i, day in enumerate(d.get("time", [])):
        code = d["weathercode"][i]
        text, icon = WMO.get(code, ("", "🌡️"))
        days.append({"date": day, "max": d["temperature_2m_max"][i], "min": d["temperature_2m_min"][i],
                     "rain": d["precipitation_sum"][i], "text": text, "icon": icon})
    return {"mode": mode, "days": days, "available_from": str(d1 - timedelta(days=15)) if mode != "forecast" else None}


def holidays(cc, start, end):
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    out = []
    for year in sorted({d0.year, d1.year}):
        try:
            for h in fetch_json(f"https://date.nager.at/api/v3/PublicHolidays/{year}/{cc.upper()}"):
                if start <= h["date"] <= end:
                    out.append({"date": h["date"], "name": h.get("name") or h.get("localName")})
        except Exception:
            pass
    return out


DEBUG = []  # last few hundred add-on events, kept in memory only, for troubleshooting


class Handler(BaseHTTPRequestHandler):
    server_version = "HotelSearch/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        p = u.path
        try:
            if p in ("/", "/index.html"):
                return self._file("index.html")
            if p.startswith("/static/"):
                return self._file(p[len("/static/"):])
            if p == "/api/health":
                return self._send(200, {"ok": True, "version": VERSION, "path": ROOT})
            if p == "/api/geocode":
                j = fetch_json("https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&name="
                               + urllib.parse.quote(q.get("q", "")))
                res = [{"city": g["name"], "country": g.get("country", ""), "countryCode": g.get("country_code", ""),
                        "region": g.get("admin1", ""), "lat": g["latitude"], "lon": g["longitude"]}
                       for g in j.get("results", [])]
                return self._send(200, res)
            if p == "/api/weather":
                return self._send(200, weather(q["lat"], q["lon"], q["start"], q["end"]))
            if p == "/api/holidays":
                return self._send(200, holidays(q["cc"], q["start"], q["end"]))
            if p == "/api/searches":
                with db() as con:
                    rows = con.execute("SELECT id, created, params FROM searches ORDER BY id DESC LIMIT ?",
                                       (int(q.get("limit", 12)),)).fetchall()
                return self._send(200, [{"id": r["id"], "created": r["created"], "params": json.loads(r["params"])} for r in rows])
            m = re.fullmatch(r"/api/searches/(\d+|latest)", p)
            if m:
                with db() as con:
                    row = (con.execute("SELECT * FROM searches ORDER BY id DESC LIMIT 1").fetchone() if m[1] == "latest"
                           else con.execute("SELECT * FROM searches WHERE id=?", (int(m[1]),)).fetchone())
                    if not row:
                        return self._send(404, {"error": "not found"})
                    res = con.execute("SELECT * FROM results WHERE search_id=?", (row["id"],)).fetchall()
                    pages = {r["key"]: r for r in con.execute("SELECT * FROM pages WHERE search_id=?", (row["id"],)).fetchall()}
                out = []
                for r in res:
                    item = dict(json.loads(r["payload"] or "{}"), key=r["key"], chain=r["chain"], kind=r["kind"],
                                status=r["status"], updated=r["updated"])
                    pg = pages.get(r["key"])
                    if pg and r["status"] in ("done", "empty", "none", "timeout"):
                        # Read the saved page again, so reader fixes also improve earlier searches.
                        rd = readers.read_page(pg["chain"], pg["text"] or "", json.loads(pg["links"] or "[]"))
                        item["hotels"] = rd["hotels"]
                        item["status"] = "done" if rd["hotels"] else "none" if rd.get("noneFound") else "empty"
                    out.append(item)
                return self._send(200, {"id": row["id"], "created": row["created"], "params": json.loads(row["params"]), "results": out})
            if p == "/api/debug":
                return self._send(200, DEBUG[-int(q.get("n", 120)):])
            if p == "/api/page":
                # A saved hotel page as the add-on saw it (for fixing the readers when a site changes).
                with db() as con:
                    pg = con.execute("SELECT * FROM pages WHERE search_id=? AND key=?", (int(q["search"]), q["key"])).fetchone()
                if not pg:
                    return self._send(404, {"error": "not found"})
                return self._send(200, {"chain": pg["chain"], "text": pg["text"], "links": json.loads(pg["links"] or "[]")[:40]})
            if p == "/api/admin/update-status":
                info = {"current": VERSION, "repo": REPO, "hasKey": os.path.exists(TOKEN_PATH), "latest": None, "error": None}
                if info["hasKey"]:
                    try:
                        info["latest"] = latest_version()
                    except ValueError as e:
                        info["error"] = str(e)
                return self._send(200, info)
            if p == "/api/points":
                with db() as con:
                    rows = con.execute("SELECT program, balance, source, ts FROM points ORDER BY ts DESC").fetchall()
                    acc = {r["chain"]: {"signedIn": None if r["signed_in"] is None else bool(r["signed_in"]), "checked": r["checked"]}
                           for r in con.execute("SELECT * FROM accounts").fetchall()}
                    status = {r["program"]: {"tier": r["tier"], "source": r["source"], "updated": r["updated"]}
                              for r in con.execute("SELECT * FROM status").fetchall()}
                latest, history = {}, {}
                for r in rows:
                    history.setdefault(r["program"], []).append({"balance": r["balance"], "ts": r["ts"]})
                    latest.setdefault(r["program"], {"balance": r["balance"], "ts": r["ts"], "source": r["source"]})
                return self._send(200, {"latest": latest, "history": history, "accounts": acc, "status": status})
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        if p == "/api/admin/update-from-github":
            try:
                install_from_github()
                return self._send(200, {"ok": True, "message": "Installed. Restarting…"})
            except Exception as e:
                return self._send(400, {"error": str(e)})
        if p == "/api/admin/update":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if not 0 < n < 20_000_000:
                    return self._send(400, {"error": "empty or too large"})
                install_update(self.rfile.read(n))
                return self._send(200, {"ok": True, "message": "Installed. Restarting…"})
            except Exception as e:
                return self._send(400, {"error": str(e)})
        try:
            body = self._body()
            if p == "/api/searches":
                keep = {k: body.get(k) for k in ("city", "country", "countryCode", "lat", "lon", "checkIn", "checkOut", "adults")}
                with LOCK, db() as con:
                    cur = con.execute("INSERT INTO searches (created, params) VALUES (?,?)", (time.time(), json.dumps(keep)))
                return self._send(200, {"id": cur.lastrowid})
            m = re.fullmatch(r"/api/searches/(\d+)/results", p)
            if m:
                sid = int(m[1])
                payload = {k: body.get(k) for k in ("hotels", "balance", "signedIn", "tier", "note", "url")}
                with LOCK, db() as con:
                    # A page that already finished is never turned back into "loading" or "took too long".
                    prev = con.execute("SELECT status FROM results WHERE search_id=? AND key=?", (sid, body["key"])).fetchone()
                    if prev and prev["status"] in ("done", "empty", "none", "blocked") and body.get("status") in ("loading", "timeout"):
                        return self._send(200, {"ok": True, "kept": prev["status"]})
                    con.execute("""INSERT INTO results (search_id, key, chain, kind, status, payload, updated)
                                   VALUES (?,?,?,?,?,?,?)
                                   ON CONFLICT(search_id, key) DO UPDATE SET status=excluded.status,
                                   payload=excluded.payload, updated=excluded.updated""",
                                (sid, body["key"], body.get("chain"), body.get("kind"), body.get("status"),
                                 json.dumps(payload), time.time()))
                    if body.get("chain"):
                        record_account(con, body["chain"], body.get("signedIn"), body.get("balance"), body.get("tier"))
                return self._send(200, {"ok": True})
            if p == "/api/searches/delete":
                ids = [int(i) for i in (body.get("ids") or [])][:500]
                with LOCK, db() as con:
                    for i in ids:
                        for table, col in (("results", "search_id"), ("pages", "search_id"), ("searches", "id")):
                            con.execute(f"DELETE FROM {table} WHERE {col}=?", (i,))
                return self._send(200, {"ok": True, "deleted": len(ids)})
            if p == "/api/admin/key":
                token = str(body.get("key", "")).strip()
                if not re.fullmatch(r"[A-Za-z0-9_]{20,255}", token):
                    return self._send(400, {"error": "That doesn't look like a GitHub key (it starts with github_pat_)."})
                with open(TOKEN_PATH, "w") as f:
                    f.write(token)
                os.chmod(TOKEN_PATH, 0o600)
                try:
                    return self._send(200, {"ok": True, "latest": latest_version()})
                except ValueError as e:
                    return self._send(200, {"ok": False, "error": str(e)})
            if p == "/api/read":
                chain = str(body.get("chain", ""))[:40]
                text = str(body.get("text") or "")[:400000]
                links = body.get("links") or []
                rd = readers.read_page(chain, text, links if isinstance(links, list) else [])
                reply = {"hotels": len(rd["hotels"]), "expected": rd["expected"], "blocked": rd["blocked"]}
                if body.get("final") and body.get("searchId") and body.get("key"):
                    sid, key = int(body["searchId"]), str(body["key"])[:40]
                    status = ("blocked" if rd["blocked"] else "done" if rd["hotels"]
                              else "none" if rd.get("noneFound") else "empty")
                    payload = {"hotels": rd["hotels"], "balance": rd.get("balance"), "signedIn": rd.get("signedIn"),
                               "tier": rd.get("tier"), "note": None if rd["hotels"] else text[:2500], "url": body.get("url")}
                    with LOCK, db() as con:
                        con.execute("""INSERT INTO results (search_id, key, chain, kind, status, payload, updated)
                                       VALUES (?,?,?,?,?,?,?)
                                       ON CONFLICT(search_id, key) DO UPDATE SET status=excluded.status,
                                       payload=excluded.payload, updated=excluded.updated""",
                                    (sid, key, chain, body.get("kind"), status, json.dumps(payload), time.time()))
                        con.execute("""INSERT INTO pages (search_id, key, chain, text, links, updated) VALUES (?,?,?,?,?,?)
                                       ON CONFLICT(search_id, key) DO UPDATE SET text=excluded.text, links=excluded.links,
                                       updated=excluded.updated""", (sid, key, chain, text, json.dumps(links)[:300000], time.time()))
                        record_account(con, chain, rd.get("signedIn"), rd.get("balance"), rd.get("tier"))
                    reply["status"] = status
                return self._send(200, reply)
            if p == "/api/account-page":
                site = str(body.get("site", "")).lower()
                chain = next((c for host, c in SITES.items() if site == host or site.endswith("." + host)), None)
                if not chain:
                    return self._send(200, {"ok": False})
                a = readers.ACCOUNT[chain](str(body.get("text") or "")[:6000])
                if a["signedIn"] is not None:
                    with LOCK, db() as con:
                        record_account(con, chain, a["signedIn"], a["balance"], a["tier"])
                return self._send(200, {"ok": True, **a})
            if p == "/api/debug":
                DEBUG.append({"t": round(time.time(), 1), **{k: str(v)[:(15000 if k == "text" else 400)] for k, v in body.items()}})
                del DEBUG[:-400]
                return self._send(200, {"ok": True})
            if p == "/api/accounts":
                chain = str(body.get("chain", ""))[:40]
                if not chain:
                    return self._send(400, {"error": "chain needed"})
                with LOCK, db() as con:
                    record_account(con, chain, body.get("signedIn"), body.get("balance"), body.get("tier"))
                return self._send(200, {"ok": True})
            if p == "/api/status":
                program = str(body.get("program", "")).strip()[:40]
                tier = str(body.get("tier") or "").strip()[:40]
                with LOCK, db() as con:
                    if tier:
                        con.execute("INSERT INTO status (program, tier, source, updated) VALUES (?,?,?,?) "
                                    "ON CONFLICT(program) DO UPDATE SET tier=excluded.tier, source=excluded.source, updated=excluded.updated",
                                    (program, tier, "manual", time.time()))
                    else:
                        con.execute("DELETE FROM status WHERE program=?", (program,))
                return self._send(200, {"ok": True})
            if p == "/api/points":
                program = str(body.get("program", "")).strip()[:40]
                bal = int(body.get("balance"))
                if not program or bal < 0:
                    return self._send(400, {"error": "program and balance needed"})
                with LOCK, db() as con:
                    record_points(con, program, bal, "manual")
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(400, {"error": str(e)})

    def _file(self, name):
        path = os.path.normpath(os.path.join(STATIC, name))
        if not path.startswith(STATIC) or not os.path.isfile(path):
            return self._send(404, {"error": "not found"})
        with open(path, "rb") as f:
            self._send(200, f.read(), TYPES.get(os.path.splitext(path)[1], "application/octet-stream"))


if __name__ == "__main__":
    init_db()
    print(f"Hotel Search running on port {PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
