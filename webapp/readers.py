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
    km = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:km|kilomet(?:er|re)s?)\b", s, re.I)
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
    # Points sit next to "Hello, Michael" — after it on a computer, before it on an iPad.
    bal = rx(r"Hello,[\s\S]{0,200}?@N\s*Points").search(text) or rx(r"@N\s*Points\b[^\n]{0,40}\n\s*Hello,").search(head)
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
        # The rate Hilton quotes, e.g. "Honors Discount Semi-flex" or "Honors Advance Purchase" (prepaid).
        rate_line = next((x for x in seg_lines if re.match(r"(Honors|Hilton Honors|Advance Purchase|Flexible|Semi-flex|Non-refundable)", x)), None)
        rate = None
        if rate_line:
            nm = re.sub(r"\s*(Breakfast Included|more info)$", "", rate_line).strip()
            rate = {"name": nm, "member": "Honors" in nm, "breakfast": "Breakfast Included" in rate_line,
                    "prepaid": bool(re.search(r"Advance Purchase|Non-?refundable|Prepa", nm, re.I))}
        hotels.append({"name": lines[s], "distanceKm": dist_km(d) if d else None, "rate": rate,
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
    pref = re.search(r"RATE PREFERENCE\s*\n\s*([^\n]+)", text)
    pref = pref[1].strip() if pref else None
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
                       "rate": {"name": pref, "member": bool(re.search(r"member", pref or "", re.I)), "prepaid": False} if pref else None,
                       "soldOut": "No rooms available" in seg})
    found = re.search(r"(\d+) Hotels Found", text)
    return {"hotels": hotels, **account_ihg(text), "expected": int(found[1]) if found else None}


CUR = {"£": "GBP", "€": "EUR", "$": "USD", "EUR": "EUR", "GBP": "GBP", "USD": "USD", "CHF": "CHF"}
MONEY = r"(?:(£|€|\$|EUR|GBP|USD|CHF)\s?@N|@N\s?(€|EUR))"


def money(m):
    """(amount, currency) from a MONEY match."""
    if not m:
        return None, None
    amt = m.group(2) if m.group(1) else m.group(3)
    cur = m.group(1) or m.group(4)
    return num(amt), CUR.get(cur, cur)


def account_generic(text):
    """Sign-in state for sites without a dedicated reader: an account greeting or a sign-out link."""
    head = text[:1500]
    if re.search(r"\b(Sign out|Log out|Logout|Abmelden|My account|Mein Konto|Hello,|Hi,|Hallo,)", head, re.I):
        return {"signedIn": True, "balance": None, "tier": None}
    if re.search(r"\b(Sign in|Log in|Login|Anmelden|Join now|Become a member)\b", head, re.I):
        return {"signedIn": False, "balance": None, "tier": None}
    return {"signedIn": None, "balance": None, "tier": None}


# ---------- ALL Accor (destination list; prices are for the whole stay) ----------
def accor(text, nights=1):
    hotels = []
    chunks = re.split(r"See the hotel|See availability", text)
    for ch in chunks:
        lines = lines_of(ch)
        idx = next((i for i, l in enumerate(lines) if re.search(r"km from your search|mi from your search", l)), -1)
        if idx < 0:
            continue
        name = None
        for l in reversed(lines[:idx]):
            if re.fullmatch(r"\d+(\.\d)?|\d+/\d+|\d(\.\d)?/5|\(\d[\d,.]* reviews\)|Hotel|Hotels|Aparthotels?|Resort|Apartments?|Hostel", l):
                continue
            name = l
            break
        seg = "\n".join(lines[idx:])
        total, cur = money(rx(r"From\s+" + MONEY).search(seg))
        public, _ = money(rx(r"Public rate from\s+" + MONEY).search(seg))
        hotels.append({"name": name, "distanceKm": dist_km(lines[idx]),
                       "cashTotal": total, "cashPerNight": round(total / nights) if total else None, "currency": cur,
                       "points": None, "soldOut": "Unavailable for the selected dates" in seg,
                       "rate": {"name": "Member rate" if "Member rate" in seg else "Public rate",
                                "member": "Member rate" in seg, "prepaid": False, "breakfast": "Breakfast included" in seg,
                                "publicTotal": public} if total else None})
    found = re.search(r"(\d+) hotels? (?:are|is) available", text)
    return {"hotels": hotels, **account_generic(text), "expected": int(found[1]) if found else None}


# ---------- Radisson Rewards (destination list; prices per night) ----------
def radisson(text):
    hotels = []
    for ch in re.split(r"Includes taxes & fees|CHECK AVAILABILITY", text):
        lines = lines_of(ch)
        idx = next((i for i, l in enumerate(lines) if re.search(r"(kilometers|km) from central|miles? from central", l)), -1)
        if idx < 0:
            continue
        name = None
        for l in reversed(lines[:idx]):
            if l == "|" or re.fullmatch(r"[\d,.]+ reviews?", l):
                continue
            name = l
            break
        seg = "\n".join(lines[idx:])
        price, cur = money(rx(r"From\s*\n?\s*" + MONEY).search(seg))
        hotels.append({"name": name, "distanceKm": dist_km(lines[idx].split("/")[-1]),
                       "cashPerNight": price, "currency": cur, "points": None,
                       "soldOut": bool(re.search(r"Opening soon|Sold out|No availability", seg, re.I)) and not price,
                       "rate": {"name": "Members' rate" if "Members' rate" in seg else "Standard rate",
                                "member": "Members' rate" in seg, "prepaid": False} if price else None})
    found = re.search(r"Showing (\d+) results", text)
    return {"hotels": hotels, **account_generic(text), "expected": int(found[1]) if found else None}


LISTS = {"Marriott": marriott, "Hilton": hilton, "IHG": ihg, "Accor": accor, "Radisson": radisson}
def account_amex(text):
    """Only ever sees the Membership Rewards lines the add-on picked out (see the add-on's page.js)."""
    bal = (rx(r"Membership Rewards[^\n]{0,40}\n?[^\n]{0,20}?@N").search(text)
           or rx(r"@N\s*(?:Membership Rewards[®]?\s*)?(?:Punkte|points)\b", re.I).search(text))
    # Only trust a number when the page also shows you're signed in — public Amex pages advertise
    # "50,000 Punkte" welcome bonuses that must never be mistaken for your balance.
    logged_in = bool(re.search(r"^(Abmelden|Log ?out|Sign ?out)$", text, re.M | re.I))
    logged_out = bool(re.search(r"^(Anmelden|Log ?in|Sign ?in)$", text, re.M | re.I))
    signed_in = True if logged_in else False if logged_out else None
    v = num(bal[1]) if bal and logged_in else None
    return {"signedIn": signed_in, "balance": v if v and v >= 1 else None, "tier": None}


def _top(text, n=8):
    return [l.strip() for l in text.split("\n") if l.strip()][:n]


SIGN_IN_WORDS = r"^(Anmelden|Einloggen|Registrieren|Sign in|Log in|Login|Join|Join now|Sign in / Join|Inscríbete|Iniciar sesión)$"


def account_accor(text):
    # Signed in: your name sits right under the menu button ("MENÜ" / "MENU"), e.g. "michael holzer".
    top = _top(text)
    if any(re.match(SIGN_IN_WORDS, l, re.I) for l in top):
        return {"signedIn": False, "balance": None, "tier": None}
    for i, l in enumerate(top[:-1]):
        if re.fullmatch(r"MEN[UÜ]", l, re.I):
            nxt = top[i + 1]
            if re.fullmatch(r"[^\d@]{3,40}", nxt) and not re.search(r"willkommen|welcome|wohin|where", nxt, re.I):
                return {"signedIn": True, "balance": None, "tier": None}
    return {"signedIn": None, "balance": None, "tier": None}


def account_radisson(text):
    # The page header shows "SIGN IN" next to "MY RESERVATIONS" when you're signed out.
    head = text[:4000]
    # Only a header button counts ("SIGN IN" on a line of its own), not a "Sign in to see member rates" banner.
    if re.search(r"^\s*(SIGN IN|Sign in|Log in|JOIN NOW|Join now)\s*$", head[:1500], re.M):
        return {"signedIn": False, "balance": None, "tier": None}
    if re.search(r"MY RESERVATIONS|My account|Hi,? [A-Z]", head):
        return {"signedIn": True, "balance": None, "tier": None}
    return {"signedIn": None, "balance": None, "tier": None}


def account_melia(text):
    # Signed in: "Your level is gold" and "You have 1,234 points" / "You don't have any points yet".
    level = re.search(r"Your level is (\w+)|Tu nivel es (\w+)|Ihr Level ist (\w+)", text, re.I)
    if level:
        bal = rx(r"You have @N points|Tienes @N puntos|Sie haben @N Punkte", re.I).search(text)
        none = re.search(r"don't have any points|no tienes puntos|keine Punkte", text, re.I)
        tier = next(g for g in level.groups() if g).capitalize()
        return {"signedIn": True, "balance": num(bal[1]) if bal else 0 if none else None, "tier": tier}
    if any(re.match(SIGN_IN_WORDS, l, re.I) for l in _top(text, 12)):
        return {"signedIn": False, "balance": None, "tier": None}
    return {"signedIn": None, "balance": None, "tier": None}


def account_gha(text):
    # Signed in: "Good Morning, Michael", "D$0 YOUR CURRENT BALANCE", "Gold Member - Member number …".
    greet = re.search(r"Good (Morning|Afternoon|Evening|Day), \w", text)
    bal = rx(r"D\$\s?@N\s*\n?\s*YOUR CURRENT BALANCE", re.I).search(text)
    tier = re.search(r"\b(Silver|Gold|Platinum|Titanium|Black)\s+Member\b", text)
    if greet or bal or tier:
        return {"signedIn": True, "balance": num(bal[1]) if bal else None, "tier": tier[1] if tier else None}
    if any(re.match(SIGN_IN_WORDS, l, re.I) for l in _top(text, 12)):
        return {"signedIn": False, "balance": None, "tier": None}
    return {"signedIn": None, "balance": None, "tier": None}


ACCOUNT.update({"Amex": account_amex, "Accor": account_accor, "Radisson": account_radisson, "Meliá": account_melia, "GHA": account_gha})


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


NOT_FOUND = re.compile(r"\b404\b|page (?:was )?not found|page you (?:are|were) looking for|Seite (?:wurde )?nicht gefunden|doesn't exist", re.I)


def read_page(chain, text, links=None, nights=1):
    """Everything the NAS needs from one results page."""
    if len(text) < 30000 and NOT_FOUND.search(text) and not re.search(r"from destination|from your search|from central|Opens new tab", text):
        # The site has no page for this city (e.g. Radisson has no hotels there): stop waiting straight away.
        return {"blocked": True, "missing": True, "noneFound": False, "hotels": [], "expected": None, "signedIn": None, "balance": None, "tier": None}
    if blocked(text):
        return {"blocked": True, "noneFound": False, "hotels": [], "expected": None, "signedIn": None, "balance": None, "tier": None}
    fn = LISTS.get(chain)
    if not fn:
        return {"blocked": False, "noneFound": False, "hotels": [], "expected": None, "signedIn": None, "balance": None, "tier": None}
    r = fn(text, nights) if chain == "Accor" else fn(text)
    attach_links(r["hotels"], links)
    r["blocked"] = False
    # The site itself says there's nothing for these dates (e.g. no reward nights) — not a reading problem.
    r["noneFound"] = not r["hotels"] and bool(re.search(
        r"\b0 Hotels? Found\b|No hotels found|No hotels available|no results|We couldn.t find any hotels", text, re.I))
    return r
