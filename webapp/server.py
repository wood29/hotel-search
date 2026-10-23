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
TM_KEY_PATH = os.path.join(os.path.dirname(DB_PATH), "ticketmaster-key")
EVENTS_CACHE = {}  # (lat, lon, start, end) -> (time, result)
GOOGLE_KEY_PATH = os.path.join(os.path.dirname(DB_PATH), "google-key")
FOOD_CACHE = {}  # (lat, lon) -> (time, result)
# Hotel sites by web address (the add-on only says which site a page is from).
SITES = {"marriott.com": "Marriott", "hilton.com": "Hilton", "ihg.com": "IHG", "all.accor.com": "Accor",
         "radissonhotels.com": "Radisson", "melia.com": "Meliá", "ghadiscovery.com": "GHA", "nh-hotels.com": "GHA",
         "americanexpress.com": "Amex"}


def stay_nights(prm):
    try:
        return max(1, (date.fromisoformat(prm["checkOut"]) - date.fromisoformat(prm["checkIn"])).days)
    except Exception:
        return 1
APP_DIR = os.path.join(os.path.dirname(DB_PATH), "app")

TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".zip": "application/zip",
         ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"}


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
        CREATE TABLE IF NOT EXISTS geo (
            key TEXT PRIMARY KEY,
            lat REAL, lon REAL, ts REAL);
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


# ---------- What's on (Ticketmaster Discovery, free key saved in ⚙︎) ----------
def events(lat, lon, start, end):
    key = (round(float(lat), 3), round(float(lon), 3), start, end)
    hit = EVENTS_CACHE.get(key)
    if hit and time.time() - hit[0] < 6 * 3600:
        return hit[1]
    try:
        with open(TM_KEY_PATH) as f:
            api_key = f.read().strip()
    except OSError:
        return {"hasKey": False, "events": []}
    q = urllib.parse.urlencode({"apikey": api_key, "latlong": f"{lat},{lon}", "radius": 20, "unit": "km",
                                "startDateTime": f"{start}T00:00:00Z", "endDateTime": f"{end}T23:59:59Z",
                                "size": 60, "sort": "date,asc", "locale": "*"})
    try:
        j = fetch_json("https://app.ticketmaster.com/discovery/v2/events.json?" + q, timeout=15)
    except urllib.error.HTTPError as e:
        return {"hasKey": True, "events": [], "error": "Ticketmaster didn't accept the key." if e.code in (401, 403) else f"Ticketmaster answered {e.code}."}
    except Exception:
        return {"hasKey": True, "events": [], "error": "Couldn't reach Ticketmaster right now."}
    out, seen = [], set()
    for ev in (j.get("_embedded") or {}).get("events", []):
        name = ev.get("name") or ""
        start_ = (ev.get("dates") or {}).get("start") or {}
        venue = (((ev.get("_embedded") or {}).get("venues") or [{}])[0]).get("name") or ""
        cls = (ev.get("classifications") or [{}])[0]
        seg = (cls.get("segment") or {}).get("name") or ""
        genre = (cls.get("genre") or {}).get("name") or ""
        dedupe = (name.lower(), venue.lower())  # one line per show, not one per performance
        if dedupe in seen:
            continue
        seen.add(dedupe)
        imgs = sorted([i for i in ev.get("images") or [] if i.get("ratio") == "16_9"], key=lambda i: i.get("width", 0))
        img = next((i["url"] for i in imgs if i.get("width", 0) >= 300), imgs[-1]["url"] if imgs else None)
        out.append({"name": name, "date": start_.get("localDate"), "time": (start_.get("localTime") or "")[:5],
                    "venue": venue, "kind": genre if genre and genre != "Undefined" else seg, "segment": seg,
                    "url": ev.get("url"), "image": img})
    res = {"hasKey": True, "events": out[:40]}
    EVENTS_CACHE[key] = (time.time(), res)
    return res


# ---------- Top restaurants (Google Places, key saved in ⚙︎; cached a week per city) ----------
PRICE = {"PRICE_LEVEL_INEXPENSIVE": "€", "PRICE_LEVEL_MODERATE": "€€", "PRICE_LEVEL_EXPENSIVE": "€€€", "PRICE_LEVEL_VERY_EXPENSIVE": "€€€€"}


def restaurants(lat, lon, city):
    key = (round(float(lat), 2), round(float(lon), 2))
    hit = FOOD_CACHE.get(key)
    if hit and time.time() - hit[0] < 7 * 86400:
        return hit[1]
    try:
        with open(GOOGLE_KEY_PATH) as f:
            api_key = f.read().strip()
    except OSError:
        return {"hasKey": False, "places": []}
    body = json.dumps({"textQuery": f"best restaurants in {city}", "includedType": "restaurant", "maxResultCount": 20,
                       "locationBias": {"circle": {"center": {"latitude": float(lat), "longitude": float(lon)}, "radius": 6000.0}}}).encode()
    req = urllib.request.Request("https://places.googleapis.com/v1/places:searchText", data=body, method="POST", headers={
        "Content-Type": "application/json", "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": "places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.shortFormattedAddress,"
                            "places.googleMapsUri,places.primaryTypeDisplayName,places.location,places.businessStatus"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            j = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")[:300]
        return {"hasKey": True, "places": [], "error": "Google didn't accept the key — check that the Places API (New) is enabled for it." if e.code in (400, 401, 403) else f"Google answered {e.code}.", "detail": msg}
    except Exception:
        return {"hasKey": True, "places": [], "error": "Couldn't reach Google right now."}
    out = []
    for pl in j.get("places", []):
        if pl.get("businessStatus") not in (None, "OPERATIONAL"):
            continue
        rating, count = pl.get("rating") or 0, pl.get("userRatingCount") or 0
        # Rank like a careful reader would: a 4.7 with 3,000 reviews beats a 5.0 with 12.
        score = (rating * count + 4.2 * 300) / (count + 300)
        out.append({"name": (pl.get("displayName") or {}).get("text"), "rating": rating, "reviews": count,
                    "price": PRICE.get(pl.get("priceLevel"), ""), "kind": (pl.get("primaryTypeDisplayName") or {}).get("text", ""),
                    "address": pl.get("shortFormattedAddress", ""), "url": pl.get("googleMapsUri"),
                    "lat": (pl.get("location") or {}).get("latitude"), "lon": (pl.get("location") or {}).get("longitude"), "score": round(score, 3)})
    out.sort(key=lambda x: -x["score"])
    res = {"hasKey": True, "places": out[:10]}
    FOOD_CACHE[key] = (time.time(), res)
    return res


# ---------- Hotel locations for the map ----------
# Looked up once per hotel on OpenStreetMap (Nominatim, max one request a second as they ask) and kept.
GEO_QUEUE, GEO_PENDING = [], set()
GEO_WAKE = threading.Event()


def geo_key(name, city):
    return (re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip() + "|" + (city or "").lower().strip())


NOMINATIM_LOCK = threading.Lock()


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "hotel-search-private/1.0 (personal use)"})
    with urllib.request.urlopen(req, timeout=12) as r:
        return json.loads(r.read().decode("utf-8"))


def _near(lat, lon, clat, clon, km=40):
    if clat is None:
        return True
    from math import radians, cos, sqrt
    dx = radians(lon - clon) * cos(radians(clat)) * 6371
    dy = radians(lat - clat) * 6371
    return sqrt(dx * dx + dy * dy) <= km


def geocode(name, city, country, clat, clon):
    """Photon (fast, several at once) first, OpenStreetMap's Nominatim (one a second) as a fallback.
    Only accepts a place near the searched city, so a same-named hotel elsewhere can't sneak in."""
    failed = False
    try:
        q = urllib.parse.urlencode({"q": f"{name} {city}", "limit": 3, **({"lat": clat, "lon": clon} if clat is not None else {})})
        for f in _get_json("https://photon.komoot.io/api/?" + q).get("features", []):
            lon, lat = f["geometry"]["coordinates"]
            if _near(lat, lon, clat, clon):
                return lat, lon, False
    except Exception:
        failed = True
    with NOMINATIM_LOCK:
        for q in (f"{name}, {city}, {country}", f"{name}, {country}"):
            try:
                res = _get_json("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&q=" + urllib.parse.quote(q))
                for r in res:
                    lat, lon = float(r["lat"]), float(r["lon"])
                    if _near(lat, lon, clat, clon):
                        time.sleep(1.1)
                        return lat, lon, False
            except Exception:
                failed = True
            time.sleep(1.1)
    return None, None, failed


def geo_worker():
    while True:
        GEO_WAKE.wait(30)
        GEO_WAKE.clear()
        while GEO_QUEUE:
            try:
                key, name, city, country, clat, clon = GEO_QUEUE.pop(0)
            except IndexError:
                break
            lat, lon, failed = geocode(name, city, country, clat, clon)
            if lat is not None or not failed:  # network trouble: try again next time instead of remembering "not found"
                with LOCK, db() as con:
                    con.execute("INSERT OR REPLACE INTO geo (key, lat, lon, ts) VALUES (?,?,?,?)", (key, lat, lon, time.time()))
            GEO_PENDING.discard(key)


def hotel_locations(names, city, country, clat=None, clon=None):
    out = {}
    with db() as con:
        for n in names:
            k = geo_key(n, city)
            row = con.execute("SELECT lat, lon, ts FROM geo WHERE key=?", (k,)).fetchone()
            if row and (row["lat"] is not None or time.time() - row["ts"] < 7 * 86400):
                if row["lat"] is not None:
                    out[n] = [row["lat"], row["lon"]]
            elif k not in GEO_PENDING:
                GEO_PENDING.add(k)
                GEO_QUEUE.append((k, n, city, country, clat, clon))
    if GEO_QUEUE:
        GEO_WAKE.set()
    return {"locations": out, "pending": len(GEO_PENDING)}


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
            if p == "/favicon.ico":
                return self._file("icons/favicon.ico")
            if p == "/manifest.webmanifest":
                return self._file("manifest.webmanifest")
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
            if p == "/api/restaurants":
                return self._send(200, restaurants(q["lat"], q["lon"], q.get("city", "")))
            if p == "/api/events":
                return self._send(200, events(q["lat"], q["lon"], q["start"], q["end"]))
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
                        rd = readers.read_page(pg["chain"], pg["text"] or "", json.loads(pg["links"] or "[]"),
                                               stay_nights(json.loads(row["params"])))
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
                info = {"current": VERSION, "repo": REPO, "hasKey": os.path.exists(TOKEN_PATH), "latest": None, "error": None,
                        "hasEventsKey": os.path.exists(TM_KEY_PATH), "hasGoogleKey": os.path.exists(GOOGLE_KEY_PATH)}
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
            if p == "/api/hotel-geo":
                with db() as con:
                    row = con.execute("SELECT params FROM searches WHERE id=?", (int(body.get("search", 0)),)).fetchone()
                if not row:
                    return self._send(404, {"error": "not found"})
                prm = json.loads(row["params"])
                names = [str(n)[:160] for n in (body.get("names") or []) if n][:150]
                return self._send(200, hotel_locations(names, prm.get("city", ""), prm.get("country", ""), prm.get("lat"), prm.get("lon")))
            if p == "/api/searches/delete":
                ids = [int(i) for i in (body.get("ids") or [])][:500]
                with LOCK, db() as con:
                    for i in ids:
                        for table, col in (("results", "search_id"), ("pages", "search_id"), ("searches", "id")):
                            con.execute(f"DELETE FROM {table} WHERE {col}=?", (i,))
                return self._send(200, {"ok": True, "deleted": len(ids)})
            if p == "/api/admin/google-key":
                k = str(body.get("key", "")).strip()
                if not re.fullmatch(r"AIza[0-9A-Za-z_\-]{30,45}", k):
                    return self._send(400, {"error": "That doesn't look like a Google API key (it starts with AIza)."})
                with open(GOOGLE_KEY_PATH, "w") as f:
                    f.write(k)
                os.chmod(GOOGLE_KEY_PATH, 0o600)
                FOOD_CACHE.clear()
                return self._send(200, {"ok": True})
            if p == "/api/admin/events-key":
                k = str(body.get("key", "")).strip()
                if not re.fullmatch(r"[A-Za-z0-9]{16,64}", k):
                    return self._send(400, {"error": "That doesn't look like a Ticketmaster Consumer Key."})
                with open(TM_KEY_PATH, "w") as f:
                    f.write(k)
                os.chmod(TM_KEY_PATH, 0o600)
                EVENTS_CACHE.clear()
                return self._send(200, {"ok": True})
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
                nights = 1
                if body.get("searchId"):
                    with db() as con:
                        r0 = con.execute("SELECT params FROM searches WHERE id=?", (int(body["searchId"]),)).fetchone()
                    if r0:
                        nights = stay_nights(json.loads(r0["params"]))
                rd = readers.read_page(chain, text, links if isinstance(links, list) else [], nights)
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
                        srow = con.execute("SELECT params FROM searches WHERE id=?", (sid,)).fetchone()
                    if srow and rd["hotels"]:
                        prm = json.loads(srow["params"])
                        hotel_locations([h["name"] for h in rd["hotels"] if h.get("name")], prm.get("city", ""),
                                        prm.get("country", ""), prm.get("lat"), prm.get("lon"))
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
                        if chain == "Amex":  # Amex points are kept under their programme name
                            record_account(con, chain, a["signedIn"], None, None)
                            if a["signedIn"] and isinstance(a["balance"], (int, float)):
                                record_points(con, "Amex Membership Rewards", a["balance"], "auto")
                        else:
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
    for _ in range(4):  # look up several hotels at once
        threading.Thread(target=geo_worker, daemon=True).start()
    print(f"Hotel Search running on port {PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
