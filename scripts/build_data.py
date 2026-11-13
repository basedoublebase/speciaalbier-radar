#!/usr/bin/env python3
"""Bouwt data/beers.json voor de Speciaalbier-app.

Stappen:
1. Download de dagelijkse supermarktprijzen van het open-sourceproject checkjebon
   (https://github.com/supermarkt/checkjebon).
2. Herken speciaalbieren via scripts/catalog.py (plus stijlwoorden voor onbekende bieren).
3. Reken de inhoud om naar liters ("6 x 0,3 l", "1.8 liter", "330ML", ...).
4. Zoek ontbrekende alcoholpercentages op: eerst in de productnaam, dan bij Open Food Facts.
   Resultaten van Open Food Facts worden gecachet in data/abv_cache.json.

Gebruik:  python3 scripts/build_data.py            (volledig)
          python3 scripts/build_data.py --no-off   (zonder Open Food Facts-opzoekingen)
"""
import json
import re
import statistics
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from catalog import CATALOG, EXCLUDE, STYLE_HINTS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw_supermarkets.json"
CACHE = DATA / "abv_cache.json"
OUT = DATA / "beers.json"
SOURCE_URL = "https://raw.githubusercontent.com/supermarkt/checkjebon/main/data/supermarkets.json"
UA = "speciaalbier-app/1.0 (persoonlijk project)"

EXCLUDE_RE = re.compile(EXCLUDE, re.I)
CATALOG_RE = [(re.compile(r"(?<![a-z])(?:" + p + ")", re.I), *rest) for p, *rest in CATALOG]
STYLE_RE = [(re.compile(p, re.I), s) for p, s in STYLE_HINTS]
NOT_SPECIAAL = {"Pils"}

# Pils/lagermerken: zonder catalogusmatch nooit als speciaalbier tellen.
PILS_BRANDS = re.compile(
    r"^(amstel|heineken|grolsch|bavaria|alfa|dommelsch|jupiler|warsteiner|veltins|export|best bier|holtland|"
    r"holger|schutters|brouwers premium|lander br|bud|chang|sapporo|tsingtao|peroni|birra moretti|estrella|"
    r"san miguel|super bock|sol|corona|mythos|zubr|zywiec|warka|faxe|habesha|de klok bier|victoria bier|"
    r"oranje bier|tequila|camaro|desperados|hertog jan( bier| natuurzuiver| gekoeld)?$|brand bier$|gulpener$|"
    r"gulpener biologisch bier$|bier veltins|frühlingsbier|stella|kroon)", re.I)


# ---------------------------------------------------------------- helpers
def norm(name: str) -> str:
    n = name.lower().replace("’", "'").replace("´", "'")
    n = re.sub(r"\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)*(ml|cl|l|liter|ltr|milliliter|centiliter)\b", " ", n)
    n = re.sub(r"\b\d+\s*x\b", " ", n)
    n = re.sub(r"\b(fles|flessen|flesje|blik|blikken|blikje|krat|tray|\d+-?pack|\d+ ?pak|pack|los|losse|st|stg|stgl|"
               r"fl|bl|stuks?|multipack|doos|sixpack|set|coolcan|cool can|beugelfles|gekoeld|bel)\b", " ", n)
    n = re.sub(r"[-–|()®,/!¡]", " ", n)
    n = re.sub(r"^\. ?", "st. ", n)  # 'St. Bernardus' -> 'St' wordt soms weggeknipt
    return re.sub(r"\s+", " ", n).strip()


UNIT = {"ml": 0.001, "milliliter": 0.001, "cl": 0.01, "centiliter": 0.01, "l": 1.0, "liter": 1.0, "ltr": 1.0,
        "gram": 0.001, "g": 0.001}
NUM = r"(\d+(?:[.,]\d+)?)"
UNITS = r"(ml|milliliter|cl|centiliter|liter|ltr|l)\b"


def f(x: str) -> float:
    return float(x.replace(",", "."))


def multi_parts(text: str):
    """'4 x 6 x 330ml' / '6 x 0,3 l' / '6x33cl' -> (aantal, liter per stuk)."""
    t = text.lower()
    m = re.search(rf"(\d+)\s*x\s*(\d+)\s*x\s*{NUM}\s*{UNITS}", t)
    if m:
        return int(m.group(1)) * int(m.group(2)), f(m.group(3)) * UNIT[m.group(4)]
    m = re.search(rf"(\d+)\s*x\s*{NUM}\s*{UNITS}", t)
    if m:
        return int(m.group(1)), f(m.group(2)) * UNIT[m.group(3)]
    return None


def multi_size(text: str):
    mp = multi_parts(text)
    return mp[0] * mp[1] if mp else None


def single_size(text: str):
    t = text.lower()
    m = re.search(rf"{NUM}\s*{UNITS}", t)
    if m:
        return f(m.group(1)) * UNIT[m.group(2)]
    m = re.search(rf"{NUM}\s*gram\b", t)  # Poiesz: '12000 Gram'
    if m:
        return f(m.group(1)) * 0.001
    return None


def pack_count(text: str):
    m = re.search(r"\b(\d+)\s*-?\s*(pack|pak|stuks|st\.)\b", text.lower())
    return int(m.group(1)) if m else None


# Gangbare totale inhoud van multipacks -> (aantal, liter per stuk), als de verpakking niet expliciet is
COMMON_PACKS = {1.2: (4, 0.3), 1.32: (4, 0.33), 1.8: (6, 0.3), 1.98: (6, 0.33), 2.0: (4, 0.5), 3.0: (6, 0.5),
                3.6: (12, 0.3), 3.96: (12, 0.33), 6.0: (12, 0.5), 7.2: (24, 0.3), 7.92: (24, 0.33), 12.0: (24, 0.5)}


def parse_liters(name: str, size: str):
    """Geeft (totaal liters, liters per fles/blik of None, aantal of None) terug."""
    for txt in (name, size or ""):
        mp = multi_parts(txt)
        if mp:
            return mp[0] * mp[1], mp[1], mp[0]
    sn, ss = single_size(name), single_size(size or "")
    if sn and ss and abs(sn - ss) > 1e-6:
        # bv. naam '300ml' + veld '1.8 liter' (6 x 0,3), of naam '750 ml' + veld '75 ml' (tikfout)
        big, small = max(sn, ss), min(sn, ss)
        n = round(big / small)
        if n > 1 and small >= 0.15 and abs(n * small - big) < 0.02 and n <= 24:
            return big, small, n
        return big, big, 1
    one = sn or ss
    if not one:
        return None, None, None
    n = pack_count(name) or pack_count(size or "")
    if n and n <= 24:
        if one < 1.0:
            return one * n, one, n
        return one, one / n, n
    if one >= 1.0:
        guess = COMMON_PACKS.get(round(one, 2))
        if guess:
            return one, guess[1], guess[0]
        return one, None, None
    return one, one, 1


def abv_from_name(name: str):
    m = re.search(r"(\d{1,2})[.,](\d{1,2})\s?%", name)
    if m:
        v = float(f"{m.group(1)}.{m.group(2)}")
    else:
        m = re.search(r"\b(\d{1,2})\s?%", name) or re.search(r"\b(\d) (\d)%", name)
        if not m:
            return None
        v = float(m.group(1)) if m.lastindex == 1 else float(f"{m.group(1)}.{m.group(2)}")
    return v if 1.0 <= v <= 20 else None


def clean_display(name: str) -> str:
    n = re.sub(r"\s*-\s*", " ", name)
    n = re.sub(rf"\d+\s*x\s*(\d+\s*x\s*)?{NUM}\s*{UNITS}", "", n, flags=re.I)
    n = re.sub(rf"{NUM}\s*{UNITS}", "", n, flags=re.I)
    n = re.sub(r"\b(fles|flessen|blik|blikken|krat|tray|\d+-?pack|los|losse|stuks?)\b", "", n, flags=re.I)
    return re.sub(r"\s+", " ", n).strip(" -")


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def unsure(chain, raw, size, liters, price, ppl, style):
    """Markeer prijzen waarvan de inhoud waarschijnlijk niet klopt."""
    multi = bool(multi_size(raw) or multi_size(size))
    if chain == "lidl" and not multi:
        return True  # Lidl-data (via boodschaapje.nl) mist vaak de verpakkingsgrootte
    if not multi and liters <= 0.5 and price >= 6:
        return True  # 'losse fles' van 6+ euro is bijna altijd een multipack
    if style != "Sterk lager" and ppl < 2.2:
        return True
    return False


# ---------------------------------------------------------------- Open Food Facts
def load_cache():
    try:
        return json.loads(CACHE.read_text())
    except Exception:
        return {}


OFF_FAILS = 0


def off_brand_products(brand_slug: str, cache: dict):
    """Alle producten van een merk bij Open Food Facts (gecachet): [(naam, alcohol%)]."""
    if brand_slug in cache:
        return cache[brand_slug]
    url = "https://world.openfoodfacts.org/api/v2/search?" + urllib.parse.urlencode({
        "brands_tags": brand_slug, "page_size": 200, "fields": "product_name,brands,nutriments"})
    global OFF_FAILS
    if OFF_FAILS >= 3:
        return []  # Open Food Facts lijkt overbelast: niet blijven proberen
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
        OFF_FAILS = 0
    except Exception as e:  # rate limit of netwerkfout
        OFF_FAILS += 1
        print(f"   OFF fout ({e})" + ("; Open Food Facts overgeslagen, probeer later opnieuw" if OFF_FAILS >= 3 else ""), flush=True)
        time.sleep(5)
        return []  # niet cachen, volgende keer opnieuw proberen
    out = []
    for p in data.get("products", []):
        nut = p.get("nutriments") or {}
        a = nut.get("alcohol_100g", nut.get("alcohol"))
        try:
            a = float(a)
        except (TypeError, ValueError):
            continue
        name = f"{p.get('product_name') or ''} {p.get('brands') or ''}".lower()
        if 1.0 <= a <= 20 and not re.search(r"0[.,]0|alcoholvrij|alcohol free|sans alcool|alkoholfrei", name):
            out.append([name, a])
    cache[brand_slug] = out
    CACHE.write_text(json.dumps(cache, indent=1, ensure_ascii=False, sort_keys=True))
    time.sleep(6.5)  # Open Food Facts staat ~10 zoekopdrachten per minuut toe
    return out


GENERIC = {"bier", "beer", "the", "van", "de", "het", "brewing", "brouwerij", "diverse", "overig"}


def off_abv(beer: dict, cache: dict):
    words = re.findall(r"[a-z0-9']+", re.sub(r"\(.*?\)", "", beer["name"]).lower().replace("'t ", "t "))
    if not words:
        return None
    slugs = []
    if len(words) >= 2:
        slugs.append(slug(" ".join(words[:2])))
    slugs.append(slug(words[0]))
    tokens = [w for w in words if w not in GENERIC and (len(w) > 2 or w.isdigit())]
    vals = []
    for sl in slugs:
        for name, a in off_brand_products(sl, cache):
            if tokens and sum(t in name for t in tokens) / len(tokens) >= 0.99:
                vals.append(a)
        if vals:
            break
    return round(statistics.median(vals), 1) if vals else None


# ---------------------------------------------------------------- main
def main():
    use_off = "--no-off" not in sys.argv
    DATA.mkdir(exist_ok=True)
    if "--cached" not in sys.argv or not RAW.exists():
        print("Prijsdata downloaden...", flush=True)
        req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            RAW.write_bytes(r.read())
    stores = json.loads(RAW.read_text())

    chains, beers = {}, {}
    stats = {"kandidaten": 0, "geen_inhoud": 0, "onwaarschijnlijke_prijs": 0}
    for s in stores:
        key = s["n"]
        chains[key] = {"name": re.sub(r"\s*\(via .*?\)", "", s.get("c", key)), "logo": s.get("i"), "productUrl": s.get("u")}
        seen = set()
        for p in s.get("d", []):
            raw, size, price = p.get("n", ""), p.get("s", "") or "", p.get("p")
            if not raw or not price or EXCLUDE_RE.search(raw):
                continue
            n = norm(raw)
            entry = None
            for rx, brewery, bname, style, abv in CATALOG_RE:
                if rx.search(n):
                    entry = (brewery, bname, style, abv)
                    break
            if entry and entry[0] is None:
                continue  # expliciet overslaan
            if not entry:
                if PILS_BRANDS.search(n):
                    continue
                if not re.search(r"bier|beer|\bipa\b|\bale\b|stout|porter|weizen|weiss|tripel|triple|quadru", n):
                    continue
                style = next((st for rx, st in STYLE_RE if rx.search(n)), None)
                if not style:
                    continue
                disp = clean_display(raw)
                entry = (None, disp[:1].upper() + disp[1:], style, None)
            stats["kandidaten"] += 1

            liters, unit, count = parse_liters(raw, size)
            if not liters:
                stats["geen_inhoud"] += 1
                continue
            ppl = price / liters
            if not (0.8 <= ppl <= 45):
                stats["onwaarschijnlijke_prijs"] += 1
                continue
            uid = (key, p.get("l"))
            if uid in seen:
                continue
            seen.add(uid)

            brewery, bname, style, abv = entry
            bid = slug(bname)
            b = beers.setdefault(bid, {"id": bid, "name": bname, "brewery": brewery, "style": style,
                                       "strong": style == "Sterk lager", "pils": style == "Pils", "abv": abv,
                                       "abvSource": "catalogus" if abv else None, "products": []})
            if b["abv"] is None:
                a = abv_from_name(raw)
                if a:
                    b["abv"], b["abvSource"] = a, "productnaam"
            b["products"].append({
                "chain": key, "name": raw, "size": size, "liters": round(liters, 3), "price": price,
                "ppl": round(ppl, 2), "unit": round(unit, 3) if unit else None, "count": count, "url": (s.get("u") or "") + (p.get("l") or ""),
                "unsure": unsure(key, raw, size, liters, price, ppl, style),
            })

    if use_off:
        cache = load_cache()
        todo = [b for b in beers.values() if b["abv"] is None]
        print(f"{len(todo)} bieren zonder alcoholpercentage, opzoeken bij Open Food Facts...", flush=True)
        for i, b in enumerate(todo, 1):
            a = off_abv(b, cache)
            print(f"  [{i}/{len(todo)}] {b['name']}: {a}", flush=True)
            if a:
                b["abv"], b["abvSource"] = a, "Open Food Facts"

    out_beers = []
    for b in beers.values():
        b["products"].sort(key=lambda x: x["ppl"])
        for pr in b["products"]:
            pr["ppa"] = round(pr["ppl"] / (b["abv"] / 100), 2) if b["abv"] else None
        out_beers.append(b)
    out_beers.sort(key=lambda b: b["name"])

    OUT.write_text(json.dumps({
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "source": "https://github.com/supermarkt/checkjebon",
        "chains": chains, "beers": out_beers,
    }, ensure_ascii=False, separators=(",", ":")))

    n_prod = sum(len(b["products"]) for b in out_beers)
    n_abv = sum(1 for b in out_beers if b["abv"])
    print(f"\nKlaar: {len(out_beers)} bieren, {n_prod} producten, {n_abv} met alcohol%. {stats}")
    print(f"Geschreven naar {OUT}")


if __name__ == "__main__":
    main()
