/* Speciaalbier Radar: client-side app.
   Data: data/beers.json (gebouwd door scripts/build_data.py)
   Winkels: OpenStreetMap via de Overpass API, op basis van je locatie. */
(() => {
  "use strict";

  // ------------------------------------------------------------------ config
  const CHAIN_RULES = [
    ["ah", /albert heijn|^ah( to go)?\b/i],
    ["jumbo", /jumbo/i],
    ["plus", /^plus\b/i],
    ["lidl", /lidl/i],
    ["aldi", /aldi/i],
    ["dirk", /\bdirk\b/i],
    ["dekamarkt", /deka ?markt/i],
    ["hoogvliet", /hoogvliet/i],
    ["spar", /\bspar\b/i],
    ["vomar", /vomar/i],
    ["poiesz", /poiesz/i],
    ["ekoplaza", /ekoplaza/i],
  ];
  const CHAIN_COLORS = {
    ah: "#00a0e2", jumbo: "#eeb717", plus: "#5a9c2e", lidl: "#0050aa", aldi: "#1c3f94", dirk: "#d9232d",
    dekamarkt: "#e30613", hoogvliet: "#ef7d00", spar: "#00843d", vomar: "#c8102e", poiesz: "#e2001a",
    ekoplaza: "#7ab51d", other: "#888888",
  };
  const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  const PAGE = 60;

  // ------------------------------------------------------------------ state
  const $ = (id) => document.getElementById(id);
  const S = {
    data: null, pos: null, radiusKm: 3, stores: [], nearby: {}, shown: PAGE,
    ratings: loadJSON("sbr.ratings", {}),
    abvOverride: loadJSON("sbr.abv", {}),
  };
  const abvOf = (b) => S.abvOverride[b.id] ?? b.abv;
  const ppaOf = (ppl, abv) => (abv ? ppl / (abv / 100) : null);
  const prefs = loadJSON("sbr.prefs", {});

  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* privé-modus */ } }

  const eur = (v) => v == null ? "–" : "€ " + v.toFixed(2).replace(".", ",");
  const pct = (v) => v == null ? "?" : String(v).replace(".", ",") + "%";
  const km = (m) => m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(1).replace(".", ",") + " km";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // ------------------------------------------------------------------ map
  const map = L.map("map", { zoomControl: true }).setView([52.2, 5.3], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap-bijdragers",
  }).addTo(map);
  const storeLayer = L.layerGroup().addTo(map);
  let meMarker = null, radiusCircle = null;
  map.on("click", (e) => setPosition(e.latlng.lat, e.latlng.lng, "Gekozen op de kaart"));

  // ------------------------------------------------------------------ location
  function locate() {
    if (!navigator.geolocation) return status("Je browser ondersteunt geen locatie. Zoek een plaats of klik op de kaart.");
    $("btnLocate").disabled = true;
    status("Locatie opvragen…");
    navigator.geolocation.getCurrentPosition(
      (p) => { $("btnLocate").disabled = false; setPosition(p.coords.latitude, p.coords.longitude, "Je huidige locatie"); },
      (err) => {
        $("btnLocate").disabled = false;
        status(err.code === 1 ? "Locatie geweigerd. Zoek een plaats of klik op de kaart." : "Locatie niet beschikbaar (" + err.message + ").");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  async function searchPlace(q) {
    status("Zoeken naar “" + q + "”…");
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl&q=" + encodeURIComponent(q);
      const r = await fetch(url, { headers: { "Accept-Language": "nl" } });
      const j = await r.json();
      if (!j.length) return status("Niets gevonden voor “" + q + "”.");
      setPosition(+j[0].lat, +j[0].lon, j[0].display_name.split(",").slice(0, 2).join(","));
    } catch (e) { status("Zoeken mislukt: " + e.message); }
  }

  function setPosition(lat, lon, label) {
    S.pos = { lat, lon, label };
    prefs.pos = S.pos; saveJSON("sbr.prefs", prefs);
    if (meMarker) meMarker.remove();
    meMarker = L.circleMarker([lat, lon], { radius: 8, color: "#fff", weight: 2, fillColor: "#c27a12", fillOpacity: 1 })
      .addTo(map).bindTooltip("Jij");
    drawRadius();
    loadStores();
  }

  function drawRadius() {
    if (!S.pos) return;
    if (radiusCircle) radiusCircle.remove();
    radiusCircle = L.circle([S.pos.lat, S.pos.lon], { radius: S.radiusKm * 1000, color: "#c27a12", weight: 1, fillOpacity: 0.05 }).addTo(map);
    map.fitBounds(radiusCircle.getBounds(), { padding: [10, 10] });
  }

  function status(t) { $("locStatus").textContent = t; }

  // ------------------------------------------------------------------ stores (Overpass)
  function chainOf(tags) {
    const txt = [tags.brand, tags.name, tags.operator].filter(Boolean).join(" | ");
    for (const [key, rx] of CHAIN_RULES) if (rx.test(txt)) return key;
    return null;
  }

  async function fetchStores(lat, lon, radiusM) {
    const ck = `sbr.osm.${lat.toFixed(3)},${lon.toFixed(3)},${radiusM}`;
    try { const c = sessionStorage.getItem(ck); if (c) return JSON.parse(c); } catch { /* geen cache */ }
    const q = `[out:json][timeout:25];(node["shop"="supermarket"](around:${radiusM},${lat},${lon});` +
              `way["shop"="supermarket"](around:${radiusM},${lat},${lon}););out center tags;`;
    let lastErr;
    for (const ep of OVERPASS) {
      try {
        const r = await fetch(ep, { method: "POST", body: "data=" + encodeURIComponent(q),
          headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(25000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        const els = j.elements.map((e) => ({
          lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon,
          name: e.tags?.name || e.tags?.brand || "Supermarkt", chain: chainOf(e.tags || {}),
          addr: [e.tags?.["addr:street"], e.tags?.["addr:housenumber"]].filter(Boolean).join(" "),
          oh: e.tags?.opening_hours || "",
        })).filter((e) => e.lat != null);
        try { sessionStorage.setItem(ck, JSON.stringify(els)); } catch { /* vol */ }
        return els;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  let storeReq = 0;
  async function loadStores() {
    if (!S.pos) return;
    const id = ++storeReq;
    status("Supermarkten zoeken binnen " + S.radiusKm + " km…");
    S.loading = true; render();
    try {
      const els = S.localStores
        ? S.localStores.filter((e) => haversine(S.pos, e) <= S.radiusKm * 1000)
        : await fetchStores(S.pos.lat, S.pos.lon, S.radiusKm * 1000);
      if (id !== storeReq) return;
      S.stores = els.map((e) => ({ ...e, dist: haversine(S.pos, e) })).sort((a, b) => a.dist - b.dist);
      refreshNearby();
      const n = Object.keys(S.nearby).filter((k) => S.data?.chains[k] && hasData(k)).length;
      status(`${S.pos.label}: ${S.stores.length} supermarkten, ${n} ketens met prijsdata.`);
    } catch (e) {
      status("Supermarkten ophalen mislukt (" + e.message + "). Probeer het zo opnieuw.");
    }
    S.loading = false;
    S.shown = PAGE;
    render();
  }

  /** Openingsstatus per winkel bijwerken en per keten de dichtstbijzijnde (open) winkel kiezen. */
  function refreshNearby() {
    const onlyOpen = $("onlyOpen").checked;
    S.nearby = {};
    for (const s of S.stores) {
      s.hours = Hours.status(s.oh);
      if (!s.chain || s.chain in S.nearby) continue;
      if (onlyOpen && !s.hours?.open) continue;
      S.nearby[s.chain] = s;
    }
    drawStores();
  }

  function hoursHtml(h) {
    if (!h) return '<span class="muted">openingstijden onbekend</span>';
    return h.open ? `<span class="open-txt">open tot ${h.until}</span>` : `<span class="closed-txt">gesloten${h.opens ? " · opent " + h.opens : ""}</span>`;
  }
  const dot = (h) => `<span class="dot ${h ? (h.open ? "open" : "closed") : ""}"></span>`;
  const gmaps = (s) => `https://www.google.com/maps/search/${encodeURIComponent(s.name)}/@${s.lat},${s.lon},18z`;

  function hasData(chain) { return S.data && S.data.beers.some((b) => b.products.some((p) => p.chain === chain)); }

  function drawStores() {
    storeLayer.clearLayers();
    for (const s of S.stores) {
      const color = CHAIN_COLORS[s.chain] || CHAIN_COLORS.other;
      L.circleMarker([s.lat, s.lon], { radius: 6, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: 0.95 })
        .bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.addr)}<br>${km(s.dist)} · ${hoursHtml(s.hours)}` +
          (s.oh ? `<br><small>${esc(Hours.describe(s.oh))}</small>` : "") +
          `<br><a href="${gmaps(s)}" target="_blank" rel="noopener">Drukte &amp; info op Google Maps ↗</a>` +
          (s.chain && !hasData(s.chain) ? "<br><i>Geen prijsdata voor deze keten</i>" : ""))
        .addTo(storeLayer);
    }
    const el = $("chains");
    const chips = Object.entries(S.nearby).map(([k, s]) => {
      const c = S.data?.chains[k];
      const ok = hasData(k);
      const logo = c?.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" onerror="this.remove()">` : "";
      const tip = (ok ? "" : "Geen prijsdata · ") + (s.hours ? (s.hours.open ? "Nu open tot " + s.hours.until : "Gesloten" + (s.hours.opens ? ", opent " + s.hours.opens : "")) : "Openingstijden onbekend");
      return `<a class="chain-chip${ok ? "" : " nodata"}" title="${esc(tip)}" href="${gmaps(s)}" target="_blank" rel="noopener">${logo}${esc(c?.name || k)} · ${km(s.dist)} ${dot(s.hours)}</a>`;
    });
    el.innerHTML = chips.length ? chips.join("") : (S.pos ? `<span class="muted">Geen bekende supermarktketens ${$("onlyOpen").checked ? "die nu open zijn " : ""}in deze straal.</span>` : "");
  }

  // ------------------------------------------------------------------ list
  function offersFor(beer) {
    const onlyNearby = $("onlyNearby").checked && S.pos;
    const showUnsure = $("showUnsure").checked;
    const maxPpl = parseFloat($("maxPpl").value);
    const unit = +$("unit").value;
    return beer.products.filter((p) =>
      (!onlyNearby || p.chain in S.nearby) &&
      (!unit || (p.unit && Math.round(p.unit * 1000) === unit)) &&
      (showUnsure || !p.unsure) &&
      (!(maxPpl > 0) || p.ppl <= maxPpl));
  }

  function computeRows() {
    const q = $("q").value.trim().toLowerCase();
    const style = $("style").value;
    const minAbv = parseFloat($("minAbv").value) || 0;
    const showStrong = $("showStrong").checked;
    const showPils = $("showPils").checked;
    const rows = [];
    for (const b of S.data.beers) {
      if (b.strong && !showStrong) continue;
      if (b.pils && !showPils) continue;
      if (style && b.style !== style) continue;
      if (minAbv && !(abvOf(b) >= minAbv)) continue;
      if (q && !(`${b.name} ${b.brewery || ""} ${b.style}`.toLowerCase().includes(q))) continue;
      const offers = offersFor(b);
      if (!offers.length) continue;
      offers.sort((x, y) => x.ppl - y.ppl);
      const best = offers[0];
      const score = S.ratings[b.id] || null;
      const ppa = ppaOf(best.ppl, abvOf(b));
      rows.push({
        b, offers, best, score, ppa,
        minPrice: Math.min(...offers.map((o) => o.price)),
        value: ppa == null ? null : ppa / ((score || 2.5) / 2.5),
      });
    }
    const sort = $("sort").value;
    const nullLast = (f, dir = 1) => (x, y) => {
      const a = f(x), c = f(y);
      if (a == null && c == null) return 0;
      if (a == null) return 1;
      if (c == null) return -1;
      return (a - c) * dir;
    };
    const cmp = {
      ppa: nullLast((r) => r.ppa), ppl: nullLast((r) => r.best.ppl), price: nullLast((r) => r.minPrice),
      abv: nullLast((r) => abvOf(r.b), -1), score: nullLast((r) => r.score, -1), value: nullLast((r) => r.value),
      name: (x, y) => x.b.name.localeCompare(y.b.name, "nl"),
    }[sort];
    rows.sort(cmp);
    return rows;
  }

  function stars(id, score) {
    let h = `<span class="stars" role="group" aria-label="Mijn score">`;
    for (let i = 1; i <= 5; i++) h += `<button data-rate="${id}" data-v="${i}" class="${score >= i ? "on" : ""}" aria-label="${i} ster${i > 1 ? "ren" : ""}">★</button>`;
    return h + "</span>";
  }

  function nearestLabel(chain) {
    const s = S.nearby[chain];
    return s ? `<span class="far">${km(s.dist)}</span> ${dot(s.hours)}` : "";
  }

  const cl = (l) => (Math.round(l * 1000) / 10).toString().replace(".", ",") + " cl";
  const packLabel = (o) => o.unit ? (o.count > 1 ? `${o.count} × ${cl(o.unit)}` : cl(o.unit)) : o.liters.toFixed(2).replace(".", ",") + " L";

  function abvSrc(b) {
    const src = b.id in S.abvOverride ? "eigen invoer" : b.abvSource;
    return src ? `<div class="abv-src">${esc(src)}</div>` : "";
  }

  function card(r) {
    const { b, best, offers, score } = r;
    const chains = S.data.chains;
    const rowsHtml = offers.map((o) => `
      <tr>
        <td>${esc(chains[o.chain]?.name || o.chain)} ${nearestLabel(o.chain)}</td>
        <td><a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.name)}</a>${o.unsure ? ' <span class="warn" title="Inhoud of prijs mogelijk onjuist in de brondata">⚠</span>' : ""}</td>
        <td class="n hide-sm">${packLabel(o)}</td>
        <td class="n">${eur(o.price)}</td>
        <td class="n">${eur(o.ppl)}</td>
        <td class="n">${eur(ppaOf(o.ppl, abvOf(b)))}</td>
      </tr>`).join("");
    const untappd = "https://untappd.com/search?q=" + encodeURIComponent(b.name.replace(/\(.*?\)/g, ""));
    return `
    <article class="beer">
      <div class="beer-head">
        <div>
          <h3 class="beer-name">${esc(b.name)}</h3>
          <div class="beer-meta"><span class="tag">${esc(b.style)}</span>${esc(b.brewery || "")}</div>
          <div class="units" title="Beschikbare inhoud per fles/blik">${[...new Set(offers.filter((o) => o.unit).map((o) => Math.round(o.unit * 1000)))].sort((x, y) => x - y).map((u) => `<span class="unit-chip">${cl(u / 1000)}</span>`).join("")}</div>
        </div>
        <div>${stars(b.id, score)}</div>
      </div>
      <div class="stats">
        <div class="stat hl"><span>€ / liter alcohol</span><b>${eur(r.ppa)}</b></div>
        <div class="stat"><span>€ / liter</span><b>${eur(best.ppl)}</b></div>
        <div class="stat"><span>Alcohol</span><b>${pct(abvOf(b))} <button class="edit" data-abv="${b.id}" title="Alcoholpercentage aanpassen">${abvOf(b) == null ? "invullen" : "✎"}</button></b>${abvSrc(b)}</div>
        <div class="stat"><span>Goedkoopst bij</span><b style="font-size:14px">${esc(chains[best.chain]?.name || best.chain)}</b><div class="abv-src">${eur(best.price)} · ${packLabel(best)}</div></div>
      </div>
      <div class="beer-foot">
        <details><summary>${offers.length} aanbieding${offers.length > 1 ? "en" : ""} vergelijken</summary>
          <table class="offers">
            <thead><tr><th>Keten</th><th>Product</th><th class="n hide-sm">Inhoud</th><th class="n">Prijs</th><th class="n">€/L</th><th class="n">€/L alc.</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </details>
        <a href="${untappd}" target="_blank" rel="noopener">Bekijk score op Untappd ↗</a>
      </div>
    </article>`;
  }

  function render() {
    if (!S.data) return;
    savePrefs();
    const list = $("list");
    if (S.loading) { list.innerHTML = '<div class="empty">Supermarkten in de buurt zoeken…</div>'; $("summary").textContent = ""; return; }
    const rows = computeRows();
    if (!rows.length) {
      list.innerHTML = `<div class="empty">${S.pos ? "Geen bieren gevonden met deze filters." : "Kies je locatie om bieren in de buurt te zien."}</div>`;
    } else {
      list.innerHTML = rows.slice(0, S.shown).map(card).join("") +
        (rows.length > S.shown ? `<button class="btn" id="more" style="justify-self:center">Toon meer (${rows.length - S.shown})</button>` : "");
    }
    const where = $("onlyNearby").checked && S.pos ? `bij ${Object.keys(S.nearby).filter(hasData).length} ketens in de buurt` : "bij alle ketens";
    $("summary").textContent = `${rows.length} ${$("showPils").checked ? "bieren (incl. pils)" : "speciaalbieren"} ${where}.`;
  }

  // ------------------------------------------------------------------ prefs & events
  const FILTER_IDS = ["q", "style", "unit", "sort", "minAbv", "maxPpl", "showPils", "showStrong", "showUnsure", "onlyNearby", "onlyOpen"];
  function savePrefs() {
    prefs.filters = Object.fromEntries(FILTER_IDS.map((id) => [id, $(id).type === "checkbox" ? $(id).checked : $(id).value]));
    prefs.radiusKm = S.radiusKm;
    saveJSON("sbr.prefs", prefs);
  }
  function restorePrefs() {
    for (const [id, v] of Object.entries(prefs.filters || {})) {
      const el = $(id); if (!el) continue;
      if (el.type === "checkbox") el.checked = !!v; else el.value = v;
    }
    if (prefs.radiusKm) { S.radiusKm = prefs.radiusKm; $("radius").value = S.radiusKm; $("radiusOut").textContent = S.radiusKm + " km"; }
  }

  $("btnLocate").addEventListener("click", locate);
  $("placeForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("placeInput").value.trim(); if (q) searchPlace(q); });
  $("radius").addEventListener("input", () => { S.radiusKm = +$("radius").value; $("radiusOut").textContent = S.radiusKm + " km"; });
  $("radius").addEventListener("change", () => { drawRadius(); loadStores(); });
  for (const id of FILTER_IDS) $(id).addEventListener(id === "q" || id === "maxPpl" || id === "minAbv" ? "input" : "change", () => { S.shown = PAGE; render(); });
  $("onlyOpen").addEventListener("change", () => { if (S.stores.length) refreshNearby(); });
  $("sort").addEventListener("change", () => { if ($("sort").value === "price") $("krent").showModal(); });
  $("krent").addEventListener("click", (e) => { if (e.target === $("krent")) $("krent").close(); });

  // Chupitos Utrecht (Loeff Berchmakerstraat 10): openingstijden uit OpenStreetMap
  const CHUPITOS_HOURS = "Tu-We 22:00-04:00; Th-Sa 22:00-05:00";
  function updateChupitos() {
    const h = Hours.status(CHUPITOS_HOURS);
    const el = $("chupitos");
    el.className = "badge " + (h.open ? "open" : "closed");
    el.textContent = h.open ? `🥃 Chupitos Utrecht is OPEN (tot ${h.until})` : `🥃 Chupitos Utrecht dicht · opent ${h.opens}`;
    el.title = "Openingstijden volgens OpenStreetMap: " + Hours.describe(CHUPITOS_HOURS);
  }
  updateChupitos();
  setInterval(() => { updateChupitos(); if (S.stores.length) { refreshNearby(); render(); } }, 60000);

  $("list").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.id === "more") { S.shown += PAGE; render(); return; }
    if (t.dataset.abv) {
      const b = S.data.beers.find((x) => x.id === t.dataset.abv);
      const cur = abvOf(b);
      const v = prompt(`Alcoholpercentage van ${b.name} (leeg = terug naar standaard):`, cur ?? "");
      if (v === null) return;
      const n = parseFloat(v.replace(",", "."));
      if (v.trim() === "" ) delete S.abvOverride[b.id];
      else if (n > 0 && n < 30) S.abvOverride[b.id] = n;
      else return alert("Vul een getal tussen 0 en 30 in.");
      saveJSON("sbr.abv", S.abvOverride);
      render();
      return;
    }
    if (t.dataset.rate) {
      const id = t.dataset.rate, v = +t.dataset.v;
      if (S.ratings[id] === v) delete S.ratings[id]; else S.ratings[id] = v;
      saveJSON("sbr.ratings", S.ratings);
      render();
    }
  });

  // ------------------------------------------------------------------ init
  async function init() {
    restorePrefs();
    try {
      const r = await fetch("data/beers.json", { cache: "no-cache" });
      S.data = await r.json();
    } catch (e) {
      $("list").innerHTML = `<div class="empty">Kon data/beers.json niet laden. Start de app via <code>./start.sh</code> (niet door het bestand direct te openen).</div>`;
      return;
    }
    try {  // vooraf opgehaalde winkellijst (scripts/build_stores.py); anders live via Overpass
      const r = await fetch("data/stores.json", { cache: "no-cache" });
      if (r.ok) {
        const j = await r.json();
        S.localStores = j.stores.map(([lat, lon, chain, name, addr, oh]) => ({ lat, lon, chain, name, addr, oh }));
      }
    } catch { /* geen lokale winkellijst */ }
    const styles = [...new Set(S.data.beers.map((b) => b.style))].sort((a, b) => a.localeCompare(b, "nl"));
    $("style").insertAdjacentHTML("beforeend", styles.map((s) => `<option>${esc(s)}</option>`).join(""));
    if (prefs.filters?.style) $("style").value = prefs.filters.style;
    const unitCount = {};
    for (const b of S.data.beers) for (const p of b.products) if (p.unit) { const u = Math.round(p.unit * 1000); unitCount[u] = (unitCount[u] || 0) + 1; }
    const units = Object.keys(unitCount).map(Number).filter((u) => unitCount[u] >= 5).sort((a, b) => a - b);
    $("unit").insertAdjacentHTML("beforeend", units.map((u) => `<option value="${u}">Per ${cl(u / 1000)}</option>`).join(""));
    if (prefs.filters?.unit) $("unit").value = prefs.filters.unit;
    const d = new Date(S.data.generated);
    $("dataDate").textContent = "Prijsdata opgehaald op " + d.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" }) + ".";
    if (!S.pos && prefs.pos) setPosition(prefs.pos.lat, prefs.pos.lon, prefs.pos.label || "Vorige locatie");
    render();
  }
  init();
})();
