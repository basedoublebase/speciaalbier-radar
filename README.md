# 🍺 Speciaalbier Radar

Webapp die laat zien welke speciaalbieren goedkoop te koop zijn bij supermarkten bij jou in de buurt.
Per bier zie je de **prijs per liter**, het **alcoholpercentage** en de **prijs per liter pure alcohol**.

## Starten

```bash
./start.sh
```

Open daarna <http://localhost:8642>. Klik op **Gebruik mijn locatie**, zoek een plaats of klik op de kaart.
(Locatie werkt alleen via `localhost` of `https`, niet door `index.html` direct te openen.)

## Data verversen

```bash
python3 scripts/build_data.py      # prijzen + alcohol% → data/beers.json  (dagelijks bij te werken)
python3 scripts/build_stores.py    # alle NL-supermarkten uit OpenStreetMap → data/stores.json  (af en toe)
```

`build_data.py --no-off` slaat het opzoeken bij Open Food Facts over (sneller).

## Hoe het werkt

| Onderdeel | Bron |
|---|---|
| Prijzen en inhoud | [checkjebon](https://github.com/supermarkt/checkjebon): dagelijkse webshopprijzen van AH, Jumbo, Plus, Lidl, Dirk, DekaMarkt, Hoogvliet, Spar, Vomar en Poiesz |
| Herkennen van speciaalbier + stijl | `scripts/catalog.py` (handmatige catalogus met ~300 regels) |
| Alcohol % | catalogus → percentage in de productnaam → Open Food Facts → zelf invullen in de app |
| Supermarkten in de buurt | OpenStreetMap (vooraf in `data/stores.json`, anders live via Overpass) |
| Score | je eigen sterren (opgeslagen in je browser) + link naar Untappd |
| Openingstijden supermarkten | OpenStreetMap (`opening_hours`, in `data/stores.json`); feestdagen niet meegenomen |
| Drukte | link per winkel naar Google Maps (Google heeft geen openbare API voor drukte) |
| Chupitos-badge | openingstijden uit OpenStreetMap, vast in `app.js` (`CHUPITOS_HOURS`) |

Extra: toggle **Gewone pils meenemen**, filter op **verpakking** (25/30/33/50/75 cl …), filter
**Alleen winkels die nu open zijn**, en een pop-up als je sorteert op laagste prijs.

**Prijs per liter alcohol** = prijs ÷ (liters × alcohol% ÷ 100).

## Beperkingen

- Prijzen zijn landelijke webshopprijzen per keten. Filiaalvoorraad en tijdelijke acties (Bonus e.d.) zitten er niet in.
- Bij Lidl ontbreekt in de brondata vaak de verpakkingsgrootte. Zulke prijzen en andere twijfelgevallen krijgen ⚠ en staan standaard uit ("Onzekere prijzen").
- Aldi en Ekoplaza hebben geen prijsdata in de bron.
- Untappd-scores worden niet automatisch opgehaald: Untappd heeft geen open API meer en scrapen is niet toegestaan.
