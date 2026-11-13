#!/usr/bin/env python3
"""Haalt alle supermarkten in Nederland op uit OpenStreetMap (Overpass API)
en schrijft data/stores.json. Hoeft maar af en toe opnieuw (winkels veranderen weinig).

Gebruik: python3 scripts/build_stores.py
"""
import json
import sys
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "stores.json"
UA = "speciaalbier-app/1.0 (persoonlijk project)"
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# Bounding box van Europees Nederland (incl. een strookje BE/DE langs de grens)
QUERY = """[out:json][timeout:300][bbox:50.70,3.30,53.60,7.25];
nwr["shop"="supermarket"];
out center tags;"""

CHAIN_RULES = [
    ("ah", r"albert heijn|^ah( to go)?\b"), ("jumbo", r"jumbo"), ("plus", r"^plus\b"), ("lidl", r"lidl"),
    ("aldi", r"aldi"), ("dirk", r"\bdirk\b"), ("dekamarkt", r"deka ?markt"), ("hoogvliet", r"hoogvliet"),
    ("spar", r"\bspar\b"), ("vomar", r"vomar"), ("poiesz", r"poiesz"), ("ekoplaza", r"ekoplaza"),
]


def chain_of(tags):
    txt = " | ".join(t for t in (tags.get("brand"), tags.get("name"), tags.get("operator")) if t)
    for key, rx in CHAIN_RULES:
        if re.search(rx, txt, re.I):
            return key
    return None


def main():
    if len(sys.argv) > 1:  # bestaand Overpass-antwoord inlezen (bv. gedownload met curl)
        data = json.loads(Path(sys.argv[1]).read_text())
        return write(data)
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    for ep in ENDPOINTS * 2:
        try:
            print(f"Opvragen bij {ep} ...", flush=True)
            req = urllib.request.Request(ep, data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=360) as r:
                data = json.load(r)
            if data.get("remark") or len(data.get("elements", [])) < 1000:
                raise RuntimeError(f"onvolledig antwoord ({len(data.get('elements', []))} items) {data.get('remark', '')}")
            break
        except Exception as e:
            print(f"  mislukt: {e}", flush=True)
            time.sleep(10)
    else:
        raise SystemExit("Geen Overpass-server bereikbaar; probeer later opnieuw.")
    write(data)


def write(data):

    stores = []
    for e in data.get("elements", []):
        tags = e.get("tags", {})
        lat = e.get("lat") or (e.get("center") or {}).get("lat")
        lon = e.get("lon") or (e.get("center") or {}).get("lon")
        chain = chain_of(tags)
        if lat is None or not chain:
            continue
        addr = " ".join(x for x in (tags.get("addr:street"), tags.get("addr:housenumber")) if x)
        city = tags.get("addr:city", "")
        stores.append([round(lat, 5), round(lon, 5), chain, tags.get("name") or tags.get("brand") or chain,
                       ", ".join(x for x in (addr, city) if x), tags.get("opening_hours", "")])
    OUT.write_text(json.dumps({"fields": ["lat", "lon", "chain", "name", "addr", "opening_hours"], "stores": stores},
                              ensure_ascii=False, separators=(",", ":")))
    print(f"Klaar: {len(stores)} supermarkten naar {OUT}")


if __name__ == "__main__":
    main()
