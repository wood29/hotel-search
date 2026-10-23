"""Readers that turn a hotel site's page text into a list of hotels, and read sign-in state,
points and status from the page header.

These run on the NAS, so a fix here reaches every browser with a one-tap web app update —
the browser add-on only sends the page text and the booking links it can see.
"""
import re

# A number as the sites print it: 9,260 · 9.260 · 9 260 (normal, no-break or thin space) · 79.50
N = r"(\d{1,3}(?:[,.   ]\d{3})+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)"


def rx(src, flags=0):
    return re.compile(src.replace("@N", N), flags)


def num(s):
    if s is None:
        return None
    t = re.sub(r"[   ]", "", str(s))
    dec = re.search(r"[.,](\d{2})$", t)
    if dec and not re.fullmatch(r"\d{1,3}([.,]\d{3})+", t):
        t = re.sub(r"[.,]", "", t[:-3]) + "." + dec[1]
    else:
        t = re.sub(r"[.,]", "", t)
    try:
        v = float(t)
    except ValueError:
        return None
    return int(v) if v == int(v) else v


def lines_of(text):
    return [l.strip() for l in text.split("\n") if l.strip()]


def dist_km(s):
    """Distance as printed: '1.4 km from destination', '0.64 miles', '1.53 km (0.95mi) from destination'."""
    km = re.search(r"(\d+(?:[.,]\d+)?)\s*km\b", s, re.I)
    if km:
        return round(float(km[1].replace(",", ".")) * 10) / 10
    mi = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:miles?|mi)\b", s, re.I)
    if mi:
        return round(float(mi[1].replace(",", ".")) * 16.09) / 10
    return None


def first_match(text, patterns):
    for p in patterns:
        m = re.search(p, text)
        if m:
            return m[1] if m.groups() else m[0]
    return None


# ---------- Sign-in state, points and status ----------
def account_marriott(text):
    head = text[:1500]
    signed_in = True if "Hello," in head else False if re.search(r"Sign In or Join|Sign in to your account", head) else None
    bal = rx(r"Hello,[\s\S]{0,200}?@N\s*Points").search(text)
    tier = first_match(text, [r"\b((?:Silver|Gold|Platinum|Titanium|Ambassador) Elite)\b"]) if signed_in else None
    return {"signedIn": signed_in, "balance": num(bal[1]) if signed_in and bal else None, "tier": tier}


def account_hilton(text):
    head = text[:700]
    bal = rx(r"@N\s*Points available").search(text) or rx(r"@N\s*(?:Points|pts)\b").search(head)
    signed_out = bool(re.search(r"\bJoin\s*\n\s*Sign In\b", head) or "Join or sign in" in head)
    signed_in = False if signed_out else True if (bal or re.search(r"\bHi,\s", head) or re.search(r"Sign Out", head, re.I)) else None
    tier = first_match(head, [r"\b(Diamond|Gold|Silver)\s*(?:Status|Member|\n)", r"\b(Lifetime Diamond)\b"]) if signed_in else None
    return {"signedIn": signed_in, "balance": num(bal[1]) if signed_in and bal else None, "tier": tier}


IHG_SKIP = re.compile(r"^(IHG|HOTELS & RESORTS|MENU|SEARCH|EN|ENGLISH|EUR|USD|GBP|CHAT WITH US|MY STAYS|CERTIFIED|NEW|NEW HOTEL|MAP|LIST)$")


def account_ihg(text):
    head = text[:900]
    signed_out = bool(re.search(r"Join for free\s+Sign in|Sign in / Join|^\s*Sign in\s*$", head, re.I | re.M))
    bal = rx(r"@N\s?pts\b").search(head)
    # On an iPad-sized screen IHG only shows a button with your first name in capitals
    # (e.g. "MICHAEL") at the top, before the search box — no points, no "Sign out".
    top = re.split(r"\n\s*(?:DESTINATION|Destination)\b", head)[0]
    top_lines = [l.strip() for l in top.split("\n") if l.strip()][:8]
    name_button = any(re.fullmatch(r"[A-ZÀ-Ý][A-ZÀ-Ý'’ .-]{1,24}", l) and not IHG_SKIP.match(l) for l in top_lines)
    signed_in = False if signed_out else True if (bal or re.search(r"Sign out", head, re.I) or name_button) else None
    tier = first_match(text[:3000], [r"\b((?:Silver|Gold|Platinum|Diamond) Elite)\b",
                                     r"\b(Royal Ambassador|Ambassador)\b", r"\b(Club Member)\b"]) if signed_in else None
    return {"signedIn": signed_in, "balance": num(bal[1]) if signed_in and bal else None, "tier": tier}


ACCOUNT = {"Marriott": account_marriott, "Hilton": account_hilton, "IHG": account_ihg}


# ---------- Hotel lists ----------
def marriott(text):
    hotels = []
    noise = {"NEW", "View Details", "View Rates", "|", "Taxes and all fees included",
             "Points / Stay", "EUR / night", "View Other Dates"}
    for chunk in re.split(r"View Rates|View Other Dates", text):
        lines = lines_of(chunk)
        idx = next((i for i, l in enumerate(lines) if "from destination" in l), -1)
        if idx < 0:
            continue
        name = None
        for l in reversed(lines[:idx]):
            if l in noise or re.match(r"\d", l) or l.startswith("(") or l.startswith("|"):
                continue
            name = l
            break
        rest = "\n".join(lines[idx:])
        pts = rx(r"@N\s*\n?\s*Points\s*/\s*Stay").search(rest)
        eur = rx(r"@N\s*\n?\s*EUR\s*/\s*night").search(rest)
        hotels.append({"name": name, "distanceKm": dist_km(lines[idx]),
                       "cashPerNight": num(eur[1]) if eur else None,
                       "points": num(pts[1]) if pts else None, "pointsUnit": "stay",
                       "soldOut": "Sold Out" in rest})
    rng = re.search(r"\d+\s*-\s*(\d+)\s+of\s+(\d+)\s+Results", text)
    return {"hotels": hotels, **account_marriott(text), "expected": int(rng[1]) if rng else None}


def _is_dist(x):
    return bool(re.fullmatch(r"\d+(?:[.,]\d+)?\s*(miles?|km)", x or "", re.I))


def hilton(text):
    lines = lines_of(text)
    starts = []
    for i, l in enumerate(lines):
        # A hotel name is followed by "Opens new tab" and then its distance — on an iPad there is
        # a "View hotel details" line in between.
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        nxt2 = lines[i + 2] if i + 2 < len(lines) else ""
        if re.fullmatch(r",?\s*Opens new tab", l) and i > 0 and (_is_dist(nxt) or (nxt.startswith("View hotel details") and _is_dist(nxt2))):
            starts.append(i - 1)
    hotels = []
    for k, s in enumerate(starts):
        seg_lines = lines[s + 1: starts[k + 1] if k + 1 < len(starts) else len(lines)]
        seg = "\n".join(seg_lines)
        cash = rx(r"@N\s*€\s*\n?\s*avg/night").search(seg)
        total = rx(r"@N\s*€ total for").search(seg)
        pts = rx(r"@N\s*\n?\s*Points( for first night|\s*/\s*night)").search(seg)
        d = next((x for x in seg_lines if _is_dist(x)), None)
        hotels.append({"name": lines[s], "distanceKm": dist_km(d) if d else None,
                       "cashPerNight": num(cash[1]) if cash else None,
                       "cashTotal": num(total[1]) if total else None,
                       "points": num(pts[1]) if pts else None,
                       "pointsUnit": ("first night" if "first" in pts[2] else "night") if pts else None,
                       "soldOut": bool(re.search(r"Coming Soon|Sold out|No availability", seg, re.I))})
    rng = re.search(r"Showing\s+\d+\s*-\s*(\d+)\s+of\s+(\d+)\s+hotels", text)
    return {"hotels": hotels, **account_hilton(text), "expected": int(rng[1]) if rng else None}


def ihg(text):
    lines = lines_of(text)
    noise = {"CERTIFIED", "NEW", "NEW HOTEL", "Edit", "Map"}

    def is_address(l):  # wide screens show the street address between name and distance
        return bool(re.search(r"\b\d{4,5}\b", l)) and (bool(re.search(r"\d{3}\s?\d{3}\s?\d{3,4}$", l)) or "," in l)

    marks = [i for i, l in enumerate(lines) if "from destination" in l]
    hotels = []
    for k, m in enumerate(marks):
        name = next((lines[i] for i in range(m - 1, -1, -1) if lines[i] not in noise and not is_address(lines[i])), None)
        seg = "\n".join(lines[m: marks[k + 1] if k + 1 < len(marks) else len(lines)])
        cash = (rx(r"@N\s*(?:EUR|€)\s*\n?\s*(?:/|per)\s*night").search(seg)
                or rx(r"€\s*@N\s*\n?\s*/?\s*(?:per\s+)?night").search(seg))
        pts = rx(r"@N\s*PTS").search(seg)
        hotels.append({"name": name, "distanceKm": dist_km(lines[m]),
                       "cashPerNight": num(cash[1]) if cash else None,
                       "points": num(pts[1]) if pts else None, "pointsUnit": "night",
                       "pointsLimited": "not available for Reward Nights" in seg,
                       "soldOut": "No rooms available" in seg})
    found = re.search(r"(\d+) Hotels Found", text)
    return {"hotels": hotels, **account_ihg(text), "expected": int(found[1]) if found else None}


LISTS = {"Marriott": marriott, "Hilton": hilton, "IHG": ihg}


def blocked(text):
    return bool(re.search(r"Access Denied|You don't have permission to access|unusual activity|verify you are a human", text, re.I))


DIST_HINT = re.compile(r"from destination|\d+(?:[.,]\d+)?\s*(?:miles?|km)\b", re.I)


def attach_links(hotels, links):
    """links: [{"href", "label", "card"}] — each booking link the add-on saw, with the text of the
    hotel card around it ("card"), or a link whose own text is the hotel name ("label")."""
    names = sorted([h["name"] for h in hotels if h.get("name")], key=len, reverse=True)
    found = {}
    for a in links or []:
        card = a.get("card") or ""
        href = a.get("href") or ""
        if not card or not href or not re.search(r"View Rates|Select Hotel|Book now|See rates|View hotel", a.get("label") or "", re.I):
            continue
        name = next((n for n in names if n not in found and n in card), None)
        if name:
            found[name] = href
    for a in links or []:
        t = (a.get("label") or "").strip()
        if t and t not in found and t in names:
            found[t] = a.get("href")
    for h in hotels:
        link = found.get(h.get("name"))
        if link and not re.match(r"^javascript:|#$", link):
            h["link"] = link
    return hotels


def read_page(chain, text, links=None):
    """Everything the NAS needs from one results page."""
    if blocked(text):
        return {"blocked": True, "noneFound": False, "hotels": [], "expected": None, "signedIn": None, "balance": None, "tier": None}
    fn = LISTS.get(chain)
    if not fn:
        return {"blocked": False, "noneFound": False, "hotels": [], "expected": None, "signedIn": None, "balance": None, "tier": None}
    r = fn(text)
    attach_links(r["hotels"], links)
    r["blocked"] = False
    # The site itself says there's nothing for these dates (e.g. no reward nights) — not a reading problem.
    r["noneFound"] = not r["hotels"] and bool(re.search(
        r"\b0 Hotels? Found\b|No hotels found|No hotels available|no results|We couldn.t find any hotels", text, re.I))
    return r
